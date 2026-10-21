// Blackbox-lite: records the 1 kHz simulator state ring (true state + raw gyro + motor outputs +
// battery) and the pilot's RC channels while armed; exports CSV for analysis (e.g. in a spreadsheet,
// Python or PIDtoolbox-style scripts).
//
// Storage is one Float32Array ring of fixed-width rows (state columns, then RC), allocated on the
// first armed sample and overwritten oldest-first once full: recording costs a few copies per
// sample, no allocation, and memory stays constant (2 min = 120 000 rows = 19 MB).
import { R, REC, RING_N, Shared } from '../worker/shared';

const COLS: [string, number][] = [
  ['time_s', R.t], ['pos_x', R.px], ['pos_y', R.py], ['pos_z', R.pz], ['q_w', R.qw], ['q_x', R.qx], ['q_y', R.qy], ['q_z', R.qz],
  ['rate_roll_dps', R.wx], ['rate_pitch_dps', R.wy], ['rate_yaw_dps', R.wz], ['vel_x', R.vx], ['vel_y', R.vy], ['vel_z', R.vz],
  ['gyro_raw_x_dps', R.gx], ['gyro_raw_y_dps', R.gy], ['gyro_raw_z_dps', R.gz],
  ['motor1_dshot', R.m0], ['motor2_dshot', R.m1], ['motor3_dshot', R.m2], ['motor4_dshot', R.m3],
  ['motor1_rpm', R.rpm0], ['motor2_rpm', R.rpm1], ['motor3_rpm', R.rpm2], ['motor4_rpm', R.rpm3],
  ['vbat_V', R.vbus], ['current_A', R.ibus], ['mah', R.mah], ['cell_V', R.cellV], ['soc', R.soc], ['batt_temp_C', R.battTemp], ['motor_temp_max_C', R.motorTemp],
];
const RC_COLS = ['rc_roll', 'rc_pitch', 'rc_throttle', 'rc_yaw', 'aux1', 'aux2', 'aux3', 'aux4'];
const RAD2DEG = 180 / Math.PI;
const DEG_COLS = new Set<number>([R.wx, R.wy, R.wz, R.gx, R.gy, R.gz]);
const SRC = Int32Array.from(COLS, ([, idx]) => idx);
const SCALE = Float64Array.from(COLS, ([, idx]) => (DEG_COLS.has(idx) ? RAD2DEG : 1));
const NS = COLS.length, NRC = RC_COLS.length, W = NS + NRC;
/** Row marker between armed segments: NaN time (written as an empty CSV line). */
const SEP = NaN;

export class Blackbox {
  /** rows of W floats: state columns, then RC; null until the first armed sample */
  private buf: Float32Array | null = null;
  private start = 0;   // oldest row
  private count = 0;   // rows held (data + separators)
  private seps = 0;    // separators among them
  private last = -1;
  recording = false;
  /** Rows the ring holds: `seconds` of armed flight at 1 kHz. */
  readonly capacity: number;

  constructor(readonly seconds = 120) { this.capacity = Math.max(1, Math.round(seconds * 1000)); }

  /** Samples recorded (segment separators not counted). */
  get length() { return this.count - this.seps; }

  /** Pull new ring records; call every frame. Records while armed. */
  pump(sh: Shared, rcNow: Float32Array) {
    const head = Atomics.load(sh.ctrl, 1);
    if (this.last < 0 || head - this.last > RING_N - 8) this.last = head - 1;
    const ring = sh.ring;
    for (let i = this.last + 1; i < head; i++) {
      const o = (i % RING_N) * REC;
      if (!(ring[o + R.armed] > 0.5)) { this.recording = false; continue; }
      if (!this.recording) { this.recording = true; if (this.count) this.push(-1, ring, rcNow); } // segment marker
      this.push(o, ring, rcNow);
    }
    this.last = head - 1;
  }

  /** Append one row (o < 0: separator), overwriting the oldest once full. */
  private push(o: number, ring: Float64Array, rc: Float32Array) {
    const cap = this.capacity, buf = (this.buf ??= new Float32Array(cap * W));
    if (this.count === cap) { // full: drop the oldest row
      if (Number.isNaN(buf[this.start * W])) this.seps--;
      this.start = (this.start + 1) % cap; this.count--;
    }
    const b = ((this.start + this.count) % cap) * W;
    this.count++;
    if (o < 0) { buf.fill(SEP, b, b + W); this.seps++; return; }
    for (let k = 0; k < NS; k++) buf[b + k] = ring[o + SRC[k]] * SCALE[k];
    for (let k = 0; k < NRC; k++) buf[b + NS + k] = rc[k] ?? 0;
  }

  clear() { this.start = this.count = this.seps = 0; }

  /** The recording as CSV text, in chunks (header line first). */
  csvParts(): string[] {
    const parts = [[...COLS.map(([n]) => n), ...RC_COLS].join(',') + '\n'];
    const buf = this.buf, cap = this.capacity;
    if (!buf) return parts;
    let chunk = '', lead = true;
    const row = new Array<number>(W);
    for (let n = 0; n < this.count; n++) {
      const b = ((this.start + n) % cap) * W;
      if (Number.isNaN(buf[b])) { if (!lead) chunk += '\n'; continue; } // separator (none before the first sample)
      lead = false;
      for (let k = 0; k < W; k++) row[k] = +buf[b + k].toFixed(5);
      chunk += row.join(',') + '\n';
      if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
    }
    if (chunk) parts.push(chunk);
    return parts;
  }

  download() {
    const blob = new Blob(this.csvParts(), { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fpv-sim-blackbox-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
