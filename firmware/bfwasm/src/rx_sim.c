/*
 * fpv-sim Betaflight WASM target: RC receiver fed from the host.
 * GPL-3.0-or-later.
 *
 * Mirrors SITL's UDP RC provider: 16 channels in microseconds (1000..2000).
 * Each bf_set_rc() call is one received RC frame: the frame status function
 * reports RX_FRAME_COMPLETE exactly once per bf_set_rc(), and the frame time
 * reported to rc smoothing / feedforward is the virtual time of that call.
 * If the host stops calling bf_set_rc(), Betaflight's own failsafe kicks in.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "platform.h"

#include "common/utils.h"

#include "drivers/time.h"

#include "rx/rx.h"

#include "fc/tasks.h"
#include "scheduler/scheduler.h"

#include "wasm_internal.h"

static bool framePending;
static uint32_t frameStatusCalls;
static timeUs_t frameTimeUs;

static float readRawRC(const rxRuntimeState_t *rxRuntimeState, uint8_t channel)
{
    UNUSED(rxRuntimeState);
    if (channel >= BFWASM_RC_CHANNELS) {
        return 0;
    }
    return bfwasmPersist.rc[channel];
}

static uint8_t frameStatus(rxRuntimeState_t *rxRuntimeState)
{
    UNUSED(rxRuntimeState);
    frameStatusCalls++;
    if (framePending) {
        framePending = false;
        return RX_FRAME_COMPLETE;
    }
    return RX_FRAME_PENDING;
}

static timeUs_t frameTimeFn(void)
{
    return frameTimeUs;
}

void bfwasmRxApply(void)
{
    if (!bfwasmPersist.rcValid) {
        return;
    }
    rxRuntimeState.channelCount = BFWASM_RC_CHANNELS;
    rxRuntimeState.rcReadRawFn = readRawRC;
    rxRuntimeState.rcFrameStatusFn = frameStatus;
    rxRuntimeState.rcFrameTimeUsFn = frameTimeFn;
    rxRuntimeState.rxProvider = RX_PROVIDER_UDP;
}

void bfwasmRxNewFrame(void)
{
    bfwasmRxApply();
    frameTimeUs = micros();
    rxRuntimeState.lastRcFrameTimeUs = frameTimeUs;
    framePending = true;
}

void bfwasmRxDebug(void)
{
    printf("[bf]  rx provider=%d ours=%d chans=%d pending=%d frameT=%u signal=%d\n",
        (int)rxRuntimeState.rxProvider, rxRuntimeState.rcFrameStatusFn == frameStatus,
        (int)rxRuntimeState.channelCount, framePending, (unsigned)frameTimeUs, rxIsReceivingSignal());
    const task_t *t = getTask(TASK_RX);
    printf("[bf]  rxtask statusCalls=%u inProgress=%d dynPrio=%u age=%u lastExec=%u lastSig=%u anticip=%u\n",
        (unsigned)frameStatusCalls, taskUpdateRxMainInProgress(), t->dynamicPriority, t->taskAgePeriods,
        (unsigned)t->lastExecutedAtUs, (unsigned)t->lastSignaledAtUs, (unsigned)t->anticipatedExecutionTime);
}
