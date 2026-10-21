# Betaflight 4.5.5 -> WebAssembly (fpv-sim WASM target).
# GPL-3.0-or-later.
#
# Normally driven by scripts/build-firmware.sh inside the emscripten/emsdk
# Docker image. Variables:
#   BF      patched copy of the Betaflight tree   (default ../build/betaflight)
#   OBJ     object directory                      (default ../build/obj)
#   OUT     output directory for betaflight.mjs/.wasm (default ../../public/bf)
#   JOBS    passed by the caller via make -j

BFWASM  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
BF      ?= $(abspath $(BFWASM)/../build/betaflight)
OBJ     ?= $(abspath $(BFWASM)/../build/obj)
OUT     ?= $(abspath $(BFWASM)/../../public/bf)

CC      := emcc

# ---------------------------------------------------------------------------
# Source list: reuse Betaflight's own mk/source.mk with the SITL settings
# ---------------------------------------------------------------------------
ROOT            := $(BF)
SRC_DIR         := $(ROOT)/src/main
SIMULATOR_BUILD := yes
TARGET          := WASM
TARGET_DIR      := $(BFWASM)/target/WASM
TARGET_DIR_SRC  :=
STARTUP_SRC     :=
MCU_COMMON_SRC  :=
VARIANT_SRC     :=
include $(TARGET_DIR)/target.mk

include $(ROOT)/mk/source.mk

BF_SRC := $(sort $(SRC))

WASM_SRC := \
            $(BFWASM)/src/wasm_api.c \
            $(BFWASM)/src/wasm_platform.c \
            $(BFWASM)/src/wasm_malloc.c \
            $(BFWASM)/src/serial_mem.c \
            $(BFWASM)/src/displayport_mem.c \
            $(BFWASM)/src/battery_sim.c \
            $(BFWASM)/src/motor_sim.c \
            $(BFWASM)/src/rx_sim.c \
            $(BFWASM)/src/wasm_stubs.c

# Object names mirror the source path, so flight/rpm_filter.c and
# pg/rpm_filter.c (same basename) never collide.
src_path = $(if $(filter /%,$(1)),$(1),$(SRC_DIR)/$(1))
obj_name = $(OBJ)/$(patsubst $(ROOT)/%,bf/%,$(patsubst $(BFWASM)/%,bfwasm/%,$(basename $(call src_path,$(1))))).o

BF_OBJS   := $(foreach s,$(BF_SRC),$(call obj_name,$(s)))
WASM_OBJS := $(foreach s,$(WASM_SRC),$(call obj_name,$(s)))
OBJS      := $(BF_OBJS) $(WASM_OBJS)

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
REVISION ?= 4.5.5

INCLUDES := \
            -I$(BFWASM)/include \
            -I$(TARGET_DIR) \
            -I$(BFWASM)/src \
            -I$(SRC_DIR) \
            -I$(SRC_DIR)/target \
            -I$(SRC_DIR)/startup \
            -I$(ROOT)/lib/main/MAVLink \
            -I$(ROOT)/lib/main/google/olc

DEFINES := \
            -DWASM -DSITL -DSIMULATOR_BUILD -DWASM_BUILD \
            -D_GNU_SOURCE -DUSE_STDPERIPH_DRIVER \
            -DTARGET_FLASH_SIZE=2048 -DHSE_VALUE=8000000 \
            -D'__FORKNAME__="betaflight"' \
            -D'__TARGET__="WASM"' \
            -D'__REVISION__="$(REVISION)"'

# Deterministic float maths: no fast-math, no FMA contraction (results must
# not depend on the JS engine / CPU).
OPT := -O2 -fno-fast-math -ffp-contract=off

# ARM EABI fidelity: char is unsigned and enums are as small as possible on
# arm-none-eabi; Betaflight relies on both (e.g. uint8_t* into enum fields).
ABI := -funsigned-char -fshort-enums

CFLAGS := $(OPT) $(ABI) -std=gnu17 \
            -ffunction-sections -fdata-sections -fno-common \
            -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare \
            -Wno-missing-field-initializers -Wno-unknown-pragmas \
            -Wno-gnu-variable-sized-type-not-at-end \
            -Wno-unused-but-set-variable -Wno-unused-const-variable \
            -Wno-pointer-to-int-cast -Wno-int-to-pointer-cast \
            -Wno-address-of-packed-member \
            -Werror=implicit-function-declaration \
            -Werror=incompatible-pointer-types \
            -Werror=int-conversion \
            -Werror=return-type \
            $(DEFINES) $(INCLUDES)

EXPORTED_FUNCTIONS := \
            _bf_init,_bf_step,_bf_set_gyro_acc,_bf_set_rc,_bf_set_battery, \
            _bf_set_erpm,_bf_set_baro,_bf_get_motors,_bf_get_motor_reversed, \
            _bf_serial_write,_bf_serial_read, \
            _bf_osd_chars,_bf_osd_attrs,_bf_osd_cols,_bf_osd_rows,_bf_osd_frame, \
            _bf_eeprom_ptr,_bf_eeprom_size,_bf_eeprom_loaded,_bf_eeprom_dirty, \
            _bf_arming_disable_flags,_bf_get_flight_mode_flags, \
            _bf_get_attitude,_bf_get_debug, \
            _bf_micros,_bf_boot_count,_bf_gyro_period_us,_bf_debug_dump, \
            _malloc,_free

LDFLAGS := $(OPT) \
            --no-entry --profiling-funcs \
            -Wl,--gc-sections \
            -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBetaflight \
            -sENVIRONMENT=web,worker,node \
            -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
            -sSTACK_SIZE=1048576 \
            -sMALLOC=none \
            -sFILESYSTEM=0 \
            -sEXIT_RUNTIME=0 \
            -sEXPORTED_FUNCTIONS=$(subst $(eval) ,,$(EXPORTED_FUNCTIONS)) \
            -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP8,HEAPU16,HEAP16,HEAPU32,HEAP32,HEAPF32,HEAPF64,cwrap,ccall

# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
# flags / target changes must rebuild everything (ABI flags change struct layout)
BUILD_DEPS := $(BFWASM)/Makefile $(TARGET_DIR)/target.mk

.PHONY: all clean print-src

all: $(OUT)/betaflight.mjs

$(OUT)/betaflight.mjs: $(OBJS) $(BFWASM)/Makefile
	@mkdir -p $(OUT)
	@echo "  LD $(notdir $@)"
	@$(CC) $(OBJS) $(LDFLAGS) -o $@
	@ls -l $(OUT)/betaflight.mjs $(OUT)/betaflight.wasm

$(OBJ)/bf/%.o: $(ROOT)/%.c $(BUILD_DEPS)
	@mkdir -p $(dir $@)
	@echo "  CC $(patsubst $(ROOT)/%,%,$<)"
	@$(CC) -c $(CFLAGS) -MMD -MP -o $@ $<

$(OBJ)/bfwasm/%.o: $(BFWASM)/%.c $(BUILD_DEPS)
	@mkdir -p $(dir $@)
	@echo "  CC bfwasm/$*.c"
	@$(CC) -c $(CFLAGS) -MMD -MP -o $@ $<

print-src:
	@echo $(BF_SRC) $(WASM_SRC)

clean:
	rm -rf $(OBJ)

-include $(OBJS:.o=.d)
