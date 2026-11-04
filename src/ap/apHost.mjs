// ArduPilot host: runs the WebAssembly ArduPlane / ArduCopter (firmware/apwasm, public/ap/) in the
// thread that calls runArduPilot, a browser Web Worker (src/ap/ap.worker.ts) or a Node worker
// thread (src/ap/apNode.ts). Plain JavaScript with no imports, so both can load it as it is.
//
// ArduPilot's main() never returns: from callMain on, this thread's event loop is blocked, so
// everything it exchanges with the simulator goes through one SharedArrayBuffer (layout AP below):
//   - lock-step physics: ArduPilot's SITL JSON backend calls servoOut once per physics frame (its
//     servo packet: magic, frame rate, frame count, PWM) and then stateIn, which blocks until the
//     simulator has stepped the plant and written the next JSON state line (src/sitl/ardupilotJson.ts);
//   - MAVLink: ArduPilot's SERIAL0 and SERIAL1 are `sim:js:0` / `sim:js:1` (SIM_JSPort), byte rings
//     in each direction;
//   - status: running, exited (and its code).
// Messages still go out (postMessage works from a blocked thread): the console lines.

/** Shared-memory layout (bytes; Int32 indices into the control block). */
export const AP = Object.freeze({
  /** control block: Int32Array(16) at byte 0 */
  CTRL_INTS: 16,
  STATE_SEQ: 0, SERVO_SEQ: 1, STATUS: 2, STATE_LEN: 3, SERVO_FRAME: 4, SERVO_N: 5, EXIT_CODE: 6, SERVO_RATE: 7,
  /** STATUS values */
  LOADING: 0, RUNNING: 1, EXITED: 2, FAILED: 3,
  /** servo PWM: Uint16Array(32) */
  SERVO_OFF: 64, SERVO_MAX: 32,
  /** the state line ("\n{json}\n") */
  STATE_OFF: 128, STATE_MAX: 4096,
  /** MAVLink rings: per port, to ArduPilot then from ArduPilot; each an Int32 head + tail then data */
  RING_OFF: 128 + 4096, RING_HDR: 8, RING_CAP: 65536, PORTS: 2,
});

/** Bytes the shared buffer needs. */
export const AP_BYTES = AP.RING_OFF + AP.PORTS * 2 * (AP.RING_HDR + AP.RING_CAP);

/** Byte offset of a ring: port, dir 0 = to ArduPilot, 1 = from ArduPilot. */
export const ringOffset = (port, dir) => AP.RING_OFF + (port * 2 + dir) * (AP.RING_HDR + AP.RING_CAP);

/** A single-producer single-consumer byte ring in shared memory. */
export class ByteRing {
  constructor(sab, off) {
    this.h = new Int32Array(sab, off, 2); // [head (written by the producer), tail (by the consumer)]
    this.d = new Uint8Array(sab, off + AP.RING_HDR, AP.RING_CAP);
  }
  /** bytes waiting */
  get size() { return (Atomics.load(this.h, 0) - Atomics.load(this.h, 1) + AP.RING_CAP) % AP.RING_CAP; }
  /** Append what fits (one byte stays free); returns how many bytes went in. */
  write(src, off = 0, n = src.length - off) {
    const head = Atomics.load(this.h, 0), tail = Atomics.load(this.h, 1), cap = AP.RING_CAP;
    const free = (tail - head - 1 + cap) % cap, k = Math.min(n, free);
    for (let i = 0; i < k; i++) this.d[(head + i) % cap] = src[off + i];
    Atomics.store(this.h, 0, (head + k) % cap);
    return k;
  }
  /** Take up to max bytes into dst at off; returns how many. */
  read(dst, off, max) {
    const head = Atomics.load(this.h, 0), tail = Atomics.load(this.h, 1), cap = AP.RING_CAP;
    const k = Math.min(max, (head - tail + cap) % cap);
    for (let i = 0; i < k; i++) dst[off + i] = this.d[(tail + i) % cap];
    Atomics.store(this.h, 1, (tail + k) % cap);
    return k;
  }
}

