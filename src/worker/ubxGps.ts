// Virtual u-blox M8 GPS receiver on Betaflight's GPS UART (UBX protocol, host side).
//
// Betaflight 4.5 (io/gps.c, gps_provider = UBLOX) polls MON-VER while it cycles baud rates until a
// receiver answers; hwVersion 00080000 (M8) selects its CFG-MSG / NAV-PVT path. It then sends
// $PUBX text, CFG-RATE / CFG-MSG / CFG-NAV5 / CFG-SBAS / CFG-PMS / CFG-GNSS one at a time (each
// waits up to 150 ms for ACK-ACK) and from then on expects NAV-PVT at the configured rate (10 Hz)
// plus NAV-SAT at 1:5; 2.5 s without a solution sends it back to baud detection.
//
// The solution is the plant's true position / velocity (ENU metres from a fixed origin) plus a
// realistic error: a slowly wandering offset (Gauss-Markov, ~1.5 m CEP horizontally) and a little
// white noise, Doppler velocity with ~0.1 m/s noise. Cold start: no satellites for 3 s, a few
// without a fix, then a 3D fix with 12 satellites from ~8 s after power-on.

/** UBX frame: B5 62 class id len16 payload ckA ckB (8-bit Fletcher over class..payload). */
export function ubx(cls: number, id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(8 + payload.length);
  f[0] = 0xb5; f[1] = 0x62; f[2] = cls; f[3] = id; f[4] = payload.length & 0xff; f[5] = payload.length >> 8;
  f.set(payload, 6);
  let a = 0, b = 0;
  for (let i = 2; i < 6 + payload.length; i++) { a = (a + f[i]) & 0xff; b = (b + a) & 0xff; }
  f[6 + payload.length] = a; f[7 + payload.length] = b;
  return f;
}

export function ubxMonVer(hw = '00080000', sw = 'ROM CORE 3.01 (107888)'): Uint8Array {
  const p = new Uint8Array(40);
  p.set(new TextEncoder().encode(sw).subarray(0, 29), 0);
  p.set(new TextEncoder().encode(hw).subarray(0, 9), 30);
  return ubx(0x0a, 0x04, p);
}

export interface NavPvt {
  iTOW: number; utcMs: number; lat: number; lon: number; hMSLmm: number;
  velN: number; velE: number; velD: number; numSV: number; fixType: 0 | 2 | 3;
  hAccMm: number; vAccMm: number; sAccMms: number; pDOP: number;
}

export function ubxNavPvt(s: NavPvt): Uint8Array {
  const p = new DataView(new ArrayBuffer(92));
  const d = new Date(s.utcMs);
  p.setUint32(0, s.iTOW >>> 0, true);
  p.setUint16(4, d.getUTCFullYear(), true); p.setUint8(6, d.getUTCMonth() + 1); p.setUint8(7, d.getUTCDate());
  p.setUint8(8, d.getUTCHours()); p.setUint8(9, d.getUTCMinutes()); p.setUint8(10, d.getUTCSeconds());
  const fix = s.fixType === 3;
  p.setUint8(11, fix ? 0x07 : 0x00);                 // valid: date, time, fully resolved
  p.setUint32(12, fix ? 30 : 0xffffffff, true);      // tAcc ns
  p.setInt32(16, (d.getUTCMilliseconds() * 1e6) | 0, true); // nano
  p.setUint8(20, s.fixType);
  p.setUint8(21, s.fixType >= 2 ? 0x01 : 0x00);      // flags: gnssFixOK
  p.setUint8(22, fix ? 0xe0 : 0); p.setUint8(23, s.numSV);
  p.setInt32(24, Math.round(s.lon * 1e7), true); p.setInt32(28, Math.round(s.lat * 1e7), true);
  p.setInt32(32, s.hMSLmm + 48000, true); p.setInt32(36, s.hMSLmm, true); // height above ellipsoid, hMSL
  p.setUint32(40, s.hAccMm, true); p.setUint32(44, s.vAccMm, true);
  p.setInt32(48, s.velN, true); p.setInt32(52, s.velE, true); p.setInt32(56, s.velD, true);
  const gSpeed = Math.round(Math.hypot(s.velN, s.velE));
  p.setInt32(60, gSpeed, true);
  p.setInt32(64, Math.round((((Math.atan2(s.velE, s.velN) * 180) / Math.PI + 360) % 360) * 1e5), true); // headMot 1e-5 deg
  p.setUint32(68, s.sAccMms, true); p.setUint32(72, 5e6, true); p.setUint16(76, s.pDOP, true);
  return ubx(0x01, 0x07, new Uint8Array(p.buffer));
}

