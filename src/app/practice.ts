// Practice points, like a skateboarding game's marker: one button keeps the flight as it is now, another
// flies straight back into that exact moment (same place, attitude, speed and spin, the flight
// controller's own state included), as many times as a trick takes. The worker keeps the state
// (FlightCore.markPoint / recallPoint); this side asks for it, shows where the point is and what
// happened, and puts the pilot's controls back as they were then.
import { buttonName, SimAction } from '../input/gamepad';
import type { FromWorker } from '../worker/shared';
import type { AppCtx } from './context';

/** Keyboard keys of the two actions (main.ts binds them; the hints and notices name them). */
export const PRACTICE_KEYS: Record<'markPoint' | 'recallPoint', string> = { markPoint: 'Q', recallPoint: 'E' };

export interface PracticeState {
  /** where the point is (ENU m) and the heading then, for the marker; armed and the next gate then */
  point: { x: number; y: number; z: number; yawDeg: number; armed: boolean; nextGate: number } | null;
  /** a short notice card (performance.now() ms it goes away) */
  note: { title: string; text: string; until: number; warn: boolean } | null;
}
export const newPractice = (): PracticeState => ({ point: null, note: null });

/** How the pilot triggers an action on the device in use (a controller button, else the key). */
export function actionGlyph(ctx: AppCtx, a: 'markPoint' | 'recallPoint'): string {
  const pad = ctx.input.active;
  if (pad) {
    const p = ctx.input.profileFor(pad), b = ctx.input.actionButtons(pad, p)[a as SimAction];
    return b != null ? buttonName(p.kind, b) : 'its button (Settings → Controller)';
  }
  return PRACTICE_KEYS[a];
}

const note = (ctx: AppCtx, title: string, text: string, ms: number, warn = false) => { ctx.practice.note = { title, text, until: performance.now() + ms, warn }; };

/** Keep the flight as it is now (the worker answers with where, see onPracticeMessage). */
export function markPoint(ctx: AppCtx) {
  if (ctx.replay || ctx.menuOpen) return;
  ctx.send({ type: 'practice', op: 'mark' });
}

/**
 * Fly back to the point. The lap in progress doesn't count (as after a respawn) and the gate to fly
 * next is the one it was then; a toggle arm switch is put back as it was then, so the pilot is flying
 * again at once (a radio's switch stays where it is: Betaflight follows it).
 */
export function recallPoint(ctx: AppCtx, onJump: () => void) {
  if (ctx.replay || ctx.menuOpen) return;
  const pt = ctx.practice.point;
  if (!pt) { note(ctx, 'NO PRACTICE POINT YET', `${actionGlyph(ctx, 'markPoint')} keeps the flight as it is, ${actionGlyph(ctx, 'recallPoint')} flies back to it.`, 2600, true); return; }
  onJump();
  ctx.race.lapStart = -1; ctx.race.nextGate = pt.nextGate;
  ctx.input.setArmed(pt.armed);
  ctx.send({ type: 'practice', op: 'recall' });
}

/** The worker's answer to a request. */
export function onPracticeMessage(ctx: AppCtx, m: Extract<FromWorker, { type: 'practice' }>) {
  if (m.op === 'mark') {
    if (!m.ok || !m.pos) { note(ctx, 'NO PRACTICE POINT', m.reason ?? 'It could not be kept here.', 3500, true); return; }
    ctx.practice.point = { ...m.pos, yawDeg: m.yawDeg ?? 0, armed: !!m.armed, nextGate: ctx.race.nextGate };
    note(ctx, 'PRACTICE POINT SET', `${actionGlyph(ctx, 'recallPoint')} flies back to this moment, as often as you like.`, 2200);
  } else if (m.ok) note(ctx, 'BACK TO THE POINT', '', 900);
  else { ctx.practice.point = null; note(ctx, 'NO PRACTICE POINT YET', m.reason ?? '', 2600, true); }
}

/** Telemetry says the worker no longer keeps it (another quad, map, firmware reboot or configuration). */
export function onPracticeTelemetry(ctx: AppCtx, kept: boolean | undefined) {
  if (kept || !ctx.practice.point) return;
  ctx.practice.point = null;
  note(ctx, 'PRACTICE POINT CLEARED', 'The quad, map or flight controller setup changed: set a new one.', 3000, true);
}
