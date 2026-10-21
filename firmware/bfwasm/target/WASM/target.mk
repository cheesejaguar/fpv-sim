# fpv-sim WASM target (Betaflight 4.5 layout, derived from target/SITL).
# Included by firmware/bfwasm/Makefile.

TARGET_MCU        := SITL
TARGET_MCU_FAMILY := SITL
SIMULATOR_BUILD    = yes

TARGET_SRC = \
            drivers/accgyro/accgyro_virtual.c \
            drivers/barometer/barometer_virtual.c

# mk/mcu/SITL.mk excludes, plus the upstream files that the replacement
# sources in firmware/bfwasm/src provide:
#   main.c                      -> wasm_api.c (bf_init / bf_step)
#   drivers/dshot_dpwm.c        -> motor_sim.c (DShot + bidir telemetry)
#   drivers/max7456.c,
#   io/displayport_max7456.c    -> displayport_mem.c (OSD char buffer)
#   drivers/adc.c, pg/adc.c     -> battery_sim.c (emulated ADC)
#   drivers/serial_tcp.c        -> serial_mem.c (never in the list: SITL adds it via TARGET_SRC)
#   target/SITL/sitl.c          -> wasm_platform.c
#   drivers/sound_beeper.c      -> beeper_sim.c (buzzer pin state for the host)
MCU_EXCLUDES = \
            drivers/adc.c \
            drivers/bus_i2c.c \
            drivers/bus_i2c_config.c \
            drivers/bus_spi.c \
            drivers/bus_spi_config.c \
            drivers/bus_spi_pinconfig.c \
            drivers/dma.c \
            drivers/pwm_output.c \
            drivers/timer.c \
            drivers/system.c \
            drivers/rcc.c \
            drivers/serial_escserial.c \
            drivers/serial_pinconfig.c \
            drivers/serial_uart.c \
            drivers/serial_uart_init.c \
            drivers/serial_uart_pinconfig.c \
            drivers/rx/rx_xn297.c \
            drivers/display_ug2864hsweg01.c \
            telemetry/crsf.c \
            telemetry/ghst.c \
            telemetry/srxl.c \
            io/displayport_oled.c \
            main.c \
            drivers/dshot_dpwm.c \
            drivers/max7456.c \
            io/displayport_max7456.c \
            pg/adc.c \
            drivers/sound_beeper.c
