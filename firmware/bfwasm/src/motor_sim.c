/*
 * fpv-sim Betaflight WASM target: DShot ESC emulation.
 * GPL-3.0-or-later. Replaces drivers/dshot_dpwm.c + pwm_output_dshot*.c and
 * the PWM half of target/SITL/sitl.c.
 *
 * Output side: every motor update latches the 11-bit DShot value per motor,
 * exactly as it would go on the wire (0 = stop, 1..47 commands,
 * 48..2047 throttle), including Betaflight's own DShot command scheduling
 * (beacons, spin direction, ...). bf_get_motors() reports throttle values;
 * command frames read as 0 (an ESC doesn't drive the motor on a command).
 * Spin direction commands are tracked for crash flip ("turtle mode").
 *
 * Telemetry side: the host supplies eRPM per motor (bf_set_erpm). On every
 * decodeTelemetry() it is encoded exactly like a bidirectional DShot ESC
 * would (eRPM period in us, 'eee mmmmmmmmm' exponent/mantissa) and handed to
 * Betaflight's own decoder in drivers/dshot.c, so RPM filter / dynamic idle /
 * rpm limit see the same quantisation as on real hardware.
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

#include "platform.h"

#include "common/maths.h"
#include "common/utils.h"

#include "drivers/dshot.h"
#include "drivers/dshot_command.h"
#include "drivers/dshot_dpwm.h"
#include "drivers/motor.h"
#include "drivers/pwm_output.h"
#include "drivers/time.h"

#include "wasm_internal.h"

FAST_DATA_ZERO_INIT pwmOutputPort_t motors[MAX_SUPPORTED_MOTORS];
FAST_DATA_ZERO_INIT bool useDshotTelemetry = false;
FAST_DATA_ZERO_INIT loadDmaBufferFn *loadDmaBuffer;

static motorDmaOutput_t dmaMotors[MAX_SUPPORTED_MOTORS];
static motorDevice_t dshotSimDevice;

static uint16_t pendingValue[MAX_SUPPORTED_MOTORS];   // written this loop
static uint16_t wireValue[MAX_SUPPORTED_MOTORS];      // last frame "sent"
static bool motorReversed;

motorDmaOutput_t *getMotorDmaOutput(uint8_t index)
{
    return &dmaMotors[index];
}

pwmOutputPort_t *pwmGetMotors(void)
{
    return motors;
}

bool pwmIsMotorEnabled(uint8_t index)
{
    return motors[index].enabled;
}

uint32_t getDshotHz(motorPwmProtocolTypes_e pwmProtocolType)
{
    switch (pwmProtocolType) {
    case PWM_TYPE_PROSHOT1000:
        return MOTOR_PROSHOT1000_HZ;
    case PWM_TYPE_DSHOT600:
        return MOTOR_DSHOT600_HZ;
    case PWM_TYPE_DSHOT300:
        return MOTOR_DSHOT300_HZ;
    default:
    case PWM_TYPE_DSHOT150:
        return MOTOR_DSHOT150_HZ;
    }
}

// Encode an eRPM value the way an ESC does for bidirectional DShot:
// period (us per electrical revolution) as 3-bit exponent + 9-bit mantissa.
static uint16_t encodeErpmTelemetry(float erpm)
{
    if (!(erpm > 0.0f)) {
        return 0x0fff;  // motor stopped
    }
    const float periodUsF = 60000000.0f / erpm;
    if (periodUsF >= 65408.0f) {
        return 0x0fff;  // slower than representable -> "stopped"
    }
    uint32_t period = (uint32_t)lrintf(periodUsF);
    if (period == 0) {
        period = 1;
    }
    uint32_t exponent = 0;
    while (period > 0x1ff && exponent < 7) {
        period = (period + 1) >> 1;
        exponent++;
    }
    if (period > 0x1ff) {
        period = 0x1ff;
    }
    return (uint16_t)((exponent << 9) | period);
}

static bool simDecodeTelemetry(void)
{
    if (!useDshotTelemetry) {
        return true;
    }

    for (int i = 0; i < dshotSimDevice.count && i < MAX_SUPPORTED_MOTORS; i++) {
        // The ESC only answers frames that requested telemetry (all of them
        // with bidir DShot). Erpm index follows motor output order.
        const float erpm = i < BFWASM_MOTORS ? bfwasmPersist.erpm[i] : 0.0f;
        dshotTelemetryState.readCount++;
        dshotTelemetryState.motorState[i].rawValue = encodeErpmTelemetry(erpm);
    }
    dshotTelemetryState.rawValueState = DSHOT_RAW_VALUE_STATE_NOT_PROCESSED;
    return true;
}

static void simShutdown(void)
{
    memset(wireValue, 0, sizeof(wireValue));
}

static void simDisableMotors(void)
{
}

static bool simEnableMotors(void)
{
    return true;
}

static bool simIsMotorEnabled(uint8_t index)
{
    return motors[index].enabled;
}

static void simWriteInt(uint8_t index, uint16_t value)
{
    if (index >= MAX_SUPPORTED_MOTORS) {
        return;
    }
    // A queued DShot command replaces the throttle value (as on hardware)
    if (dshotCommandIsProcessing()) {
        value = dshotCommandGetCurrent(index);
        if (value) {
            dmaMotors[index].protocolControl.requestTelemetry = true;
        }
    }
    dmaMotors[index].protocolControl.value = value;
    pendingValue[index] = value;
}

static void simWrite(uint8_t index, float value)
{
    simWriteInt(index, (uint16_t)constrain(lrintf(value), 0, 2047));
}

static void simUpdateComplete(void)
{
    // Keep command timing exactly as the real DMA driver does
    if (!dshotCommandQueueEmpty()) {
        if (!dshotCommandOutputIsEnabled(dshotSimDevice.count)) {
            return;
        }
    }

    for (int i = 0; i < dshotSimDevice.count && i < MAX_SUPPORTED_MOTORS; i++) {
        const uint16_t v = pendingValue[i];
        wireValue[i] = v;
        if (v == DSHOT_CMD_SPIN_DIRECTION_REVERSED) {
            motorReversed = true;
        } else if (v == DSHOT_CMD_SPIN_DIRECTION_NORMAL) {
            motorReversed = false;
        }
    }
}

static const motorVTable_t dshotSimVTable = {
    .postInit = motorPostInitNull,
    .enable = simEnableMotors,
    .disable = simDisableMotors,
    .isMotorEnabled = simIsMotorEnabled,
    .decodeTelemetry = simDecodeTelemetry,
    .write = simWrite,
    .writeInt = simWriteInt,
    .updateComplete = simUpdateComplete,
    .convertExternalToMotor = dshotConvertFromExternal,
    .convertMotorToExternal = dshotConvertToExternal,
    .shutdown = simShutdown,
};

motorDevice_t *dshotPwmDevInit(const motorDevConfig_t *motorConfig, uint16_t idlePulse, uint8_t motorCount, bool useUnsyncedPwm)
{
    UNUSED(idlePulse);
    UNUSED(useUnsyncedPwm);

    dshotSimDevice.vTable = dshotSimVTable;
#ifdef USE_DSHOT_TELEMETRY
    useDshotTelemetry = motorConfig->useDshotTelemetry;
#endif

    memset(pendingValue, 0, sizeof(pendingValue));
    memset(wireValue, 0, sizeof(wireValue));
    memset(dmaMotors, 0, sizeof(dmaMotors));

    for (int i = 0; i < MAX_SUPPORTED_MOTORS && i < motorCount; i++) {
        motors[i].enabled = true;
        dmaMotors[i].configured = true;
        dmaMotors[i].index = i;
        dmaMotors[i].protocolControl.requestTelemetry = useDshotTelemetry;
    }

    return &dshotSimDevice;
}

// Analog protocols (PWM / OneShot / MultiShot): map the pulse width onto the
// DShot throttle range so the host sees one unit regardless of protocol.
static motorDevice_t pwmSimDevice;
static uint16_t pwmIdlePulse;

static float pwmConvertFromExternal(uint16_t externalValue)
{
    return (float)externalValue;
}

static uint16_t pwmConvertToExternal(float motorValue)
{
    return (uint16_t)motorValue;
}

static void pwmSimWrite(uint8_t index, float value)
{
    if (index >= MAX_SUPPORTED_MOTORS) {
        return;
    }
    // 1000us..2000us -> 48..2047 (<= 1000us -> 0)
    const float t = (value - 1000.0f) / 1000.0f;
    pendingValue[index] = (t <= 0.0f) ? 0 : (uint16_t)constrain(lrintf(48 + t * 1999.0f), 48, 2047);
}

static void pwmSimWriteInt(uint8_t index, uint16_t value)
{
    pwmSimWrite(index, (float)value);
}

static void pwmSimUpdateComplete(void)
{
    memcpy(wireValue, pendingValue, sizeof(wireValue));
}

static const motorVTable_t pwmSimVTable = {
    .postInit = motorPostInitNull,
    .enable = simEnableMotors,
    .disable = simDisableMotors,
    .isMotorEnabled = simIsMotorEnabled,
    .decodeTelemetry = motorDecodeTelemetryNull,
    .write = pwmSimWrite,
    .writeInt = pwmSimWriteInt,
    .updateComplete = pwmSimUpdateComplete,
    .convertExternalToMotor = pwmConvertFromExternal,
    .convertMotorToExternal = pwmConvertToExternal,
    .shutdown = simShutdown,
};

motorDevice_t *motorPwmDevInit(const motorDevConfig_t *motorConfig, uint16_t idlePulse, uint8_t motorCount, bool useUnsyncedPwm)
{
    UNUSED(motorConfig);
    UNUSED(useUnsyncedPwm);

    pwmIdlePulse = idlePulse;
    UNUSED(pwmIdlePulse);
    pwmSimDevice.vTable = pwmSimVTable;
    memset(pendingValue, 0, sizeof(pendingValue));
    memset(wireValue, 0, sizeof(wireValue));
    for (int i = 0; i < MAX_SUPPORTED_MOTORS && i < motorCount; i++) {
        motors[i].enabled = true;
    }
    return &pwmSimDevice;
}

int bfwasmMotorGet(uint16_t *out, int count)
{
    for (int i = 0; i < count; i++) {
        uint16_t v = i < MAX_SUPPORTED_MOTORS ? wireValue[i] : 0;
        if (v < DSHOT_MIN_THROTTLE) {
            v = 0;  // stop or a command frame
        }
        out[i] = v;
    }
    return count;
}

bool bfwasmMotorReversed(void)
{
    return motorReversed;
}