/** NAV-SAT with numSV used satellites (C/N0 ~40 dBHz). */
export function ubxNavSat(iTOW: number, numSV: number): Uint8Array {
  const p = new DataView(new ArrayBuffer(8 + 12 * numSV));
  p.setUint32(0, iTOW >>> 0, true); p.setUint8(4, 1); p.setUint8(5, numSV);
  for (let k = 0; k < numSV; k++) {
    const o = 8 + 12 * k;
    p.setUint8(o, k < 8 ? 0 : 2); p.setUint8(o + 1, k + 1); p.setUint8(o + 2, 36 + ((k * 7) % 10)); // GPS / Galileo, svId, cno
    p.setInt8(o + 3, 20 + ((k * 13) % 60)); p.setInt16(o + 4, (k * 47) % 360, true);                 // elev, azim
    p.setUint32(o + 8, 0x0f | 0x08, true);                                                          // qualityInd 7, svUsed
  }
  return ubx(0x01, 0x35, new Uint8Array(p.buffer));
}

export interface GpsOrigin { lat: number; lon: number; altM: number }
export interface Enu { e: number; n: number; u: number; ve: number; vn: number; vu: number }

/** Fixed simulator origin: the map's (0,0,0) sits here, its elevation added to altM. */
export const GPS_ORIGIN: GpsOrigin = { lat: 47.3977, lon: 8.5456, altM: 0 };

export class UbxReceiver {
  private buf: number[] = [];
  private pending: Uint8Array[] = [];
  private measMs = 1000;    // until CFG-RATE says otherwise
  private nextT = -Infinity;
  private navSatDiv = 0;
  private navCount = 0;
  private powerOnT = 0;
  // position error: Gauss-Markov offsets (m), white noise on top
  private errE = 0; private errN = 0; private errU = 0; private lastErrT = 0;
  private seed: number;
  monVerPolls = 0;
  /** first messages from the FC, for diagnostics */
  log: string[] = [];
  /** horizontal CEP (m) of the wandering offset; vertical sigma is ~1.6x larger */
  cepM = 1.5;
  /** time constant of the wandering offset (s) */
  tauS = 30;
  /** sats once fixed; cold-start fix time after power-on (s) */
  sats = 12; fixAfterS = 8;
  /** disable the error model (exact positions) */
  exact = false;

  constructor(public origin: GpsOrigin = GPS_ORIGIN, seed = 0x6a5) { this.seed = seed >>> 0 || 1; }

  /** (Re)power the receiver at host time t: cold start, Betaflight has to find it again. */
  powerOn(t: number): void {
    this.powerOnT = t; this.nextT = -Infinity; this.measMs = 1000; this.navSatDiv = 0; this.buf.length = 0; this.pending.length = 0;
    const s = this.sigma();
    this.errE = s * this.gauss(); this.errN = s * this.gauss(); this.errU = 1.6 * s * this.gauss(); this.lastErrT = t;
  }

  private rnd(): number { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0; return (this.seed + 0.5) / 4294967296; }
  private gauss(): number { return Math.sqrt(-2 * Math.log(this.rnd())) * Math.cos(2 * Math.PI * this.rnd()); }
  /** per-axis sigma of a circular Gaussian with this CEP (CEP = 1.1774 sigma) */
  private sigma(): number { return this.cepM / 1.1774; }

  /** Satellites in use at host time t (cold start ramp). */
  satsAt(t: number): number {
    const a = t - this.powerOnT;
    if (a < 3) return 0;
    if (a < this.fixAfterS) return Math.min(this.sats, 3 + Math.floor((a - 3) * 0.6));
    return this.sats;
  }

