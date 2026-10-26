// External autopilots (src/sitl/): the plant answers ArduPilot's JSON protocol and PX4's MAVLink
// HIL protocol in lock-step. A stand-in ArduPilot (a small attitude + altitude controller reading
// only the JSON state) flies the plant through the real protocol; a stand-in PX4 checks the HIL
// handshake, sensor frames and units, and the TCP server.
import { createConnection } from 'node:net';
import { describe, expect, test } from 'vitest';
import { installNodeHost } from '../src/headless/node';
import { rotateInv } from '../src/sim/math';
import { encodeServoPacket, parseStateJson, SERVO_MAGIC_16 } from '../src/sitl/ardupilotJson';
import { encode, MavlinkParser, MavMessage } from '../src/sitl/mavlink';
import { SitlPlant } from '../src/sitl/plant';
import { ArduPilotLink, Px4Link, servePx4 } from '../src/sitl/server';

installNodeHost();

const SC = {
  format: 'fpvsim-scenario', version: 1, seed: 3, map: { id: 'field' }, drone: { preset: '5" Freestyle 6S' },
  sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 } },
};

/** Quad-X mixer in the autopilots' order (front-right CCW, rear-left CCW, front-left CW, rear-right CW). */
function mix(thr: number, tx: number, ty: number, tz: number): number[] {
  // FLU torques: +x rolls the right side down (left motors up), +y pitches the nose down (rear motors up), +z yaws left (CW props up)
  const m = [thr - tx - ty - tz, thr + tx + ty - tz, thr + tx - ty + tz, thr - tx + ty + tz];
  return m.map((x) => Math.max(0.02, Math.min(1, x)));
}

describe('ArduPilot JSON plant', () => {
  test('a stand-in ArduPilot flies the plant to 2 m and holds it through the protocol', async () => {
    const plant = new SitlPlant();
    await plant.reset(SC);
    const link = new ArduPilotLink(plant);
    const hover = plant.facts().hoverThrottle;
    let frame = 0, integ = 0;
    let st = parseStateJson(link.receive(encodeServoPacket({ magic: SERVO_MAGIC_16, frameRate: 400, frameCount: frame, pwm: new Array(16).fill(1000) }))!)!;
    const t0 = st.time;
    for (let i = 0; i < 400 * 6; i++) {
      // the controller sees only what ArduPilot would: the JSON state (back in ENU / FLU)
      const up = rotateInv({ x: 0, y: 0, z: 0 }, st.q, { x: 0, y: 0, z: 1 });
      const w = st.gyro;
      const h = st.pos.z, e = 2 - h;
      integ += e / 400;
      const thr = hover + 0.25 * e + 0.05 * integ - 0.15 * st.vel.z;
      const tx = -1.2 * up.y - 0.08 * w.x, ty = 1.2 * up.x - 0.08 * w.y, tz = -0.1 * w.z;
      const out = mix(thr, tx, ty, tz);
      frame++;
      const reply = link.receive(encodeServoPacket({ magic: SERVO_MAGIC_16, frameRate: 400, frameCount: frame, pwm: [...out.map((x) => 1000 + 1000 * x), ...new Array(12).fill(1000)] }))!;
      const next = parseStateJson(reply)!;
      expect(next.time - st.time).toBeCloseTo(1 / 400, 9);
      st = next;
    }
    expect(st.time - t0).toBeCloseTo(6, 6);
    expect(st.pos.z).toBeGreaterThan(1.6);
    expect(st.pos.z).toBeLessThan(2.4);
    expect(Math.hypot(st.vel.x, st.vel.y, st.vel.z)).toBeLessThan(0.6);
    // at rest-ish: the specific force is gravity, up in the body
    expect(st.accel.z).toBeGreaterThan(8.5);
    // a resend (same frame_count) answers without stepping
    const again = parseStateJson(link.receive(encodeServoPacket({ magic: SERVO_MAGIC_16, frameRate: 400, frameCount: frame, pwm: new Array(16).fill(1500) }))!)!;
    expect(again.time).toBe(st.time);
  }, 120000);
});

