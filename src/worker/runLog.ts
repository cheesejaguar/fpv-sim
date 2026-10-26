// Reproducible runs (.fpvrun): everything needed to re-simulate a live flight exactly, in the
// headless simulator, on another computer: the seed, the settings, the drone, the map, Betaflight's
// configuration image, and the sticks of every RC packet the flight controller received (with the
// physics step it arrived in), plus respawns. Lap replays (.fpvreplay) record what happened; a run
// records what was done, so the flight can be replayed with full state, or checked for divergence.
// File: gzip of a JSON document with base64 arrays. Format: docs/REPLAY_FORMAT.md#reproducible-runs.
import type { DroneSpec } from '../builder/derive';
import type { V3 } from '../sim/math';
import type { SimSettings } from './shared';

export const RUN_FORMAT = 'fpvsim-run';
export const RUN_VERSION = 1;
/** The run's GPS clock starts here (UTC ms): GPS time never comes from the wall clock in a run. */
export const RUN_GPS_EPOCH_MS = Date.UTC(2026, 0, 1);

export type RunEvent = { k: number; type: 'reset'; repair: boolean; fullBattery: boolean; at?: V3 & { yawDeg: number } };

export interface RunLog {
  format: typeof RUN_FORMAT; version: typeof RUN_VERSION;
  app: string;
  /** firmware version string and build id: a replay on another build will diverge */
  firmware: string; firmwareBuild: string;
  created: string;
  seed: number;
  mapId: string; courseId: string;
  settings: SimSettings;
  spec: DroneSpec;
  /** Betaflight's configuration image at the start (bytes) */
  eeprom: Uint8Array;
  /** physics steps flown */
  steps: number;
  /** per delivered RC packet: the physics step it arrived in, and 16 channels (µs) */
  packetSteps: Uint32Array;
  packetChannels: Float32Array;
  events: RunEvent[];
  /** why the recording ended */
  end: string;
}

/** Collects a run while it is flown. */
export class RunRecorder {
  private steps: number[] = [];
  private ch: number[] = [];
  readonly events: RunEvent[] = [];
  constructor(readonly head: Omit<RunLog, 'steps' | 'packetSteps' | 'packetChannels' | 'events' | 'end'>) {}
  /** Betaflight is handed these sticks in physics step k. */
  packet(k: number, rc: Float32Array) { this.steps.push(k); for (let i = 0; i < 16; i++) this.ch.push(rc[i]); }
  get packets() { return this.steps.length; }
  finish(steps: number, end: string): RunLog {
    return { ...this.head, steps, packetSteps: Uint32Array.from(this.steps), packetChannels: Float32Array.from(this.ch), events: this.events, end };
  }
}

function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}

/** A run as a .fpvrun file (gzip; arrays little-endian, base64). */
export async function encodeRun(r: RunLog): Promise<Uint8Array> {
  const doc = {
    ...r,
    eeprom: b64(r.eeprom),
    packetSteps: b64(bytesOf(r.packetSteps)),
    packetChannels: b64(bytesOf(r.packetChannels)),
  };
  return pipe(new TextEncoder().encode(JSON.stringify(doc)), new CompressionStream('gzip'));
}

/** Read a .fpvrun file. */
export async function decodeRun(data: Uint8Array): Promise<RunLog> {
  const gz = data[0] === 0x1f && data[1] === 0x8b;
  const text = new TextDecoder().decode(gz ? await pipe(data, new DecompressionStream('gzip')) : data);
  const d = JSON.parse(text);
  if (d?.format !== RUN_FORMAT) throw new Error('not a run file (fpvsim-run)');
  if (d.version !== RUN_VERSION) throw new Error(`run file version ${d.version}: this simulator reads version ${RUN_VERSION}`);
  const steps = unb64(d.packetSteps), ch = unb64(d.packetChannels);
  if (steps.length % 4 || ch.length % 64 || steps.length / 4 !== ch.length / 64) throw new Error('run file: packet arrays do not match');
  return {
    ...d,
    eeprom: unb64(d.eeprom),
    packetSteps: new Uint32Array(steps.buffer.slice(steps.byteOffset, steps.byteOffset + steps.byteLength)),
    packetChannels: new Float32Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.byteLength)),
  };
}
