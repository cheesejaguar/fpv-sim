// The pilot's view at the moment each personal best is set (for the "FPV moment" share card): the
// presented FPV frame with its OSD and goggle overlay, or the chase / line-of-sight view. Kept in
// memory for this session only, a few at most. Also remembers the newest personal best, which the
// pause menu offers to share. Part of the main bundle: keep it small (the share sheet is lazy).
import type { AppCtx } from '../app/context';
import { courseOf, pbKey } from '../app/leaderboard';
import { droneClass } from '../builder/droneClass';

export type ShotView = 'fpv' | 'chase' | 'los';
export interface PbShot { key: string; lapMs: number; canvas: HTMLCanvasElement; view: ShotView }
/** A personal best flown this session: its track, drone class and time. */
export interface PbRef { map: string; course: string; cls: string; lapMs: number }

const KEEP = 3, MAX_W = 1280;

export class PbShots {
  private shots: PbShot[] = [];
  private seen: unknown = null;
  private waiting = 0; // frames left to wait for the FPV picture
  /** the newest personal best of this session */
  last: PbRef | null = null;

  constructor(private ctx: AppCtx) {}

  /** After every frame: a new personal-best note on the HUD means that lap just finished. */
  afterFrame() {
    const ctx = this.ctx, n = ctx.lb.note;
    // waiting for the FPV picture: it comes within a few frames, unless the menu opened meanwhile
    if (this.waiting > 0 && --this.waiting === 0) ctx.fpv.onPresent = null;
    if (!n || n === this.seen) return;
    this.seen = n;
    if (n.kind !== 'pb') return;
    this.last = { map: ctx.map.id, course: courseOf(ctx.map), cls: droneClass(ctx.spec), lapMs: n.lapMs };
    const key = pbKey(this.last.map, this.last.course, this.last.cls), view = ctx.view.view;
    // the FPV picture is presented only when it changes: grab the next one. Spectator views were drawn this frame.
    if (view === 'fpv') {
      this.waiting = 30;
      ctx.fpv.onPresent = () => { ctx.fpv.onPresent = null; this.waiting = 0; this.grab(key, n.lapMs, 'fpv'); };
    } else this.grab(key, n.lapMs, view);
  }

  /** Copy the canvas now (same frame as its rendering, so the WebGL drawing buffer still holds it). */
  private grab(key: string, lapMs: number, view: ShotView) {
    const r = this.ctx.renderer, src = r.domElement, pr = r.getPixelRatio();
    const f = view === 'fpv' ? this.ctx.fpv.layout.frame : { x: 0, y: 0, w: src.clientWidth, h: src.clientHeight };
    const sx = f.x * pr, sy = f.y * pr, sw = Math.min(src.width - sx, f.w * pr), sh = Math.min(src.height - sy, f.h * pr);
    if (!(sw >= 16 && sh >= 16)) return;
    const s = Math.min(1, MAX_W / sw), c = document.createElement('canvas');
    c.width = Math.round(sw * s); c.height = Math.round(sh * s);
    try { c.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height); } catch { return; }
    this.shots = [...this.shots.filter((x) => x.key !== key), { key, lapMs, canvas: c, view }].slice(-KEEP);
  }

  /** The picture of this personal best, if it was set this session. */
  shot(key: string, lapMs: number): PbShot | undefined { return this.shots.find((s) => s.key === key && s.lapMs === lapMs); }
}
