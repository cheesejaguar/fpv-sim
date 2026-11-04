/*
   fpv-sim: a serial port whose other end is JavaScript (see SIM_JSPort.h).

   This program is free software: you can redistribute it and/or modify it under the terms of the
   GNU General Public License as published by the Free Software Foundation, either version 3 of
   the License, or (at your option) any later version.
 */
#include "SIM_JSPort.h"

#include <AP_Math/AP_Math.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>

// Module.fpvsim.portRead / portWrite: the JavaScript ends (src/ap/apHost.mjs in fpv-sim)
EM_JS(int, fpvsim_port_read, (int ch, char *buf, int max), {
    return Module['fpvsim'].portRead(ch, HEAPU8, buf, max);
});
EM_JS(int, fpvsim_port_write, (int ch, const char *buf, int len), {
    return Module['fpvsim'].portWrite(ch, HEAPU8, buf, len);
});

void SITL::JSPort::update()
{
    char buf[1024];
    // JavaScript -> autopilot, as much as the autopilot's buffer takes
    while (true) {
        const uint32_t space = to_autopilot->space();
        if (space == 0) {
            break;
        }
        const int n = fpvsim_port_read(channel, buf, int(MIN(space, uint32_t(sizeof(buf)))));
        if (n <= 0) {
            break;
        }
        write_to_autopilot(buf, n);
    }
    // autopilot -> JavaScript
    while (true) {
        const ssize_t n = read_from_autopilot(buf, sizeof(buf));
        if (n <= 0) {
            break;
        }
        fpvsim_port_write(channel, buf, int(n));
    }
}

#else

void SITL::JSPort::update() {}

#endif
