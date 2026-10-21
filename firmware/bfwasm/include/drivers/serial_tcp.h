/*
 * fpv-sim WASM target: shadows Betaflight's drivers/serial_tcp.h.
 *
 * io/serial.c opens every UART through serTcpOpen() when SIMULATOR_BUILD is
 * defined. The WASM target implements serTcpOpen() in serial_mem.c with
 * in-memory ring buffers instead of dyad TCP sockets, so this header only
 * keeps the prototype (no netinet/pthread/dyad dependencies).
 *
 * GPL-3.0-or-later, see Betaflight LICENSE.
 */

#pragma once

#include "drivers/serial.h"

serialPort_t *serTcpOpen(int id, serialReceiveCallbackPtr rxCallback, void *rxCallbackData, uint32_t baudRate, portMode_e mode, portOptions_e options);