/**
 * Load the firmware and run it (never returns while ArduPilot runs).
 *   init.sab: SharedArrayBuffer of AP_BYTES
 *   init.moduleUrl: URL of ardu{plane,copter}.mjs
 *   init.files: { path: text } written before start (parameter defaults, Lua scripts, a mission)
 *   init.args: ArduPilot's command line
 *   post(msg): sends { type: 'log', text } / { type: 'exit', code } / { type: 'error', reason } to the simulator
 */
export async function runArduPilot(init, post) {
  const { sab } = init;
  const ctrl = new Int32Array(sab, 0, AP.CTRL_INTS);
  const servo = new Uint16Array(sab, AP.SERVO_OFF, AP.SERVO_MAX);
  const state = new Uint8Array(sab, AP.STATE_OFF, AP.STATE_MAX);
  const rings = [];
  for (let p = 0; p < AP.PORTS; p++) rings.push([new ByteRing(sab, ringOffset(p, 0)), new ByteRing(sab, ringOffset(p, 1))]);
  let lastState = Atomics.load(ctrl, AP.STATE_SEQ);
  let mod;
  try {
    const { default: create } = await import(/* @vite-ignore */ init.moduleUrl);
    mod = await create({
      print: (s) => post({ type: 'log', text: s }),
      printErr: (s) => post({ type: 'log', text: s }),
      fpvsim: {
        servoOut(heap, p, n) {
          const dv = new DataView(heap.buffer, p, n);
          const magic = dv.getUint16(0, true), ch = magic === 29569 ? 32 : 16;
          for (let k = 0; k < ch && 8 + 2 * k + 1 < n; k++) servo[k] = dv.getUint16(8 + 2 * k, true);
          Atomics.store(ctrl, AP.SERVO_N, ch);
          Atomics.store(ctrl, AP.SERVO_RATE, dv.getUint16(2, true));
          Atomics.store(ctrl, AP.SERVO_FRAME, dv.getUint32(4, true));
          Atomics.add(ctrl, AP.SERVO_SEQ, 1);
          Atomics.notify(ctrl, AP.SERVO_SEQ);
          return n;
        },
        stateIn(heap, p, max, timeoutMs) {
          if (Atomics.load(ctrl, AP.STATE_SEQ) === lastState) Atomics.wait(ctrl, AP.STATE_SEQ, lastState, timeoutMs);
          const seq = Atomics.load(ctrl, AP.STATE_SEQ);
          if (seq === lastState) return 0;
          lastState = seq;
          const n = Math.min(max, Atomics.load(ctrl, AP.STATE_LEN));
          heap.set(state.subarray(0, n), p);
          return n;
        },
        portRead(ch, heap, p, max) { return ch < AP.PORTS ? rings[ch][0].read(heap, p, max) : 0; },
        portWrite(ch, heap, p, n) { return ch < AP.PORTS ? rings[ch][1].write(heap, p, n) : n; },
      },
    });
  } catch (e) {
    Atomics.store(ctrl, AP.STATUS, AP.FAILED); Atomics.notify(ctrl, AP.SERVO_SEQ);
    post({ type: 'error', reason: `ArduPilot did not load: ${e && e.message ? e.message : String(e)}` });
    return;
  }
  const FS = mod.FS;
  for (const [path, text] of Object.entries(init.files ?? {})) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) FS.mkdirTree(dir);
    FS.writeFile(path, text);
  }
  FS.mkdirTree(init.cwd ?? '/sitl');
  FS.chdir(init.cwd ?? '/sitl');
  Atomics.store(ctrl, AP.STATUS, AP.RUNNING);
  let code = 0;
  try { code = mod.callMain(init.args) ?? 0; } catch (e) {
    // emscripten's exit() unwinds with an ExitStatus
    code = e && typeof e.status === 'number' ? e.status : -1;
    if (code === -1) post({ type: 'error', reason: `ArduPilot stopped: ${e && e.message ? e.message : String(e)}` });
  }
  Atomics.store(ctrl, AP.EXIT_CODE, code);
  Atomics.store(ctrl, AP.STATUS, AP.EXITED);
  Atomics.notify(ctrl, AP.SERVO_SEQ);
  post({ type: 'exit', code });
}
