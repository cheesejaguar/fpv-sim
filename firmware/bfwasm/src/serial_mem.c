/*
 * fpv-sim Betaflight WASM target: in-memory UARTs.
 * GPL-3.0-or-later. Replaces drivers/serial_tcp.c (dyad sockets).
 *
 * io/serial.c opens UARTn through serTcpOpen(n - 1, ...) in SIMULATOR_BUILD.
 * Host -> FC bytes are queued by bf_serial_write() in bfwasmPersist.rxRing and
 * pumped into the port's rx buffer once per gyro slice (and on write).
 * FC -> host bytes go straight into bfwasmPersist.txRing, read by
 * bf_serial_read(). Both host-side queues survive a firmware reboot.
 *
 * UART1 (port 0) carries MSP + CLI with the default serial config.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "platform.h"

#include "common/utils.h"

#include "drivers/serial.h"
#include "drivers/serial_tcp.h"

#include "io/serial.h"

#include "wasm_internal.h"

#define PORT_RX_BUFFER_SIZE 2048

typedef struct memPort_s {
    serialPort_t port;
    uint8_t rxBuffer[PORT_RX_BUFFER_SIZE];
    uint8_t txBuffer[4];    // unused: tx goes straight to the host ring
    uint8_t id;
    bool open;
} memPort_t;

static memPort_t memPorts[BFWASM_SERIAL_PORTS];
static const struct serialPortVTable memVTable;

static uint32_t memTotalRxBytesWaiting(const serialPort_t *instance)
{
    const serialPort_t *p = instance;
    if (p->rxBufferHead >= p->rxBufferTail) {
        return p->rxBufferHead - p->rxBufferTail;
    }
    return p->rxBufferSize + p->rxBufferHead - p->rxBufferTail;
}

static uint32_t memTotalTxBytesFree(const serialPort_t *instance)
{
    const memPort_t *s = (const memPort_t *)instance;
    const bfwasmByteRing_t *r = &bfwasmPersist.txRing[s->id];
    const uint32_t used = (r->head + BFWASM_SERIAL_TX_SIZE - r->tail) % BFWASM_SERIAL_TX_SIZE;
    return (BFWASM_SERIAL_TX_SIZE - 1) - used;
}

static bool isMemTransmitBufferEmpty(const serialPort_t *instance)
{
    UNUSED(instance);
    return true;    // "transmitted" as soon as it is queued for the host
}

static uint8_t memRead(serialPort_t *instance)
{
    serialPort_t *p = instance;
    const uint8_t ch = p->rxBuffer[p->rxBufferTail];
    p->rxBufferTail = (p->rxBufferTail + 1) % p->rxBufferSize;
    return ch;
}

static void memWrite(serialPort_t *instance, uint8_t ch)
{
    memPort_t *s = (memPort_t *)instance;
    bfwasmByteRing_t *r = &bfwasmPersist.txRing[s->id];
    bfwasmPersist.txBuf[s->id][r->head] = ch;
    r->head = (r->head + 1) % BFWASM_SERIAL_TX_SIZE;
    if (r->head == r->tail) {
        // host isn't draining: drop the oldest byte
        r->tail = (r->tail + 1) % BFWASM_SERIAL_TX_SIZE;
    }
}

static void memWriteBuf(serialPort_t *instance, const void *data, int count)
{
    const uint8_t *p = data;
    while (count--) {
        memWrite(instance, *p++);
    }
}

static void memSetBaudRate(serialPort_t *instance, uint32_t baudRate)
{
    instance->baudRate = baudRate;
}

static void memSetMode(serialPort_t *instance, portMode_e mode)
{
    instance->mode = mode;
}

static const struct serialPortVTable memVTable = {
    .serialWrite = memWrite,
    .serialTotalRxWaiting = memTotalRxBytesWaiting,
    .serialTotalTxFree = memTotalTxBytesFree,
    .serialRead = memRead,
    .serialSetBaudRate = memSetBaudRate,
    .isSerialTransmitBufferEmpty = isMemTransmitBufferEmpty,
    .setMode = memSetMode,
    .setCtrlLineStateCb = NULL,
    .setBaudRateCb = NULL,
    .writeBuf = memWriteBuf,
    .beginWrite = NULL,
    .endWrite = NULL,
};

serialPort_t *serTcpOpen(int id, serialReceiveCallbackPtr rxCallback, void *rxCallbackData, uint32_t baudRate, portMode_e mode, portOptions_e options)
{
    if (id < 0 || id >= BFWASM_SERIAL_PORTS) {
        return NULL;
    }

    memPort_t *s = &memPorts[id];
    memset(s, 0, sizeof(*s));
    s->id = id;
    s->open = true;

    s->port.vTable = &memVTable;
    s->port.rxBufferHead = s->port.rxBufferTail = 0;
    s->port.txBufferHead = s->port.txBufferTail = 0;
    s->port.rxBufferSize = PORT_RX_BUFFER_SIZE;
    s->port.txBufferSize = sizeof(s->txBuffer);
    s->port.rxBuffer = s->rxBuffer;
    s->port.txBuffer = s->txBuffer;
    s->port.rxCallback = rxCallback;
    s->port.rxCallbackData = rxCallbackData;
    s->port.mode = mode;
    s->port.baudRate = baudRate;
    s->port.options = options;

    return &s->port;
}

void bfwasmSerialPump(void)
{
    for (int id = 0; id < BFWASM_SERIAL_PORTS; id++) {
        memPort_t *s = &memPorts[id];
        bfwasmByteRing_t *r = &bfwasmPersist.rxRing[id];
        if (!s->open) {
            continue;   // keep queued until the firmware opens the port
        }
        serialPort_t *p = &s->port;
        while (r->tail != r->head) {
            const uint32_t nextHead = (p->rxBufferHead + 1) % p->rxBufferSize;
            if (nextHead == p->rxBufferTail && !p->rxCallback) {
                break;  // firmware rx buffer full; retry next slice
            }
            const uint8_t ch = bfwasmPersist.rxBuf[id][r->tail];
            r->tail = (r->tail + 1) % BFWASM_SERIAL_RX_SIZE;
            if (p->rxCallback) {
                // interrupt-style receivers consume bytes in the callback
                p->rxCallback(ch, p->rxCallbackData);
            } else {
                p->rxBuffer[p->rxBufferHead] = ch;
                p->rxBufferHead = nextHead;
            }
        }
    }
}

void bfwasmSerialDebug(void)
{
    for (int id = 0; id < BFWASM_SERIAL_PORTS; id++) {
        const memPort_t *s = &memPorts[id];
        printf("[bf]  uart%d open=%d rxq=%u/%u portrx=%u/%u txq=%u/%u\n", id + 1, s->open,
            (unsigned)bfwasmPersist.rxRing[id].head, (unsigned)bfwasmPersist.rxRing[id].tail,
            (unsigned)s->port.rxBufferHead, (unsigned)s->port.rxBufferTail,
            (unsigned)bfwasmPersist.txRing[id].head, (unsigned)bfwasmPersist.txRing[id].tail);
    }
}
