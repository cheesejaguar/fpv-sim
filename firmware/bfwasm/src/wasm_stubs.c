/*
 * fpv-sim Betaflight WASM target: stubs for hardware-only symbols that
 * generic code still references.
 * GPL-3.0-or-later.
 */

#include <stdbool.h>
#include <stdint.h>

#include "platform.h"

#include "common/utils.h"

#include "drivers/bus_spi.h"
#include "drivers/dshot_dpwm.h"
#include "drivers/pwm_output_dshot_shared.h"

#include "io/serial.h"

// `dshot_telemetry_info` prints these DMA IRQ timings; there is no DMA.
FAST_DATA_ZERO_INIT dshotDMAHandlerCycleCounters_t dshotDMAHandlerCycleCounters;

// No SPI bus: the (memory) OSD device does not need one.
SPIDevice spiDeviceByInstance(SPI_TypeDef *instance)
{
    UNUSED(instance);
    return SPIINVALID;
}

// MSP/CLI serial passthrough (ESC flashing, VTX config, ...) would turn the
// FC into a blocking byte pump forever. Not meaningful in the simulator.
void serialPassthrough(serialPort_t *left, serialPort_t *right, serialConsumer *leftC, serialConsumer *rightC)
{
    UNUSED(left);
    UNUSED(right);
    UNUSED(leftC);
    UNUSED(rightC);
}
