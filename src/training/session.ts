// The training session in the app: runs drill attempts through the live game's scenario support
// (the control API's reset, with the pilot flying), records how each went, adapts the level, and
// starts the next attempt. Progress is kept in this browser (fpv-training) and exports as CSV / JSON.
import type { ApiHost } from '../app/apiHost';
import type { AppCtx } from '../app/context';
import type { TaskMetrics } from '../scenario/tasks';
import type { DrillInfo } from '../ui/hud/hud';
import { Attempt, drillById, DRILLS, hoverMarker, newTrainingState, recordAttempt, TrainingState } from './curriculum';

const KEY = 'fpv-training';
/** Seconds between an attempt's end and the next one (auto mode). */
export const NEXT_DELAY_S = 3;

export interface SessionDeps { ctx: AppCtx; api: ApiHost; fly(): void }

function load(): TrainingState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object' && Array.isArray(raw.attempts)) {
      const st = { ...newTrainingState(), ...raw };
      if (!drillById(st.drill)) st.drill = DRILLS[0].id;
      return st;
    }
  } catch { /* none, or unreadable: start over */ }
  return newTrainingState();
}

export class TrainingSession {
  state: TrainingState = load();
  /** an attempt is being flown */
  running = false;
  last: Attempt | null = null;
  onChange: (() => void) | null = null;
  private off: (() => void) | null = null;
  private next: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: SessionDeps) {}

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* full or blocked: progress stays in this session */ } }

  get drill() { return drillById(this.state.drill) ?? DRILLS[0]; }
  level(id = this.state.drill) { return this.state.levels[id] ?? 0; }

  /** Start an attempt at the drill's current level (and keep going, in auto mode). */
  async start(): Promise<void> {
    this.cancelNext();
    const { ctx, api } = this.deps;
    const drill = this.drill, d = this.level();
    const b = await api.backend();
    this.off?.();
    this.off = b.listen('episode', (e) => this.ended(e as { reason: string; metrics: TaskMetrics }));
    this.running = true;
    ctx.trainingTarget = hoverMarker(drill, d);
    ctx.trainingHud = () => this.hud();
    try {
      await b.call('reset', { scenario: drill.scenario(d), pilot: true });
    } catch (e) {
      this.stop();
      ctx.log(`Training: ${(e as Error).message}`);
      throw e;
    }
    this.deps.fly();
    ctx.log(`Training: ${drill.name}, level ${(d * 100).toFixed(0)} %: ${drill.describe(d)}`);
    this.onChange?.();
  }

  stop() {
    this.cancelNext();
    this.off?.(); this.off = null;
    this.running = false;
    const ctx = this.deps.ctx;
    ctx.trainingTarget = null; ctx.trainingHud = undefined;
    this.onChange?.();
  }

  private cancelNext() { if (this.next) clearTimeout(this.next); this.next = null; }

  private ended(e: { reason: string; metrics: TaskMetrics }) {
    if (!this.running) return;
    const ctx = this.deps.ctx, drill = this.drill;
    // a respawn abandons the attempt: not scored, the same level again
    if (e.reason !== 'respawn') {
      const a = recordAttempt(this.state, drill, e.metrics, e.reason);
      this.last = a;
      this.save();
      const verdict = a.outcome === 'pass' ? 'passed' : a.outcome === 'hold' ? 'done, not yet clean' : 'failed';
      const move = a.next > a.level ? `level up to ${(a.next * 100).toFixed(0)} %` : a.next < a.level ? `level down to ${(a.next * 100).toFixed(0)} %` : `level stays at ${(a.next * 100).toFixed(0)} %`;
      ctx.log(`Training: ${drill.name} ${verdict} (${e.reason}); ${move}`);
    }
    this.onChange?.();
    if (this.state.auto) this.next = setTimeout(() => { this.next = null; if (this.running) void this.start().catch(() => {}); }, NEXT_DELAY_S * 1000);
    else this.stop();
  }

  /** The HUD card of a hover drill in progress. */
  private hud(): DrillInfo | null {
    const tgt = this.deps.ctx.trainingTarget;
    const st = this.deps.api.taskStatus();
    if (!tgt || !st) return null;
    const m = st.metrics, rec = this.deps.ctx.rec;
    const sc = this.drill.scenario(this.level());
    const total = sc.task?.type === 'hover' ? sc.task.holdS ?? 30 : 30;
    const dx = rec[1] - tgt.x, dy = rec[2] - tgt.y, dz = rec[3] - tgt.z, dist = Math.hypot(dx, dy, dz);
    return {
      title: `${this.drill.name.toUpperCase()} · LV ${(this.level() * 100).toFixed(0)}`,
      inBox: dist < tgt.radius, offBy: Math.max(0, dist - tgt.radius),
      elapsed: Math.min(total, m.progress * total), total,
      score: (m.insideFraction ?? 0) * 100,
      best: Math.max(0, ...this.state.attempts.filter((a) => a.drill === this.drill.id).map((a) => (a.metrics.insideFraction ?? 0) * 100)),
    };
  }

  clearProgress(drillId?: string) {
    if (drillId) { delete this.state.levels[drillId]; this.state.attempts = this.state.attempts.filter((a) => a.drill !== drillId); }
    else this.state = { ...newTrainingState(), drill: this.state.drill, adaptive: this.state.adaptive, auto: this.state.auto };
    this.save(); this.onChange?.();
  }
}

let session: TrainingSession | null = null;
export function trainingSession(deps: SessionDeps): TrainingSession { return (session ??= new TrainingSession(deps)); }
