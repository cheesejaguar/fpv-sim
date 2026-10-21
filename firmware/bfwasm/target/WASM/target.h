/*
 * This file is part of the fpv-sim Betaflight WebAssembly target.
 *
 * Derived from Betaflight src/main/target/SITL/target.h (GPL-3.0-or-later).
 *
 * Betaflight is free software. You can redistribute this software and/or
 * modify this software under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * WASM: lock-stepped simulator target. Single threaded, no sockets. The JS
 * host advances a virtual microsecond clock with bf_step() and exchanges
 * sensor / RC / motor / serial / OSD data through the C API in wasm_api.c.
 *
 * Compiled with -DSITL -DSIMULATOR_BUILD -DWASM_BUILD. "SITL" keeps
 * common_pre.h from enabling the full hardware driver catalogue; every
 * feature this target wants is enabled explicitly below.
 */

#pragma once

#include <stdint.h>
#include <stddef.h>

#include "common/utils.h"

#define TARGET_BOARD_IDENTIFIER "WASM"
#define USBD_PRODUCT_STRING     "Betaflight WASM"

#define SYSTEM_HSE_MHZ 0
#define DEFAULT_CPU_OVERCLOCK 1
#define DMA_RAM
#define DMA_RW_AXI
#define DMA_RAM_R
#define DMA_RAM_W
#define DMA_RAM_RW

#define DMA_DATA_ZERO_INIT
#define DMA_DATA
#define STATIC_DMA_DATA_AUTO

// Real attitude estimation (Mahony AHRS) from the virtual gyro/acc.
// SITL undefines USE_IMU_CALC and injects the simulator attitude; we don't.
#ifndef USE_IMU_CALC
#define USE_IMU_CALC
#endif

// Config lives in the eepromData[] RAM buffer, exposed to JS (bf_eeprom_ptr).
#define CONFIG_IN_RAM
#define EEPROM_SIZE     32768

// Like an F7/H7: 8 kHz gyro + PID loop
#define TASK_GYROPID_DESIRED_PERIOD     125 // 125us = 8kHz
#define SCHEDULER_DELAY_LIMIT           10

#define U_ID_0 0
#define U_ID_1 1
#define U_ID_2 2

#define USE_VIRTUAL_LED

#define USE_ACC
#define USE_VIRTUAL_ACC

#define USE_GYRO
#define USE_VIRTUAL_GYRO

#undef USE_MAG

#define USE_BARO
#define USE_VIRTUAL_BARO

#define USABLE_TIMER_CHANNEL_COUNT 0

#define USE_UART1
#define USE_UART2
#define USE_UART3
#define USE_UART4
#define USE_UART5
#define USE_UART6
#define USE_UART7
#define USE_UART8

#define SERIAL_PORT_COUNT 8

#define DEFAULT_RX_FEATURE      FEATURE_RX_MSP
#define DEFAULT_FEATURES        (FEATURE_OSD)

#define USE_PARAMETER_GROUPS

#ifndef USE_PWM_OUTPUT
#define USE_PWM_OUTPUT
#endif

// ---- Motor output: DShot with bidirectional (eRPM) telemetry -------------
#define USE_DSHOT
#define USE_DSHOT_TELEMETRY
#define USE_RPM_FILTER
#define USE_DYN_IDLE
#define USE_RPM_LIMIT
#undef  USE_DSHOT_BITBANG
#undef  USE_DSHOT_TELEMETRY_STATS

// ---- Filtering ------------------------------------------------------------
// common_post.h disables this for SIMULATOR_BUILD (stale arm_math comment);
// patched to keep it for WASM_BUILD. 4.5 uses the portable SDFT.
#define USE_DYN_NOTCH_FILTER

// ---- OSD (analog-style char buffer, plus HD canvas) ------------------------
#define USE_OSD
#define USE_OSD_SD
#define USE_OSD_HD
#define USE_OSD_STICK_OVERLAY
#define USE_OSD_QUICK_MENU
#define USE_SPEC_PREARM_SCREEN
#define USE_RC_STATS
#define USE_CMS
#define USE_MAX7456   // displayport_mem.c implements max7456DisplayPortInit()

// ---- Battery: emulated 12-bit ADC fed from JS -----------------------------
#define USE_ADC
#define ADC_VOLTAGE_REFERENCE_MV 3300
#define DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC
#define DEFAULT_CURRENT_METER_SOURCE CURRENT_METER_ADC
#define USE_BATTERY_CONTINUE

