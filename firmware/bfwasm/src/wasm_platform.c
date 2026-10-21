/*
 * fpv-sim Betaflight WASM target: platform layer.
 *
 * Replaces src/main/target/SITL/sitl.c (GPL-3.0-or-later). No threads, no
 * sockets, no wall clock: time is a virtual microsecond counter that only
 * advances when the JS host calls bf_step() (or when firmware code calls
 * delay()/delayMicroseconds(), see below). 1 CPU cycle == 1 us.
 *
 * delay()/delayMicroseconds() never block. They advance the virtual clock
 * immediately (so code measuring time across the delay sees it elapse) and
 * add the same amount to a "sleep debt". bf_step() pays the debt off first
 * without running the scheduler, so firmware time and host physics time stay
 * aligned over the long run, and a long blocking delay (e.g. a blocking
 * DShot command) looks to the host like the FC stalling for that long.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "platform.h"

#include "common/maths.h"
#include "common/utils.h"

#include "drivers/io.h"
#include "drivers/light_led.h"
#include "drivers/system.h"
#include "drivers/time.h"
#include "drivers/pwm_output.h"

#include "wasm_internal.h"

uint32_t SystemCoreClock;

static uint64_t virtualMicros;      // the firmware's notion of "now"
static uint64_t sleepDebtUs;        // clock advanced by delay() not yet paid by bf_step()

uint64_t bfwasmClockNow(void)
{
    return virtualMicros;
}

void bfwasmClockAdvance(uint64_t us)
{
    virtualMicros += us;
}

uint64_t bfwasmSleepDebt(void)
{
    return sleepDebtUs;
}

uint64_t bfwasmPaySleepDebt(uint64_t us)
{
    const uint64_t paid = MIN(us, sleepDebtUs);
    sleepDebtUs -= paid;
    return paid;
}

void bfwasmClearSleepDebt(void)
{
    sleepDebtUs = 0;
}

int targetParseArgs(int argc, char * argv[])
{
    UNUSED(argc);
    UNUSED(argv);
    return 0;
}

// system
void systemInit(void)
{
    SystemCoreClock = 1000000; // 1 cycle == 1 us
}

void systemReset(void)
{
    // Cannot unwind the scheduler from here; flag it. bf_step() performs the
    // reboot (memory snapshot restore + init()) once the current task returns.
    bfwasmRequestReset();
}

void systemResetToBootloader(bootloaderRequestType_e requestType)
{
    UNUSED(requestType);
    bfwasmRequestReset();
}

bool isMPUSoftReset(void)
{
    return bfwasmIsSoftReset();
}

void timerInit(void)
{
}

void failureMode(failureMode_e mode)
{
    // Real hardware blinks forever / reboots. Report and keep going so the
    // host can inspect state; bf_init() returns this code.
    bfwasmSetFailure((int)mode + 1);
    fprintf(stderr, "[bf] failureMode %d\n", (int)mode);
}

void indicateFailure(failureMode_e mode, int repeatCount)
{
    UNUSED(repeatCount);
    fprintf(stderr, "[bf] indicateFailure %d\n", (int)mode);
}

// Time
uint64_t micros64(void)
{
    return virtualMicros;
}

uint64_t millis64(void)
{
    return virtualMicros / 1000;
}

uint32_t micros(void)
{
    return (uint32_t)(virtualMicros & 0xFFFFFFFF);
}

uint32_t microsISR(void)
{
    return micros();
}

uint32_t millis(void)
{
    return (uint32_t)(millis64() & 0xFFFFFFFF);
}

int32_t clockCyclesToMicros(int32_t clockCycles)
{
    return clockCycles;
}

float clockCyclesToMicrosf(int32_t clockCycles)
{
    return (float)clockCycles;
}

int32_t clockCyclesTo10thMicros(int32_t clockCycles)
{
    return clockCycles * 10;
}

int32_t clockCyclesTo100thMicros(int32_t clockCycles)
{
    return clockCycles * 100;
}

uint32_t clockMicrosToCycles(uint32_t micros)
{
    return micros;
}

uint32_t getCycleCounter(void)
{
    return (uint32_t)(virtualMicros & 0xFFFFFFFF);
}

void cycleCounterInit(void)
{
}

void delayMicroseconds(uint32_t us)
{
    virtualMicros += us;
    sleepDebtUs += us;
}

void delay(uint32_t ms)
{
    delayMicroseconds(ms * 1000);
}

// Servos are not simulated; keep the API so mixer/servo code links.
static pwmOutputPort_t servos[MAX_SUPPORTED_SERVOS];

void servoDevInit(const servoDevConfig_t *servoConfig)
{
    UNUSED(servoConfig);
    for (uint8_t servoIndex = 0; servoIndex < MAX_SUPPORTED_SERVOS; servoIndex++) {
        servos[servoIndex].enabled = true;
    }
}

void pwmWriteServo(uint8_t index, float value)
{
    UNUSED(index);
    UNUSED(value);
}

// stack part
char _estack;
char _Min_Stack_Size;

// Flash (unused with CONFIG_IN_RAM, kept for completeness)
void FLASH_Unlock(void)
{
}

void FLASH_Lock(void)
{
}

FLASH_Status FLASH_ErasePage(uintptr_t Page_Address)
{
    UNUSED(Page_Address);
    return FLASH_COMPLETE;
}

FLASH_Status FLASH_ProgramWord(uintptr_t addr, uint32_t value)
{
    UNUSED(addr);
    UNUSED(value);
    return FLASH_COMPLETE;
}

void IOConfigGPIO(IO_t io, ioConfig_t cfg)
{
    UNUSED(io);
    UNUSED(cfg);
}

void debugInit(void)
{
}

void unusedPinsInit(void)
{
}

void IOHi(IO_t io)
{
    UNUSED(io);
}

void IOLo(IO_t io)
{
    UNUSED(io);
}
