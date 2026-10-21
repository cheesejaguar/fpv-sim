// Betaflight CLI batches over the in-memory UART1, and persistence of the EEPROM image.
// Kept free of worker globals so tests can drive them against the real WASM build.
import type { Betaflight } from '../bf/bfModule';
import type { KvStore } from './kv';

const enc = new TextEncoder(), dec = new TextDecoder();
const STEP_MS = 2;

/**
 * Run CLI lines and return everything the FC printed. advanceMs(ms) must move firmware time on by
 * ms (the caller decides whether the plant flies or holds still meanwhile). A line is done as soon
 * as the CLI prompt comes back (the reply to one command is written in one go), so a `get` costs a
 * few ms of firmware time; save / exit reboot the FC and get the time a boot takes.
 */
export function runCliBatch(bf: Betaflight, lines: string[], advanceMs: (ms: number) => void): string {
  let out = '';
  // Betaflight drops non-MSP bytes ('#') while armed: let the disarm (the menu / builder sets the arm
  // switch low) reach the FC first; a quad that stays armed gets no CLI, as on hardware
  const mot = new Uint16Array(8);
  for (let ms = 0; ms < 600 && bf.getMotors(mot); ms += 10) advanceMs(10);
  if (bf.getMotors(mot)) return '';
  const pump = (minMs: number, maxMs: number, prompt: boolean) => {
    let quiet = 0, seg = '';
    for (let ms = 0; ms < maxMs; ms += STEP_MS) {
      advanceMs(STEP_MS);
      const r = bf.serialRead(0);
      if (r.length) { const t = dec.decode(r, { stream: true }); out += t; seg += t; quiet = 0; } else quiet += STEP_MS;
      if (ms + STEP_MS < minMs) continue;
      if (prompt && /\n# $/.test(seg)) return;
      if (quiet >= 150) return; // no prompt (exit, reboot, firmware without one): replies went quiet
    }
  };
  bf.serialWrite(0, enc.encode('#\n')); pump(10, 1000, true);
  for (const l of lines) {
    if (l.startsWith('#') && l.length > 1) continue;
    bf.serialWrite(0, enc.encode(l + '\n'));
    if (l === 'save' || l === 'exit') pump(1500, 4000, false); else pump(STEP_MS, 1500, true);
  }
  if (!lines.includes('save')) { bf.serialWrite(0, enc.encode('exit\n')); pump(1500, 4000, false); }
  return out;
}

/**
 * The EEPROM image in a KvStore. bf_eeprom_dirty() reports a change exactly once (reading it resets
 * it), so check() is the only place that reads it and it stores the image right away. Writes are
 * queued: images reach the store in the order they were taken, the newest last.
 */
export class EepromStore {
  static readonly KEY = 'bf-eeprom';
  private chain: Promise<unknown> = Promise.resolve();
  writes = 0;
  constructor(private kv: KvStore) {}

  /** Persist if the firmware changed its config since the last check; true if it did. */
  check(bf: Betaflight | null): boolean {
    if (!bf || !bf.eepromDirty()) return false;
    void this.save(bf.eepromGet());
    return true;
  }
  save(img: Uint8Array): Promise<boolean> {
    const p = this.chain.then(() => this.kv.set(EepromStore.KEY, img)).then((ok) => { if (ok) this.writes++; return ok; }, () => false);
    this.chain = p;
    return p;
  }
  /** Resolves once every queued write has finished. */
  flush(): Promise<unknown> { return this.chain; }
  async load(): Promise<Uint8Array | undefined> {
    const v = await this.kv.get(EepromStore.KEY);
    return v instanceof Uint8Array && v.length ? v : undefined;
  }
}
