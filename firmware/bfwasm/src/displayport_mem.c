/*
 * fpv-sim Betaflight WASM target: OSD character buffer display port.
 * GPL-3.0-or-later. Replaces io/displayport_max7456.c + drivers/max7456.c.
 *
 * Acts like a MAX7456 (the OSD device type stays "MAX7456" so the analog OSD
 * code path, CMS and font upload work unchanged), but renders into RAM:
 *
 *   working buffer  <- displayWrite()/writeChar()/clearScreen()
 *   published buffer = working buffer copied on every drawScreen(), and the
 *                      frame counter (bf_osd_frame) incremented.
 *
 * Canvas: vcd_video_system PAL/AUTO -> 30x16, NTSC -> 30x13,
 *         HD -> osd_canvas_width x osd_canvas_height (default 53x20).
 * The host reads bf_osd_chars()/bf_osd_attrs(): rows*cols bytes, row major,
 * stride == cols. chars are font indices for a Betaflight .mcm font,
 * attrs are Betaflight displayport attributes (severity bits, 0x80 = blink;
 * Betaflight does blinking itself because useDeviceBlink is false).
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "platform.h"

#include "common/utils.h"

#include "drivers/display.h"
#include "drivers/osd.h"

#include "io/displayport_max7456.h"

#include "osd/osd.h"

#include "pg/vcd.h"

#include "wasm_internal.h"

#define BLANK_CHAR 0x20

static displayPort_t memDisplayPort;

static uint8_t workChars[BFWASM_OSD_MAX_ROWS * BFWASM_OSD_MAX_COLS];
static uint8_t workAttrs[BFWASM_OSD_MAX_ROWS * BFWASM_OSD_MAX_COLS];
static uint8_t pubChars[BFWASM_OSD_MAX_ROWS * BFWASM_OSD_MAX_COLS];
static uint8_t pubAttrs[BFWASM_OSD_MAX_ROWS * BFWASM_OSD_MAX_COLS];
static uint8_t cols = 30;
static uint8_t rows = 16;
static uint32_t frameCount;
static displayPortBackground_e background;

static void clearWorking(void)
{
    memset(workChars, BLANK_CHAR, sizeof(workChars));
    memset(workAttrs, 0, sizeof(workAttrs));
}

static int grab(displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return 0;
}

static int release(displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return 0;
}

static int clearScreen(displayPort_t *displayPort, displayClearOption_e options)
{
    UNUSED(displayPort);
    UNUSED(options);
    clearWorking();
    return 0;
}

static bool drawScreen(displayPort_t *displayPort)
{
    UNUSED(displayPort);
    memcpy(pubChars, workChars, sizeof(pubChars));
    memcpy(pubAttrs, workAttrs, sizeof(pubAttrs));
    frameCount++;
    return false;   // nothing left to transfer
}

static int screenSize(const displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return rows * cols;
}

static int writeChar(displayPort_t *displayPort, uint8_t x, uint8_t y, uint8_t attr, uint8_t c)
{
    UNUSED(displayPort);
    if (x < cols && y < rows) {
        workChars[y * cols + x] = c;
        workAttrs[y * cols + x] = attr;
    }
    return 0;
}

static int writeString(displayPort_t *displayPort, uint8_t x, uint8_t y, uint8_t attr, const char *text)
{
    for (; *text && x < cols; text++, x++) {
        writeChar(displayPort, x, y, attr, (uint8_t)*text);
    }
    return 0;
}

static bool isTransferInProgress(const displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return false;
}

static bool isSynced(const displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return true;
}

static void redraw(displayPort_t *displayPort)
{
    UNUSED(displayPort);
}

static int heartbeat(displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return 0;
}

static uint32_t txBytesFree(const displayPort_t *displayPort)
{
    UNUSED(displayPort);
    return UINT32_MAX;
}

static bool layerSupported(displayPort_t *displayPort, displayPortLayer_e layer)
{
    UNUSED(displayPort);
    return layer == DISPLAYPORT_LAYER_FOREGROUND;
}

static bool layerSelect(displayPort_t *displayPort, displayPortLayer_e layer)
{
    UNUSED(displayPort);
    return layer == DISPLAYPORT_LAYER_FOREGROUND;
}

static bool layerCopy(displayPort_t *displayPort, displayPortLayer_e destLayer, displayPortLayer_e sourceLayer)
{
    UNUSED(displayPort);
    UNUSED(destLayer);
    UNUSED(sourceLayer);
    return false;
}

static bool writeFontCharacter(displayPort_t *displayPort, uint16_t addr, const osdCharacter_t *chr)
{
    UNUSED(displayPort);
    UNUSED(addr);
    UNUSED(chr);
    return true;    // the host owns the font
}

static bool checkReady(displayPort_t *displayPort, bool rescan)
{
    UNUSED(displayPort);
    UNUSED(rescan);
    return true;
}

static void setBackgroundType(displayPort_t *displayPort, displayPortBackground_e backgroundType)
{
    UNUSED(displayPort);
    background = backgroundType;
}

static const displayPortVTable_t memVTable = {
    .grab = grab,
    .release = release,
    .clearScreen = clearScreen,
    .drawScreen = drawScreen,
    .screenSize = screenSize,
    .writeString = writeString,
    .writeChar = writeChar,
    .isTransferInProgress = isTransferInProgress,
    .heartbeat = heartbeat,
    .redraw = redraw,
    .isSynced = isSynced,
    .txBytesFree = txBytesFree,
    .layerSupported = layerSupported,
    .layerSelect = layerSelect,
    .layerCopy = layerCopy,
    .writeFontCharacter = writeFontCharacter,
    .checkReady = checkReady,
    .setBackgroundType = setBackgroundType,
};

bool max7456DisplayPortInit(const vcdProfile_t *vcdProfile, displayPort_t **displayPort)
{
    switch (vcdProfile->video_system) {
    case VIDEO_SYSTEM_NTSC:
        cols = OSD_SD_COLS;
        rows = VIDEO_LINES_NTSC;
        break;
    case VIDEO_SYSTEM_HD:
        cols = osdConfig()->canvas_cols ? osdConfig()->canvas_cols : OSD_HD_COLS;
        rows = osdConfig()->canvas_rows ? osdConfig()->canvas_rows : OSD_HD_ROWS;
        break;
    case VIDEO_SYSTEM_PAL:
    case VIDEO_SYSTEM_AUTO:
    default:
        cols = OSD_SD_COLS;
        rows = VIDEO_LINES_PAL;
        break;
    }
    if (cols > BFWASM_OSD_MAX_COLS) {
        cols = BFWASM_OSD_MAX_COLS;
    }
    if (rows > BFWASM_OSD_MAX_ROWS) {
        rows = BFWASM_OSD_MAX_ROWS;
    }

    clearWorking();
    memset(pubChars, BLANK_CHAR, sizeof(pubChars));
    memset(pubAttrs, 0, sizeof(pubAttrs));

    displayInit(&memDisplayPort, &memVTable, DISPLAYPORT_DEVICE_TYPE_MAX7456);
    memDisplayPort.rows = rows;
    memDisplayPort.cols = cols;
    memDisplayPort.useDeviceBlink = false;

    *displayPort = &memDisplayPort;
    return true;
}

uint8_t *bfwasmOsdChars(void)
{
    return pubChars;
}

uint8_t *bfwasmOsdAttrs(void)
{
    return pubAttrs;
}

int bfwasmOsdCols(void)
{
    return cols;
}

int bfwasmOsdRows(void)
{
    return rows;
}

uint32_t bfwasmOsdFrame(void)
{
    return frameCount;
}
