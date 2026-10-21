/*
 * fpv-sim Betaflight WASM target: emulated task execution time (CPU load).
 * GPL-3.0-or-later.
 *
 * Virtual time stands still while a task runs, so every task would measure
 * 0 us and Betaflight's CPU load would read 0 %. The scheduler patch (0009)
 * charges each task run the average execution time it has on an STM32F722
 * at 216 MHz with Betaflight 4.5 (`tasks` output, 8 kHz gyro / 8 kHz PID,
 * RPM filter + dynamic notch on). The cost only feeds the load statistics
 * (`status`, `tasks`, MSP, OSD), never the scheduler's timing decisions, so
 * flight behaviour is unchanged. 8k/8k reads ~30-35 %, a 3.2 kHz BMI270
 * build ~15 %, like real F7 boards.
 */

#include <stdint.h>

#include "platform.h"

#include "scheduler/scheduler.h"

#include "wasm_internal.h"

uint32_t bfwasmTaskCostUs(int taskId)
{
    switch ((taskId_e)taskId) {
    case TASK_SYSTEM:           return 1;
    case TASK_MAIN:             return 1;
    case TASK_GYRO:             return 7;
    case TASK_FILTER:           return 14;
    case TASK_PID:              return 20;
    case TASK_ACCEL:            return 5;
    case TASK_ATTITUDE:         return 22;
    case TASK_RX:               return 21;
    case TASK_SERIAL:           return 3;
    case TASK_DISPATCH:         return 1;
    case TASK_BATTERY_VOLTAGE:  return 2;
    case TASK_BATTERY_CURRENT:  return 1;
    case TASK_BATTERY_ALERTS:   return 3;
#ifdef USE_BEEPER
    case TASK_BEEPER:           return 1;
#endif
#ifdef USE_GPS
    case TASK_GPS:              return 8;
#endif
#ifdef USE_GPS_RESCUE
    case TASK_GPS_RESCUE:       return 6;
#endif
#ifdef USE_BARO
    case TASK_BARO:             return 10;
#endif
#if defined(USE_BARO) || defined(USE_GPS)
    case TASK_ALTITUDE:         return 4;
#endif
#ifdef USE_OSD
    case TASK_OSD:              return 10;  // one slice of the OSD state machine
#endif
#ifdef USE_CMS
    case TASK_CMS:              return 30;
#endif
    default:                    return 2;
    }
}
