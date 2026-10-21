/*
 * fpv-sim WASM target: shadows Betaflight's build/atomic.h.
 * GPL-3.0-or-later.
 *
 * The firmware runs single threaded with no interrupts, so BASEPRI critical
 * sections reduce to plain blocks that execute exactly once.
 */

#pragma once

#include <stdint.h>

#define ATOMIC_BLOCK(prio) for (uint8_t __ToDo = 1; __ToDo; __ToDo = 0)
#define ATOMIC_BLOCK_NB(prio) for (uint8_t __ToDo = 1; __ToDo; __ToDo = 0)

#define ATOMIC_BARRIER(data)
#define ATOMIC_BARRIER_ENTER(dataPtr, refStr)
#define ATOMIC_BARRIER_LEAVE(dataPtr, refStr)

#define ATOMIC_OR(ptr, val) __sync_fetch_and_or(ptr, val)
#define ATOMIC_AND(ptr, val) __sync_fetch_and_and(ptr, val)