describe('PX4 HIL plant', () => {
  const sensors = (msgs: MavMessage[]) => msgs.flatMap((m) => (m.name === 'HIL_SENSOR' ? [m.fields] : []));

  test('HIL_SENSOR is PX4\'s clock: 4 ms per lock-step cycle, FRD units, every sensor group', async () => {
    const plant = new SitlPlant();
    await plant.reset(SC);
    const parser = new MavlinkParser(), got: MavMessage[] = [];
    const link = new Px4Link(plant, (b) => got.push(...parser.push(b)));
    link.cycle();
    for (let i = 0; i < 300; i++) link.receive(encode({ name: 'HIL_ACTUATOR_CONTROLS', fields: { time_usec: i, controls: new Array(16).fill(0), mode: 1, flags: 1 } }, { sysid: 1, compid: 1, seq: i & 255 }));
    const s = sensors(got);
    expect(s.length).toBe(301);
    for (let i = 1; i < s.length; i++) expect(s[i].time_usec - s[i - 1].time_usec).toBe(4000);
    const last = s[s.length - 1];
    expect(last.zacc).toBeCloseTo(-9.81, 0); // FRD: gravity reads -g on z at rest
    expect(Math.hypot(last.xgyro, last.ygyro, last.zgyro)).toBeLessThan(0.05);
    expect(last.abs_pressure).toBeGreaterThan(900);
    expect(last.abs_pressure).toBeLessThan(1020);
    expect(Math.hypot(last.xmag, last.ymag, last.zmag)).toBeCloseTo(0.48, 1);
    expect(last.zmag).toBeGreaterThan(0.3); // FRD z down: the northern-hemisphere field points down
    expect(s.some((x) => (x.fields_updated & 0x1c0) === 0x1c0)).toBe(true);
    const gps = got.flatMap((m) => (m.name === 'HIL_GPS' ? [m.fields] : []));
    expect(gps.length).toBeGreaterThan(10);
    expect(gps[gps.length - 1].fix_type).toBe(3);
    expect(Math.abs(gps[gps.length - 1].lat / 1e7 - 47.3977)).toBeLessThan(0.01);
    expect(got.some((m) => m.name === 'HIL_STATE_QUATERNION')).toBe(true);
    expect(got.some((m) => m.name === 'DISTANCE_SENSOR')).toBe(true);
  }, 60000);

  test('armed outputs spin the motors and lift the quad; a GNSS jammer takes PX4\'s fix away', async () => {
    const plant = new SitlPlant();
    await plant.reset({ ...SC, ops: { emitters: [{ band: 'gnss', pos: [-44, -6, 10], erpW: 2, fromS: 1 }] } });
    const parser = new MavlinkParser(), got: MavMessage[] = [];
    const link = new Px4Link(plant, (b) => got.push(...parser.push(b)));
    link.cycle();
    const z0 = plant.core.quad.s.pos.z;
    for (let i = 0; i < 250 * 1.5; i++) link.receive(encode({ name: 'HIL_ACTUATOR_CONTROLS', fields: { time_usec: i, controls: [0.7, 0.7, 0.7, 0.7, ...new Array(12).fill(0)], mode: 129, flags: 1 } }, { sysid: 1, compid: 1, seq: i & 255 }));
    expect(link.armed).toBe(true);
    expect(plant.core.quad.s.pos.z - z0).toBeGreaterThan(1);
    const gps = got.flatMap((m) => (m.name === 'HIL_GPS' ? [m.fields] : []));
    expect(gps[0].satellites_visible).toBe(12);
    expect(gps[gps.length - 1]).toMatchObject({ satellites_visible: 0, fix_type: 0 });
  }, 60000);

  test('the TCP server streams sensors on the wall clock until PX4 answers', async () => {
    const plant = new SitlPlant();
    await plant.reset(SC);
    const srv = await servePx4(plant, { port: 0 });
    const port = (srv.address() as { port: number }).port;
    const parser = new MavlinkParser(), got: MavMessage[] = [];
    const sock = createConnection(port, '127.0.0.1');
    sock.on('data', (d: Buffer) => got.push(...parser.push(new Uint8Array(d))));
    await new Promise((r) => setTimeout(r, 300));
    const free = sensors(got).length;
    expect(free).toBeGreaterThan(10);
    // lock-step from the first outputs: exactly one HIL_SENSOR per HIL_ACTUATOR_CONTROLS
    for (let i = 0; i < 20; i++) sock.write(encode({ name: 'HIL_ACTUATOR_CONTROLS', fields: { time_usec: i, controls: new Array(16).fill(0), mode: 1, flags: 1 } }, { sysid: 1, compid: 1, seq: i }));
    await new Promise((r) => setTimeout(r, 300));
    const n1 = sensors(got).length;
    await new Promise((r) => setTimeout(r, 200));
    expect(sensors(got).length).toBe(n1);
    expect(n1 - free).toBeGreaterThanOrEqual(20);
    expect(n1 - free).toBeLessThanOrEqual(22);
    sock.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  }, 60000);
});
