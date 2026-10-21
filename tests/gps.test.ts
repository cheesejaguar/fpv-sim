// The worker's virtual u-blox receiver: UBX framing, the replies Betaflight's driver waits for,
// NAV-PVT contents, the error model (~1.5 m CEP) and the cold start; plus Betaflight (real WASM,
// simulator defaults) getting its fix from it.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Betaflight, BF_PORT } from '../src/bf/bfModule';
import { defaultCli } from '../src/bf/defaults';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { ubx, UbxReceiver } from '../src/worker/ubxGps';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);
const STILL = { e: 0, n: 0, u: 0, ve: 0, vn: 0, vu: 0 };

/** split a byte stream into UBX frames {cls, id, payload} (checks the checksum) */
function frames(b: Uint8Array) {
  const out: { cls: number; id: number; p: DataView }[] = [];
  for (let i = 0; i + 8 <= b.length;) {
    if (b[i] !== 0xb5 || b[i + 1] !== 0x62) { i++; continue; }
    const len = b[i + 4] | (b[i + 5] << 8);
    let a = 0, c = 0;
    for (let k = i + 2; k < i + 6 + len; k++) { a = (a + b[k]) & 0xff; c = (c + a) & 0xff; }
    expect([b[i + 6 + len], b[i + 7 + len]]).toEqual([a, c]);
    out.push({ cls: b[i + 2], id: b[i + 3], p: new DataView(b.buffer, b.byteOffset + i + 6, len) });
    i += 8 + len;
  }
  return out;
}

describe('virtual u-blox receiver', () => {
  test('UBX checksum (ACK-ACK of CFG-PRT is the datasheet example)', () => {
    expect(Array.from(ubx(0x05, 0x01, new Uint8Array([0x06, 0x00])))).toEqual([0xb5, 0x62, 0x05, 0x01, 0x02, 0x00, 0x06, 0x00, 0x0e, 0x37]);
  });
  test('answers MON-VER polls as an M8, ACKs configuration, follows CFG-RATE', () => {
    const g = new UbxReceiver();
    g.powerOn(0);
    g.fromFc(new Uint8Array([...new TextEncoder().encode('$PUBX,41,1,0003,0001,115200,0*1E\r\n'), ...ubx(0x0a, 0x04)]));
    g.fromFc(ubx(0x06, 0x08, new Uint8Array([100, 0, 1, 0, 1, 0]))); // CFG-RATE 100 ms
    const f = frames(g.tick(0, STILL));
    const ver = f.find((x) => x.cls === 0x0a && x.id === 0x04)!;
    expect(new TextDecoder().decode(new Uint8Array(ver.p.buffer, ver.p.byteOffset + 30, 8))).toBe('00080000');
    expect(f.some((x) => x.cls === 0x05 && x.id === 0x01 && x.p.getUint8(0) === 0x06 && x.p.getUint8(1) === 0x08)).toBe(true);
    expect(f.some((x) => x.cls === 0x01 && x.id === 0x07)).toBe(true);
    // 10 Hz from now on
    let n = 0; for (let t = 0.001; t < 1.0005; t += 0.001) n += frames(g.tick(t, STILL)).filter((x) => x.id === 0x07).length;
    expect(n).toBe(10);
  });
  test('NAV-PVT carries the plant state; ~1.5 m CEP; cold start: fix with 12 satellites after ~8 s', () => {
    const g = new UbxReceiver({ lat: 47.3977, lon: 8.5456, altM: 400 });
    g.powerOn(0);
    g.fromFc(ubx(0x06, 0x08, new Uint8Array([100, 0, 1, 0, 1, 0]))); // 10 Hz, as Betaflight configures it
    const pvt = (t: number, s = STILL) => frames(g.tick(t, s)).find((x) => x.id === 0x07)!.p;
    const at = (t: number) => { const p = pvt(t); return { fix: p.getUint8(20), sv: p.getUint8(23) }; };
    expect(at(1)).toEqual({ fix: 0, sv: 0 });
    expect(at(6).fix).toBeLessThan(3);
    expect(at(8.5)).toEqual({ fix: 3, sv: 12 });
    // a quad 100 m east, 50 m north, 20 m up, flying 10 m/s north-east and climbing 2 m/s
    g.exact = true;
    const p = pvt(9, { e: 100, n: 50, u: 20, ve: 7.07, vn: 7.07, vu: 2 });
    const mLat = 111320, mLon = 111320 * Math.cos(47.3977 * Math.PI / 180);
    expect(p.getInt32(28, true) / 1e7).toBeCloseTo(47.3977 + 50 / mLat, 7);
    expect(p.getInt32(24, true) / 1e7).toBeCloseTo(8.5456 + 100 / mLon, 7);
    expect(p.getInt32(36, true)).toBe(420000);
    expect(p.getInt32(56, true)).toBe(-2000);                      // velD
    expect(p.getInt32(60, true)).toBeCloseTo(10000, -1);           // gSpeed
    expect(p.getInt32(64, true) / 1e5).toBeCloseTo(45, 1);         // headMot
    expect(p.getUint8(21) & 1).toBe(1);                            // gnssFixOK
    // error model: the wandering offset's spread, sampled far apart (tau 30 s)
    g.exact = false;
    const r: number[] = [];
    for (let k = 0; k < 4000; k++) {
      const q = pvt(10 + k * 120);
      const dn = (q.getInt32(28, true) / 1e7 - 47.3977) * mLat, de = (q.getInt32(24, true) / 1e7 - 8.5456) * mLon;
      r.push(Math.hypot(dn, de));
    }
    r.sort((a, b) => a - b);
    const cep = r[r.length >> 1];
    console.log(`GPS horizontal CEP ${cep.toFixed(2)} m, 95 % ${r[Math.floor(r.length * 0.95)].toFixed(2)} m`);
    expect(cep).toBeGreaterThan(1.3); expect(cep).toBeLessThan(1.75);
    // consecutive 10 Hz fixes don't jump around by metres (the error wanders slowly)
    const a = pvt(1e6), b = pvt(1e6 + 0.1);
    expect(Math.abs(a.getInt32(28, true) - b.getInt32(28, true)) / 1e7 * mLat).toBeLessThan(0.8);
  });
});

