// Betaflight's native blackbox log, captured from its serial blackbox port (blackbox_device =
// SERIAL on UART2) exactly like an OpenLog would: the byte stream from arming to "End of log" is a
// standard .bbl that Blackbox Explorer / PIDtoolbox read. One log per armed session; several logs in
// one file is the normal flash-dump layout.

export interface BblMark { cur: Uint8Array[] | null; chunks: number; sessions: number; wasArmed: boolean; full: boolean }

export class BblRecorder {
  private sessions: Uint8Array[][] = [];
  private cur: Uint8Array[] | null = null;
  private bytes = 0;
  private wasArmed = false;
  full = false;
  constructor(public capBytes = 32 * 1024 * 1024) {}

  get size(): number { return this.bytes; }
  get count(): number { return this.sessions.length; }

  /** Drained serial bytes plus the arming state now. A new session starts on every arm. */
  push(data: Uint8Array, armed: boolean): void {
    if (armed && !this.wasArmed) { this.cur = []; this.sessions.push(this.cur); this.full = false; }
    this.wasArmed = armed;
    if (!data.length) return;
    if (!this.cur) { this.cur = []; this.sessions.push(this.cur); } // log already running (e.g. worker restart)
    // over the cap: forget the oldest sessions; a single session larger than the cap stops growing
    while (this.bytes + data.length > this.capBytes && this.sessions.length > 1) {
      const old = this.sessions.shift()!;
      this.bytes -= old.reduce((a, c) => a + c.length, 0);
    }
    if (this.bytes + data.length > this.capBytes) { this.full = true; return; }
    this.cur.push(data.slice());
    this.bytes += data.length;
  }

  /** Every session, oldest first, as one .bbl file. */
  export(): ArrayBuffer {
    const out = new Uint8Array(this.bytes);
    let o = 0;
    for (const s of this.sessions) for (const c of s) { out.set(c, o); o += c.length; }
    return out.buffer;
  }

  clear(): void { this.sessions = []; this.cur = null; this.bytes = 0; this.full = false; }

  /** Where the log is now, to come back to with rewind() (a practice point). */
  mark(): BblMark { return { cur: this.cur, chunks: this.cur?.length ?? 0, sessions: this.sessions.length, wasArmed: this.wasArmed, full: this.full }; }

  /**
   * Back to a mark(): what was logged since goes. Betaflight's memory goes back to that moment
   * too (its logger's state, and the bytes still in its serial buffer), so the log carries on as a
   * valid .bbl from there.
   */
  rewind(m: BblMark): void {
    const at = m.cur ? this.sessions.indexOf(m.cur) : -1;
    if (m.cur && at < 0) { this.cur = null; this.wasArmed = m.wasArmed; return; } // (that session was dropped for space meanwhile)
    if (m.cur) { this.sessions.length = at + 1; m.cur.length = Math.min(m.cur.length, m.chunks); }
    else this.sessions.length = Math.min(this.sessions.length, m.sessions);
    this.cur = m.cur; this.wasArmed = m.wasArmed; this.full = m.full;
    this.bytes = 0;
    for (const s of this.sessions) for (const c of s) this.bytes += c.length;
  }
}
