/*
 * fpv-sim Betaflight WASM target: buzzer output.
 * GPL-3.0-or-later. Replaces drivers/sound_beeper.c.
 *
 * Betaflight's beeper logic (io/beeper.c: sequences, priorities, the BEEPER
 * switch, RX-loss / low-battery / arming beeps, beeper_off_flags) runs
 * unchanged; it ends in systemBeep(on), which on hardware drives a GPIO or a
 * PWM timer. Here it latches the pin state for the host (bf_get_beeper).
 */

#include <stdbool.h>
#include <stdint.h>

#include "platform.h"

#include "common/utils.h"

#include "drivers/sound_beeper.h"

#include "wasm_internal.h"

static bool beeperPin;

void systemBeep(bool onoff)
{
    beeperPin = onoff;
}

void systemBeepToggle(void)
{
    beeperPin = !beeperPin;
}

void beeperInit(const struct beeperDevConfig_s *config)
{
    UNUSED(config);
    beeperPin = false;
}

bool bfwasmBeeperOn(void)
{
    return beeperPin;
}
