// Blackbox-lite: records the 1 kHz simulator state ring (true state + raw gyro + motor outputs +
// battery) and the pilot's RC channels while armed; exports CSV for analysis (e.g. in a spreadsheet,
// Python or PIDtoolbox-style scripts).
import { R, REC, RING_N, Shared } from '../worker/shared';

const COLS: [string, number][] = [
  ['time_s', R.t], ['pos_x', R.px], ['pos_y', R.py], ['pos_z', R.pz], ['q_w', R.qw], ['q_x', R.qx], ['q_y', R.qy], ['q_z', R.qz],
  ['rate_roll_dps', R.wx], ['rate_pitch_dps', R.wy], ['rate_yaw_dps', R.wz], ['vel_x', R.vx], ['vel_y', R.vy], ['vel_z', R.vz],
  ['gyro_raw_x_dps', R.gx], ['gyro_raw_y_dps', R.gy], ['gyro_raw_z_dps', R.gz],
  ['motor1_dshot', R.m0], ['motor2_dshot', R.m1], ['motor3_dshot', R.m2], ['motor4_dshot', R.m3],
  ['motor1_rpm', R.rpm0], ['motor2_rpm', R.rpm1], ['motor3_rpm', R.rpm2], ['motor4_rpm', R.rpm3],
  ['vbat_V', R.vbus], ['current_A', R.ibus], ['mah', R.mah], ['cell_V', R.cellV], ['soc', R.soc], ['batt_temp_C', R.battTemp], ['motor_temp_max_C', R.motorTemp],
];
const RAD2DEG = 180 / Math.PI;
const DEG_COLS = new Set<number>([R.wx, R.wy, R.wz, R.gx, R.gy, R.gz]);
const MAX_ROWS = 5 * 60 * 1000; // 5 minutes at 1 kHz

export class Blackbox {
  private rows: Float32Array[] = [];
  private rc: Float32Array[] = [];
  private last = -1;
  recording = false;
  get length() { return this.rows.length; }

  /** Pull new ring records; call every frame. Records while armed. */
  pump(sh: Shared, rcNow: Float32Array) {
    const head = Atomics.load(sh.ctrl, 1);
    if (this.last < 0 || head - this.last > RING_N - 8) this.last = head - 1;
    for (let i = this.last + 1; i < head; i++) {
      const o = (i % RING_N) * REC;
      const armed = sh.ring[o + R.armed] > 0.5;
      if (!armed) { this.recording = false; continue; }
      if (!this.recording) { this.recording = true; if (this.rows.length) this.rows.push(new Float32Array(0)); } // segment marker
      if (this.rows.length >= MAX_ROWS) { this.rows.shift(); this.rc.shift(); }
      const r = new Float32Array(COLS.length);
      COLS.forEach(([, idx], k) => { const v = sh.ring[o + idx]; r[k] = DEG_COLS.has(idx) ? v * RAD2DEG : v; });
      this.rows.push(r); this.rc.push(rcNow.slice(0, 8));
    }
    this.last = head - 1;
  }

  clear() { this.rows = []; this.rc = []; }

  download() {
    const head = [...COLS.map(([n]) => n), 'rc_roll', 'rc_pitch', 'rc_throttle', 'rc_yaw', 'aux1', 'aux2', 'aux3', 'aux4'].join(',');
    const lines = [head];
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (!r.length) { lines.push(''); continue; }
      lines.push([...Array.from(r, (v) => +v.toFixed(5)), ...Array.from(this.rc[i] ?? [])].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fpv-sim-blackbox-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
