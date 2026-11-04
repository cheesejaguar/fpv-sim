# ArduPilot 4.7.2 → WebAssembly

The simulator runs the real ArduPlane and ArduCopter 4.7.2, compiled to WebAssembly with
Emscripten. Their SITL hardware layer is kept; the physics plugs into SITL's JSON backend through
shared memory instead of UDP. See [docs/ARDUPILOT.md](../../docs/ARDUPILOT.md) for how the
simulator uses it.

```
firmware/
  ardupilot/        the pinned upstream clone (Plane-4.7.2 = Copter-4.7.2, fb77356…): reset and
                    patched by the build (gitignored)
  apwasm/
    build.sh        clone, patch, Python venv, Emscripten SDK, configure, build, copy to public/ap/
    patches/ardupilot-wasm.patch   the upstream changes (one diff)
    overlay/        new files copied into the tree (the wasm board, the JavaScript serial port)
  build/            emsdk, the venv, waf's output (gitignored)
public/ap/ardu{plane,copter}.{mjs,wasm}   the build output (an ES module factory and its wasm)
scripts/ap-smoke.mjs                      boots one in Node and listens to its MAVLink
```

## Build

```bash
bash firmware/apwasm/build.sh            # configure once, build both
bash firmware/apwasm/build.sh plane      # ArduPlane only (or: copter)
bash firmware/apwasm/build.sh clean      # forget the configure step and the objects
node scripts/ap-smoke.mjs plane 25       # boot it at rest and print what it says
```

It needs git, Python 3.9+ and network access the first time. The script fetches:

- the pinned ArduPilot commit and the submodules the build needs: waf, mavlink, littlefs and
  DroneCAN's code generators;
- the Python packages for waf's generators, into a venv;
- the Emscripten SDK 4.0.10, the same compiler as the Betaflight build.

A full build takes several minutes; after a change only the touched files recompile. Whenever the
patch or the overlay changes, the script resets the tree to the pinned commit and applies them
again. To change the patch, edit `firmware/ardupilot` and regenerate it:
`git -C firmware/ardupilot diff > firmware/apwasm/patches/ardupilot-wasm.patch`.

## The board: `wasm`

`overlay/libraries/AP_HAL_SITL/hwdef/wasm/hwdef.dat` is SITL's board with:

- `env WASM 1`;
- no CAN interfaces;
- no networking;
- the JSON backend without its UDP master.

`patches/ardupilot-wasm.patch` adds:

- **`Tools/ardupilotwaf/boards.py`.** The Emscripten flags: `-pthread`, a modularised ES6 module
  with `createArduPilot` exported and `INVOKE_RUN=0`. Memory is a fixed 256 MB of shared memory,
  so the JavaScript views of it stay valid. The pool holds 12 pre-started threads. `FS`,
  `callMain` and `HEAPU8` are exported.
- **`SIM_JSON`.** `send_packet` and `recv_packet` go to `Module.fpvsim.servoOut` and `stateIn`.
  While waiting for physics, the main thread serves Emscripten's proxy queue, because other
  threads' file-system calls run there.
- **`SITL_State`.** A `sim:js:<n>` serial device: `SIM_JSPort` in the overlay, whose bytes go to
  `Module.fpvsim.portRead` and `portWrite`.
- **Portability.**
  - The `fenv.h` exception controls are no-ops under Emscripten.
  - termios is used for the UART utilities.
  - Threads don't get names.
  - SITL doesn't watch for its parent process.
  - waf's size report is skipped for the `.mjs`.
- **ArduCopter's takeoff check.** With no ESC telemetry to check, it clears the spool-up block the
  motors library sets at ground idle. Without that, a build with no CAN never leaves ground idle.

The JavaScript side is `src/ap/apHost.mjs`, which runs in a Web Worker in the browser and in a
Node worker thread otherwise.

## Licence

ArduPilot is GPL-3.0-or-later; the patch, the overlay and this build are under the same licence.
THIRD_PARTY_NOTICES lists ArduPilot and what it compiles in (Lua, the MAVLink headers).