  /** Bytes the FC transmitted on the GPS UART: answer polls, ACK configuration. */
  fromFc(data: Uint8Array): void {
    for (const b of data) this.buf.push(b);
    for (;;) {
      const i = this.buf.indexOf(0xb5);
      if (i < 0) { this.buf.length = 0; break; }
      if (i > 0) this.buf.splice(0, i);     // $PUBX / NMEA text, noise
      if (this.buf.length < 8) break;
      if (this.buf[1] !== 0x62) { this.buf.shift(); continue; }
      const len = this.buf[4] | (this.buf[5] << 8);
      if (len > 1024) { this.buf.shift(); continue; }
      if (this.buf.length < 8 + len) break;
      const cls = this.buf[2], id = this.buf[3], payload = this.buf.slice(6, 6 + len);
      this.buf.splice(0, 8 + len);
      if (cls === 0x0a && id === 0x04 && len === 0) { this.monVerPolls++; this.pending.push(ubxMonVer()); this.note('MON-VER?'); continue; }
      if (cls === 0x06) {
        if (id === 0x08 && len >= 2) { this.measMs = Math.max(25, payload[0] | (payload[1] << 8)); this.note(`CFG-RATE ${this.measMs}ms`); }
        else if (id === 0x01 && len >= 3) { if (payload[0] === 0x01 && payload[1] === 0x35) this.navSatDiv = payload[2]; this.note(`CFG-MSG ${payload[0].toString(16)}-${payload[1].toString(16)}:${payload[2]}`); }
        else this.note(`CFG-${id.toString(16)}`);
        this.pending.push(ubx(0x05, 0x01, new Uint8Array([cls, id]))); // ACK-ACK
      }
    }
  }
  private note(s: string) { if (this.log.length < 40 && this.log[this.log.length - 1] !== s) this.log.push(s); }

  /**
   * Call often (≥ 100 Hz) with host time t (s), the true ENU state and the UTC time; returns the
   * bytes to send to the FC: replies, plus a navigation solution whenever one is due.
   */
  tick(t: number, enu: Enu, utcMs = Date.UTC(2026, 9, 21, 12) + t * 1000, numSV?: number): Uint8Array {
    const out = this.pending.splice(0);
    if (t >= this.nextT) {
      this.nextT = (this.nextT === -Infinity ? t : this.nextT) + this.measMs / 1000;
      if (this.nextT < t) this.nextT = t + this.measMs / 1000;
      out.push(this.solution(t, enu, utcMs, numSV));
      if (this.navSatDiv && ++this.navCount % this.navSatDiv === 0) out.push(ubxNavSat(this.tow(t), numSV ?? this.satsAt(t)));
    }
    if (!out.length) return new Uint8Array(0);
    const n = out.reduce((a, c) => a + c.length, 0), all = new Uint8Array(n);
    let o = 0; for (const c of out) { all.set(c, o); o += c.length; }
    return all;
  }

  private tow(t: number): number { return (345600000 + Math.round(t * 1000)) % 604800000; }

  /** svOverride: force the satellite count (a 3D fix from 4 on), e.g. for tests */
  private solution(t: number, enu: Enu, utcMs: number, svOverride?: number): Uint8Array {
    const numSV = svOverride ?? this.satsAt(t);
    const fixType = svOverride != null ? (numSV >= 4 ? 3 : 0) : numSV >= 6 && t - this.powerOnT >= this.fixAfterS ? 3 : numSV >= 4 ? 2 : 0;
    // wandering offset: exact discretisation of a first-order Gauss-Markov process
    const dt = Math.max(0, t - this.lastErrT); this.lastErrT = t;
    const a = Math.exp(-dt / this.tauS), w = Math.sqrt(1 - a * a), s = this.sigma();
    this.errE = this.errE * a + w * s * this.gauss();
    this.errN = this.errN * a + w * s * this.gauss();
    this.errU = this.errU * a + w * 1.6 * s * this.gauss();
    const k = this.exact ? 0 : 1;
    const e = enu.e + k * (this.errE + 0.15 * this.gauss()), n = enu.n + k * (this.errN + 0.15 * this.gauss()), u = enu.u + k * (this.errU + 0.25 * this.gauss());
    const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((this.origin.lat * Math.PI) / 180);
    const vn = enu.vn + k * 0.08 * this.gauss(), ve = enu.ve + k * 0.08 * this.gauss(), vu = enu.vu + k * 0.12 * this.gauss();
    const fixed = fixType === 3;
    return ubxNavPvt({
      iTOW: this.tow(t), utcMs, lat: this.origin.lat + n / mPerDegLat, lon: this.origin.lon + e / mPerDegLon,
      hMSLmm: Math.round((this.origin.altM + u) * 1000), velN: Math.round(vn * 1000), velE: Math.round(ve * 1000), velD: Math.round(-vu * 1000),
      numSV, fixType, hAccMm: fixed ? Math.round(this.cepM * 1000 * 1.2) : 50000, vAccMm: fixed ? Math.round(this.cepM * 2000) : 80000,
      sAccMms: fixed ? 150 : 5000, pDOP: fixed ? 120 : numSV >= 4 ? 450 : 9999,
    });
  }
}
