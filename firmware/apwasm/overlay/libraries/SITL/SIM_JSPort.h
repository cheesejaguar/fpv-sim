/*
   fpv-sim: a serial port whose other end is JavaScript (the WebAssembly build). SERIALn set to
   "sim:js:<channel>" moves the port's bytes to and from fpv-sim's ring buffers every simulation
   step: MAVLink to the app, the control API and ground stations.

   This program is free software: you can redistribute it and/or modify it under the terms of the
   GNU General Public License as published by the Free Software Foundation, either version 3 of
   the License, or (at your option) any later version.
 */
#pragma once

#include "SIM_SerialDevice.h"

namespace SITL {

class JSPort : public SerialDevice {
public:
    explicit JSPort(uint8_t ch) : SerialDevice(8192, 8192), channel(ch) {}

    // move the bytes waiting in each direction (called from the simulation step)
    void update();

private:
    uint8_t channel;
};

}