#undef USE_STACK_CHECK
#undef USE_DASHBOARD
#undef USE_TELEMETRY_LTM
#undef USE_VCP
#undef USE_RX_PPM
#undef USE_RX_PWM
#undef USE_SERIALRX
#undef USE_SERIALRX_CRSF
// LQ / RSSI dBm are reported by the simulator (bf_set_link_stats); keep Betaflight's RSSI dBm support
#define USE_SIM_RX_LINK_STATS
#undef USE_SERIALRX_GHST
#undef USE_SERIALRX_IBUS
#undef USE_SERIALRX_SBUS
#undef USE_SERIALRX_SPEKTRUM
#undef USE_SERIALRX_SUMD
#undef USE_SERIALRX_SUMH
#undef USE_SERIALRX_XBUS
#undef USE_LED_STRIP
#undef USE_TELEMETRY_FRSKY_HUB
#undef USE_TELEMETRY_HOTT
#undef USE_TELEMETRY_SMARTPORT
#undef USE_TELEMETRY_MAVLINK
#undef USE_RESOURCE_MGMT
#undef USE_TELEMETRY_CRSF
#undef USE_TELEMETRY_GHST
#undef USE_TELEMETRY_IBUS
#undef USE_TELEMETRY_JETIEXBUS
#undef USE_TELEMETRY_SRXL
#undef USE_SERIALRX_JETIEXBUS
#undef USE_VTX_COMMON
#undef USE_VTX_CONTROL
#undef USE_VTX_SMARTAUDIO
#undef USE_VTX_TRAMP
#undef USE_VTX_MSP
#undef USE_CAMERA_CONTROL
#undef USE_SERIAL_4WAY_BLHELI_BOOTLOADER
#undef USE_SERIAL_4WAY_SK_BOOTLOADER
#undef USE_GYRO_REGISTER_DUMP
#undef USE_SERIAL_PASSTHROUGH

#undef USE_I2C
#undef USE_SPI

#define TARGET_FLASH_SIZE 2048

#define LED_STRIP_TIMER 1
#define SOFTSERIAL_1_TIMER 2
#define SOFTSERIAL_2_TIMER 3

#define DEFIO_NO_PORTS   // suppress 'no pins defined' warning

#define FLASH_PAGE_SIZE (0x400)

// belows are internal stuff (dummy hardware types so generic code compiles)

extern uint32_t SystemCoreClock;

typedef enum
{
    Mode_TEST = 0x0,
    Mode_Out_PP = 0x10
} GPIO_Mode;

typedef enum {RESET = 0, SET = !RESET} FlagStatus, ITStatus;
typedef enum {DISABLE = 0, ENABLE = !DISABLE} FunctionalState;
typedef enum {TEST_IRQ = 0 } IRQn_Type;
typedef enum {
    EXTI_Trigger_Rising = 0x08,
    EXTI_Trigger_Falling = 0x0C,
    EXTI_Trigger_Rising_Falling = 0x10
} EXTITrigger_TypeDef;

typedef struct
{
  uint32_t IDR;
  uint32_t ODR;
  uint32_t BSRR;
  uint32_t BRR;
} GPIO_TypeDef;

#define GPIOA_BASE ((intptr_t)0x0001)

typedef struct
{
    void* test;
} TIM_TypeDef;

typedef struct
{
    void* test;
} TIM_OCInitTypeDef;

typedef struct
{
    void* test;
} TIM_ICInitTypeDef;

typedef struct {
    void* test;
} DMA_TypeDef;

typedef struct {
    void* test;
} DMA_Channel_TypeDef;

typedef struct {
    void* test;
} DMA_InitTypeDef;

uint8_t DMA_GetFlagStatus(void *);
void DMA_Cmd(DMA_Channel_TypeDef*, FunctionalState );
void DMA_ClearFlag(uint32_t);

typedef struct
{
    void* test;
} SPI_TypeDef;

typedef struct
{
    void* test;
} USART_TypeDef;

typedef struct
{
    void* test;
} ADC_TypeDef;

#define USART1 ((USART_TypeDef *)0x0001)
#define USART2 ((USART_TypeDef *)0x0002)
#define USART3 ((USART_TypeDef *)0x0003)
#define USART4 ((USART_TypeDef *)0x0004)
#define USART5 ((USART_TypeDef *)0x0005)
#define USART6 ((USART_TypeDef *)0x0006)
#define USART7 ((USART_TypeDef *)0x0007)
#define USART8 ((USART_TypeDef *)0x0008)

#define UART4 ((USART_TypeDef *)0x0004)
#define UART5 ((USART_TypeDef *)0x0005)
#define UART7 ((USART_TypeDef *)0x0007)
#define UART8 ((USART_TypeDef *)0x0008)

#define SIMULATOR_MAX_RC_CHANNELS   16
#define SIMULATOR_MAX_PWM_CHANNELS  16

typedef struct
{
    void* test;
} I2C_TypeDef;

typedef enum
{
  FLASH_BUSY = 1,
  FLASH_ERROR_PG,
  FLASH_ERROR_WRP,
  FLASH_COMPLETE,
  FLASH_TIMEOUT
} FLASH_Status;

void FLASH_Unlock(void);
void FLASH_Lock(void);
FLASH_Status FLASH_ErasePage(uintptr_t Page_Address);
FLASH_Status FLASH_ProgramWord(uintptr_t addr, uint32_t Data);

uint64_t micros64(void);
uint64_t millis64(void);

// main.c (excluded) calls targetParseArgs() for SIMULATOR_BUILD
int targetParseArgs(int argc, char * argv[]);
