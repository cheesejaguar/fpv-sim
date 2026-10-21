// The sim worker (Betaflight WASM + physics) and the message plumbing to it: plain messages, CLI
// output listeners, and request/response CLI batches.
import type { FromWorker, ToWorker } from '../worker/shared';

export interface BfBridge {
  cliBatch(lines: string[]): Promise<string>;
  cliSend(text: string): void;
  /** Subscribe to CLI output; returns an unsubscribe function. */
  onCliOut(cb: (t: string) => void): () => void;
}

export class WorkerBridge implements BfBridge {
  readonly worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
  private cliListeners = new Set<(t: string) => void>();
  private batchWaiters = new Map<number, (s: string) => void>();
  private batchId = 1;
  /** Everything else the worker says (ready, telemetry, gates, spectrum …). */
  onMessage: (m: FromWorker) => void = () => {};

  constructor() {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'cliOut') { for (const l of this.cliListeners) l(m.text); return; }
      if (m.type === 'cliBatchDone') { this.batchWaiters.get(m.id)?.(m.output); this.batchWaiters.delete(m.id); return; }
      this.onMessage(m);
    };
  }

  send = (m: ToWorker) => this.worker.postMessage(m);
  cliBatch = (lines: string[]) => new Promise<string>((res) => { const id = this.batchId++; this.batchWaiters.set(id, res); this.send({ type: 'cliBatch', lines, id }); });
  cliSend = (text: string) => this.send({ type: 'cli', text });
  onCliOut = (cb: (t: string) => void) => { this.cliListeners.add(cb); return () => { this.cliListeners.delete(cb); }; };
}