describe.skipIf(!have)('Betaflight with the simulator defaults finds the virtual GPS', () => {
  test('cold start: receiving, 3D fix and 12 satellites about 8 s after power-on', async () => {
    const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
    const bf = await Betaflight.fromFactory(mod.default);
    const gps = new UbxReceiver();
    const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000;
    let t = 0, rcAcc = 0, gAcc = 0;
    const step = () => {
      bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setBattery(16.4, 0.3, 0);
      rcAcc += 125e-6; if (rcAcc >= 0.004) { rcAcc = 0; bf.setRc(rc); }
      gAcc += 125e-6; if (gAcc >= 0.005) { gAcc = 0; gps.fromFc(bf.serialRead(BF_PORT.gps)); const o = gps.tick(t, STILL); if (o.length) bf.serialWrite(BF_PORT.gps, o); }
      bf.step(125); t += 125e-6;
    };
    const run = (s: number) => { for (let i = 0; i < s * 8000; i++) step(); };
    const enc = new TextEncoder();
    bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setBattery(16.4, 0, 0); bf.init(); gps.powerOn(0);
    run(0.5);
    bf.serialWrite(0, enc.encode('#\n')); run(0.2);
    for (const l of defaultCli(buildDrone(DEFAULT_SPEC))) { if (!l.startsWith('#')) { bf.serialWrite(0, enc.encode(l + '\n')); run(l === 'save' ? 2 : 0.02); } }
    const out = new TextDecoder().decode(bf.serialRead(0));
    expect(out).not.toMatch(/ERROR|INVALID/i);
    gps.powerOn(t); // count the cold start from the FC's reboot after save
    const t0 = t;
    let tFix = -1;
    for (let s = 0; s < 20 && tFix < 0; s += 0.1) { run(0.1); const i = bf.gpsInfo(); if (i && i.state === 5 && i.fix && i.numSat >= 12) tFix = t - t0; }
    console.log(`GPS (simulator defaults): 3D fix with ${bf.gpsInfo()?.numSat} sats ${tFix.toFixed(1)} s after power-on; FC sent ${gps.log.slice(0, 12).join(', ')}`);
    expect(tFix).toBeGreaterThan(7.5); expect(tFix).toBeLessThan(10);
  }, 120000);
});
