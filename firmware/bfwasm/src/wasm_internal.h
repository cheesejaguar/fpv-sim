/*
 * fpv-sim Betaflight WASM target: internal glue between replacement sources.
 * GPL-3.0-or-later.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#define BFWASM_SERIAL_PORTS     8
#define BFWASM_SERIAL_RX_SIZE   4096
#define BFWASM_SERIAL_TX_SIZE   65536
#define BFWASM_MOTORS           8
#define BFWASM_RC_CHANNELS      16

// OSD canvas limits (HD 53x20 is the largest Betaflight 4.5 canvas)
#define BFWASM_OSD_MAX_COLS     60
#define BFWASM_OSD_MAX_ROWS     22

typedef struct bfwasmByteRing_s {
    uint32_t head;      // write index
    uint32_t tail;      // read index
} bfwasmByteRing_t;

// Everything the host has handed to the firmware, plus the host-facing serial
// queues. This block survives a firmware reboot (systemReset) untouched,
// unlike all other static data which is restored to its power-on snapshot.
typedef struct bfwasmPersist_s {
    // sensors (raw, already converted to sensor counts)
    int16_t gyroCounts[3];
    int16_t accCounts[3];
    bool imuValid;

    float baroPa;
    bool baroValid;

    float batteryVolts;
    float batteryAmps;
    float batteryMahDrawn;
    bool batteryValid;

    float erpm[BFWASM_MOTORS];

    uint16_t rc[BFWASM_RC_CHANNELS];
    bool rcValid;

    // serial: host -> FC (rx) and FC -> host (tx)
    bfwasmByteRing_t rxRing[BFWASM_SERIAL_PORTS];
    bfwasmByteRing_t txRing[BFWASM_SERIAL_PORTS];
    uint8_t rxBuf[BFWASM_SERIAL_PORTS][BFWASM_SERIAL_RX_SIZE];
    uint8_t txBuf[BFWASM_SERIAL_PORTS][BFWASM_SERIAL_TX_SIZE];

    // lifecycle
    bool softReset;         // next init() is a soft reboot (isMPUSoftReset)
    bool eepromProvided;    // host loaded eepromData before bf_init
    uint32_t bootCount;
    uint32_t eepromHash;    // for bf_eeprom_dirty()
} bfwasmPersist_t;

extern bfwasmPersist_t bfwasmPersist;

// wasm_platform.c
uint64_t bfwasmClockNow(void);
void bfwasmClockAdvance(uint64_t us);
uint64_t bfwasmSleepDebt(void);
uint64_t bfwasmPaySleepDebt(uint64_t us);
void bfwasmClearSleepDebt(void);

// wasm_api.c
void bfwasmRequestReset(void);
bool bfwasmIsSoftReset(void);
void bfwasmSetFailure(int code);

// serial_mem.c
void bfwasmSerialPump(void);        // host rx queue -> open UART rx buffers
void bfwasmSerialDebug(void);

// rx_sim.c
void bfwasmRxApply(void);           // (re)install the RC provider into rxRuntimeState
void bfwasmRxNewFrame(void);
void bfwasmRxDebug(void);

// motor_sim.c
int bfwasmMotorGet(uint16_t *out, int count);
bool bfwasmMotorReversed(void);

// battery_sim.c
void bfwasmBatteryApply(void);

// displayport_mem.c
uint8_t *bfwasmOsdChars(void);
uint8_t *bfwasmOsdAttrs(void);
int bfwasmOsdCols(void);
int bfwasmOsdRows(void);
uint32_t bfwasmOsdFrame(void);
