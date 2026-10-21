/*
 * fpv-sim Betaflight WASM target: host (JS) API and lock-step driver.
 * GPL-3.0-or-later.
 *
 * Axis / unit conventions of the host API (see firmware/README.md):
 *
 *   bf_set_gyro_acc(gx, gy, gz, ax, ay, az)
 *     Body frame FRD (x forward, y right, z down), right-handed rotations.
 *     gx = p  roll rate,  +  = right wing down        [rad/s]
 *     gy = q  pitch rate, +  = nose up                [rad/s]
 *     gz = r  yaw rate,   +  = nose right (CW from above) [rad/s]
 *     ax, ay, az = specific force (what an accelerometer measures,
 *     i.e. kinematic acceleration minus gravity) in FRD [m/s^2].
 *     Level and at rest: (0, 0, -9.80665).
 *
 *   Betaflight's own sensor frame is FLU (x forward, y left, z up); the
 *   conversion here is   gyroBF = ( p, -q, -r) * (180/pi) * 16.384 LSB/dps
 *                        accBF  = (ax, -ay, -az) * 256 / 9.80665
 *   16.384 = 32768/2000 matches GYRO_SCALE_2000DPS used by the virtual gyro
 *   driver exactly, acc_1G = 256. Both saturate at int16 like a real
 *   +-2000 dps / +-16 g IMU (gyro clips at 2000 dps, acc at 128 g).
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include <emscripten/emscripten.h>

#include "platform.h"

#include "build/debug.h"

#include "common/maths.h"
#include "common/utils.h"

#include "config/config.h"
#include "config/config_eeprom.h"

#include "drivers/accgyro/accgyro.h"
#include "drivers/accgyro/accgyro_virtual.h"
#include "drivers/barometer/barometer_virtual.h"
#include "drivers/time.h"

#include "fc/init.h"
#include "fc/runtime_config.h"
#include "fc/tasks.h"

#include "flight/imu.h"

#include "scheduler/scheduler.h"

#include "sensors/gyro.h"

#include "wasm_internal.h"

#define BF_GYRO_LSB_PER_DPS   (32768.0f / 2000.0f)
#define BF_ACC_LSB_PER_MS2    (256.0f / 9.80665f)
#define BF_RAD2DEG            (180.0f / 3.14159265358979323846f)

// Max scheduler() calls per gyro slice. Each call runs at most one non
// realtime task, time is frozen within a slice, so this bounds work when
// many tasks are due at once (e.g. right after boot).
#define BF_MAX_SCHEDULER_CALLS_PER_SLICE 24

extern uint32_t schedulerExecutedTaskCount;   // scheduler patch

bfwasmPersist_t bfwasmPersist;

static bool resetRequested;
static int failureCode;
static bool initialised;

// Power-on snapshot of all static data (.data + .bss), used to emulate a
// reboot: Betaflight is full of function/file statics that assume a fresh
// RAM image on every boot.
extern char __global_base;
extern char __data_end;
static uint8_t *ramSnapshot;
static size_t ramSnapshotSize;

void bfwasmRequestReset(void)
{
    resetRequested = true;
}

bool bfwasmIsSoftReset(void)
{
    return bfwasmPersist.softReset;
}

void bfwasmSetFailure(int code)
{
    if (!failureCode) {
        failureCode = code;
    }
}

static uint32_t fnv1a(const uint8_t *p, size_t n)
{
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; i++) {
        h = (h ^ p[i]) * 16777619u;
    }
    return h;
}

static void applySensors(void)
{
    if (virtualGyroDev) {
        virtualGyroSet(virtualGyroDev, bfwasmPersist.gyroCounts[0], bfwasmPersist.gyroCounts[1], bfwasmPersist.gyroCounts[2]);
    }
    if (virtualAccDev) {
        virtualAccSet(virtualAccDev, bfwasmPersist.accCounts[0], bfwasmPersist.accCounts[1], bfwasmPersist.accCounts[2]);
    }
}

static void bootFirmware(void)
{
    failureCode = 0;
    resetRequested = false;
    bfwasmPersist.bootCount++;

    init();

    // Boot-time delay()s advanced the clock; the host's physics clock starts
    // from here, so don't make bf_step() pay for the boot.
    bfwasmClearSleepDebt();

    bfwasmRxApply();
    bfwasmBatteryApply();
    applySensors();
    if (bfwasmPersist.baroValid) {
        virtualBaroSet((int32_t)lrintf(bfwasmPersist.baroPa), 2500);
    }

    initialised = true;
}

static void rebootFirmware(bool soft)
{
    // Keep host-facing state and the EEPROM image; everything else goes back
    // to the power-on RAM image, exactly like an MCU reset.
    static bfwasmPersist_t *persistCopy;
    static uint8_t *eepromCopy;
    if (!persistCopy) {
        persistCopy = malloc(sizeof(bfwasmPersist_t));
        eepromCopy = malloc(sizeof(eepromData));
    }
    bfwasmPersist_t *const pc = persistCopy;
    uint8_t *const ec = eepromCopy;

    memcpy(pc, &bfwasmPersist, sizeof(bfwasmPersist_t));
    memcpy(ec, eepromData, sizeof(eepromData));

    memcpy(&__global_base, ramSnapshot, ramSnapshotSize);

    // the statics (persistCopy/eepromCopy/ramSnapshot) were restored too;
    // re-point them at the still-valid heap blocks
    persistCopy = pc;
    eepromCopy = ec;

    memcpy(&bfwasmPersist, pc, sizeof(bfwasmPersist_t));
    memcpy(eepromData, ec, sizeof(eepromData));

    bfwasmPersist.softReset = soft;
    if (!soft && !bfwasmPersist.eepromProvided) {
        memset(eepromData, 0, sizeof(eepromData));
    }
    if (!soft) {
        bfwasmPersist.eepromHash = fnv1a(eepromData, sizeof(eepromData));
    }

    bootFirmware();
}

EMSCRIPTEN_KEEPALIVE int bf_init(void)
{
    if (!ramSnapshot) {
        ramSnapshotSize = (size_t)(&__data_end - &__global_base);
        ramSnapshot = malloc(ramSnapshotSize);
        // capture with ramSnapshot already set so a restore keeps it
        memcpy(ramSnapshot, &__global_base, ramSnapshotSize);
    } else {
        // bf_init() again: power cycle. The EEPROM image is kept only if the
        // host marked it as loaded (bf_eeprom_loaded(1)).
        rebootFirmware(false);
        return failureCode;
    }

    if (!bfwasmPersist.eepromProvided) {
        memset(eepromData, 0, sizeof(eepromData));
    }
    bfwasmPersist.softReset = false;
    // baseline for bf_eeprom_dirty(): the image the host provided (or blank)
    bfwasmPersist.eepromHash = fnv1a(eepromData, sizeof(eepromData));

    bootFirmware();

    return failureCode;
}

static uint32_t gyroSlicePeriodUs(void)
{
    const uint32_t period = gyro.sampleLooptime;
    return period ? period : 125;
}

static void runSchedulerAtCurrentTime(void)
{
    for (int i = 0; i < BF_MAX_SCHEDULER_CALLS_PER_SLICE; i++) {
        const uint32_t before = schedulerExecutedTaskCount;
        scheduler();
        if (resetRequested) {
            return;
        }
        if (bfwasmSleepDebt()) {
            // a task blocked (delay); the clock moved on, stop this slice
            return;
        }
        if (schedulerExecutedTaskCount == before) {
            return;
        }
    }
}

EMSCRIPTEN_KEEPALIVE void bf_step(uint32_t dt_us)
{
    if (!initialised) {
        return;
    }

    uint64_t remaining = dt_us;

    while (remaining > 0) {
        // Time already spent inside delay()/blocking calls: the FC is busy.
        remaining -= bfwasmPaySleepDebt(remaining);
        if (remaining == 0) {
            break;
        }

        const uint64_t slice = MIN(remaining, (uint64_t)gyroSlicePeriodUs());
        bfwasmClockAdvance(slice);
        remaining -= slice;

        // a new IMU sample is available every gyro period
        applySensors();
        bfwasmSerialPump();

        runSchedulerAtCurrentTime();

        if (resetRequested) {
            // systemReset(): CLI save/exit, MSP reboot, ...; EEPROM image kept
            bfwasmPersist.eepromProvided = true;
            rebootFirmware(true);
        }
    }
}

static int16_t toCounts(float v)
{
    if (!(v == v)) {    // NaN
        return 0;
    }
    return (int16_t)constrainf(lrintf(v), -32767, 32767);
}

EMSCRIPTEN_KEEPALIVE void bf_set_gyro_acc(float gx, float gy, float gz, float ax, float ay, float az)
{
    const float g = BF_RAD2DEG * BF_GYRO_LSB_PER_DPS;
    bfwasmPersist.gyroCounts[0] = toCounts(gx * g);
    bfwasmPersist.gyroCounts[1] = toCounts(-gy * g);
    bfwasmPersist.gyroCounts[2] = toCounts(-gz * g);

    bfwasmPersist.accCounts[0] = toCounts(ax * BF_ACC_LSB_PER_MS2);
    bfwasmPersist.accCounts[1] = toCounts(-ay * BF_ACC_LSB_PER_MS2);
    bfwasmPersist.accCounts[2] = toCounts(-az * BF_ACC_LSB_PER_MS2);
    bfwasmPersist.imuValid = true;

    if (initialised) {
        applySensors();
    }
}

EMSCRIPTEN_KEEPALIVE void bf_set_rc(const uint16_t *ch16)
{
    for (int i = 0; i < BFWASM_RC_CHANNELS; i++) {
        bfwasmPersist.rc[i] = ch16[i];
    }
    bfwasmPersist.rcValid = true;
    if (initialised) {
        bfwasmRxNewFrame();
    }
}

EMSCRIPTEN_KEEPALIVE void bf_set_battery(float volts, float amps, float mah_drawn)
{
    bfwasmPersist.batteryVolts = volts;
    bfwasmPersist.batteryAmps = amps;
    bfwasmPersist.batteryMahDrawn = mah_drawn;
    bfwasmPersist.batteryValid = true;
    if (initialised) {
        bfwasmBatteryApply();
    }
}

EMSCRIPTEN_KEEPALIVE void bf_set_erpm(const float *erpm4)
{
    for (int i = 0; i < 4; i++) {
        bfwasmPersist.erpm[i] = erpm4[i];
    }
}

EMSCRIPTEN_KEEPALIVE void bf_set_baro(float pascal)
{
    bfwasmPersist.baroPa = pascal;
    bfwasmPersist.baroValid = true;
    virtualBaroSet((int32_t)lrintf(pascal), 2500);
}

EMSCRIPTEN_KEEPALIVE int bf_get_motors(uint16_t *out4)
{
    bfwasmMotorGet(out4, 4);
    return ARMING_FLAG(ARMED) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int bf_get_motor_reversed(void)
{
    return bfwasmMotorReversed() ? 1 : 0;
}

// ---- serial (host side of the in-memory UARTs; UART1 is port 0) -----------

static uint32_t ringUsed(const bfwasmByteRing_t *r, uint32_t size)
{
    return (r->head + size - r->tail) % size;
}

EMSCRIPTEN_KEEPALIVE int bf_serial_write(int port, const uint8_t *buf, int len)
{
    if (port < 0 || port >= BFWASM_SERIAL_PORTS || len <= 0) {
        return 0;
    }
    bfwasmByteRing_t *r = &bfwasmPersist.rxRing[port];
    uint8_t *data = bfwasmPersist.rxBuf[port];
    const uint32_t size = BFWASM_SERIAL_RX_SIZE;
    int written = 0;
    while (written < len && ringUsed(r, size) < size - 1) {
        data[r->head] = buf[written++];
        r->head = (r->head + 1) % size;
    }
    if (initialised) {
        bfwasmSerialPump();
    }
    return written;
}

EMSCRIPTEN_KEEPALIVE int bf_serial_read(int port, uint8_t *buf, int maxlen)
{
    if (port < 0 || port >= BFWASM_SERIAL_PORTS || maxlen <= 0) {
        return 0;
    }
    bfwasmByteRing_t *r = &bfwasmPersist.txRing[port];
    const uint8_t *data = bfwasmPersist.txBuf[port];
    const uint32_t size = BFWASM_SERIAL_TX_SIZE;
    int n = 0;
    while (n < maxlen && r->tail != r->head) {
        buf[n++] = data[r->tail];
        r->tail = (r->tail + 1) % size;
    }
    return n;
}

// ---- OSD -----------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE uint8_t *bf_osd_chars(void)
{
    return bfwasmOsdChars();
}

EMSCRIPTEN_KEEPALIVE uint8_t *bf_osd_attrs(void)
{
    return bfwasmOsdAttrs();
}

EMSCRIPTEN_KEEPALIVE int bf_osd_cols(void)
{
    return bfwasmOsdCols();
}

EMSCRIPTEN_KEEPALIVE int bf_osd_rows(void)
{
    return bfwasmOsdRows();
}

EMSCRIPTEN_KEEPALIVE uint32_t bf_osd_frame(void)
{
    return bfwasmOsdFrame();
}

// ---- EEPROM ----------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE uint8_t *bf_eeprom_ptr(void)
{
    return eepromData;
}

EMSCRIPTEN_KEEPALIVE int bf_eeprom_size(void)
{
    return (int)sizeof(eepromData);
}

EMSCRIPTEN_KEEPALIVE void bf_eeprom_loaded(int loaded)
{
    bfwasmPersist.eepromProvided = loaded != 0;
}

// 1 if the EEPROM image changed (config saved) since the last call.
EMSCRIPTEN_KEEPALIVE int bf_eeprom_dirty(void)
{
    const uint32_t h = fnv1a(eepromData, sizeof(eepromData));
    if (h != bfwasmPersist.eepromHash) {
        bfwasmPersist.eepromHash = h;
        return 1;
    }
    return 0;
}

// ---- state -----------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE uint32_t bf_arming_disable_flags(void)
{
    return (uint32_t)getArmingDisableFlags();
}

EMSCRIPTEN_KEEPALIVE int bf_get_flight_mode_flags(void)
{
    return (int)flightModeFlags;
}

// Betaflight's attitude estimate (degrees): roll + = right wing down,
// pitch + = nose up, yaw = heading 0..360 (+ clockwise from above).
EMSCRIPTEN_KEEPALIVE void bf_get_attitude(float *rpy_deg)
{
    rpy_deg[0] = attitude.values.roll / 10.0f;
    rpy_deg[1] = -attitude.values.pitch / 10.0f;
    rpy_deg[2] = attitude.values.yaw / 10.0f;
}

EMSCRIPTEN_KEEPALIVE void bf_get_debug(int16_t *out8)
{
    for (int i = 0; i < 8; i++) {
        out8[i] = i < DEBUG16_VALUE_COUNT ? debug[i] : 0;
    }
}

// Extra helpers (not part of the core contract, useful for tooling)
EMSCRIPTEN_KEEPALIVE uint32_t bf_micros(void)
{
    return micros();
}

EMSCRIPTEN_KEEPALIVE uint32_t bf_boot_count(void)
{
    return bfwasmPersist.bootCount;
}

EMSCRIPTEN_KEEPALIVE uint32_t bf_gyro_period_us(void)
{
    return gyroSlicePeriodUs();
}

// Diagnostic dump to stdout: PG registry, scheduler tasks.
EMSCRIPTEN_KEEPALIVE void bf_debug_dump(void)
{
    printf("[bf] boot=%u t=%uus pg_registry=%d tasksRun=%u failure=%d ram=%u\n",
        (unsigned)bfwasmPersist.bootCount, (unsigned)micros(), (int)PG_REGISTRY_SIZE,
        (unsigned)schedulerExecutedTaskCount, failureCode, (unsigned)ramSnapshotSize);
    for (int i = 0; i < TASK_COUNT; i++) {
        taskInfo_t info;
        getTaskInfo(i, &info);
        if (info.isEnabled) {
            printf("[bf]  task %-12s period=%6dus avgDelta=%6.1fus\n", info.taskName,
                (int)info.desiredPeriodUs, info.movingAverageCycleTimeUs);
        }
    }
    bfwasmSerialDebug();
    bfwasmRxDebug();
}
