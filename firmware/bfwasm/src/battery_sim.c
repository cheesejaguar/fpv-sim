/*
 * fpv-sim Betaflight WASM target: battery voltage / current sensing.
 * GPL-3.0-or-later. Replaces drivers/adc.c and pg/adc.c.
 *
 * The host's pack voltage and current are converted into the 12-bit ADC
 * counts a real FC would read through its divider / current sensor, using
 * the *live* vbat_scale, vbat_divider, vbat_multiplier, ibata_scale and
 * ibata_offset settings. Betaflight's own voltage.c / current.c / battery.c
 * then do the filtering, cell detection, sag compensation, warnings and mAh
 * integration exactly as on hardware (including 12-bit quantisation and
 * scale-calibration errors if the user changes the scale).
 *
 * bf_set_battery(volts, amps, mah_drawn): if mah_drawn >= 0 it overrides the
 * firmware's integrated mAh counter (keeps OSD/MSP consistent with the
 * host's battery model); pass a negative value to let Betaflight integrate.
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

#include "platform.h"

#include "common/maths.h"
#include "common/utils.h"

#include "drivers/adc.h"

#include "pg/adc.h"
#include "pg/pg.h"
#include "pg/pg_ids.h"

#include "sensors/adcinternal.h"
#include "sensors/current.h"
#include "sensors/voltage.h"

#include "wasm_internal.h"

extern currentMeterADCState_t currentMeterADCState;    // sensors/current.c

PG_REGISTER_WITH_RESET_FN(adcConfig_t, adcConfig, PG_ADC_CONFIG, 0);

void pgResetFn_adcConfig(adcConfig_t *adcConfig)
{
    memset(adcConfig, 0, sizeof(*adcConfig));
    adcConfig->device = ADC_DEV_TO_CFG(ADCDEV_1);
    adcConfig->vbat.enabled = true;
    adcConfig->current.enabled = true;
    for (int i = 0; i < ADCDEV_COUNT; i++) {
        adcConfig->dmaopt[i] = -1;
    }
}

void adcInit(const adcConfig_t *config)
{
    UNUSED(config);
}

static uint16_t clampAdc(float counts)
{
    if (!(counts > 0.0f)) {
        return 0;
    }
    return (uint16_t)MIN(lrintf(counts), 0xFFF);
}

static uint16_t vbatToAdc(float volts)
{
    // inverse of voltageAdcToVoltage() in sensors/voltage.c:
    // cV = src * scale * vref / 10 / (0xFFF * divval) / divmul
    const voltageSensorADCConfig_t *cfg = voltageSensorADCConfig(VOLTAGE_SENSOR_ADC_VBAT);
    if (!cfg->vbatscale || !cfg->vbatresdivval || !cfg->vbatresdivmultiplier) {
        return 0;
    }
    const float centivolts = volts * 100.0f;
    const float src = centivolts * 0xFFF * cfg->vbatresdivval * cfg->vbatresdivmultiplier * 10.0f
                      / ((float)cfg->vbatscale * getVrefMv());
    return clampAdc(src);
}

static uint16_t currentToAdc(float amps)
{
    // inverse of currentMeterADCToCentiamps() in sensors/current.c:
    // mV = src * vref / 4096 ; cA = (mV * 10000 / scale + offset[mA]) / 10
    const currentSensorADCConfig_t *cfg = currentSensorADCConfig();
    if (!cfg->scale) {
        return 0;
    }
    const float milliamps = amps * 1000.0f;
    const float millivolts = (milliamps - cfg->offset) * cfg->scale / 10000.0f;
    return clampAdc(millivolts * 4096.0f / getVrefMv());
}

uint16_t adcGetChannel(uint8_t channel)
{
    if (!bfwasmPersist.batteryValid) {
        return 0;
    }
    switch (channel) {
    case ADC_BATTERY:
        return vbatToAdc(bfwasmPersist.batteryVolts);
    case ADC_CURRENT:
        return currentToAdc(bfwasmPersist.batteryAmps);
    default:
        return 0;
    }
}

void bfwasmBatteryApply(void)
{
    if (!bfwasmPersist.batteryValid || bfwasmPersist.batteryMahDrawn < 0.0f) {
        return;
    }
    currentMeterADCState.mahDrawnState.mAhDrawnF = bfwasmPersist.batteryMahDrawn;
    currentMeterADCState.mahDrawnState.mAhDrawn = (int32_t)bfwasmPersist.batteryMahDrawn;
}
