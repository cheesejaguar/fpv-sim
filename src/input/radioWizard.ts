// Guided stick / switch setup for controllers whose layout the browser doesn't standardise: RC radios
// in USB-joystick mode (DJI FPV Remote Controller 3, EdgeTX/OpenTX radios), HID joysticks, or any
// pad the pilot wants to remap. Each step asks for one movement and detects which axis (and which
// direction) or which button / switch responded, then records endpoints for calibration.
import type { AxisBind, ButtonBind, InputProfile } from './gamepad';

export type WizardStepKey = 'center' | 'throttle' | 'yaw' | 'pitch' | 'roll' | 'sweep' | 'arm' | 'mode' | 'done';

export interface WizardStep { key: WizardStepKey; prompt: string; auto: boolean; optional?: boolean }

export const WIZARD_STEPS: WizardStep[] = [
  { key: 'center', prompt: 'Centre the right stick and yaw, put the THROTTLE fully DOWN, leave every switch in its normal (off) position, then press Next.', auto: false },
  { key: 'throttle', prompt: 'Push the THROTTLE stick fully UP.', auto: true },
  { key: 'yaw', prompt: 'Push the YAW stick (left stick, sideways in Mode 2) fully RIGHT.', auto: true },
  { key: 'pitch', prompt: 'Push the PITCH stick (right stick in Mode 2) fully UP / forward.', auto: true },
  { key: 'roll', prompt: 'Push the ROLL stick (right stick, sideways) fully RIGHT.', auto: true },
  { key: 'sweep', prompt: 'Move BOTH sticks around their full range in circles a few times. Then centre roll, pitch and yaw, and press Next.', auto: false },
  { key: 'arm', prompt: 'Flip the switch (or press the button) you want to use to ARM. Then put it back to off.', auto: true },
  { key: 'mode', prompt: 'Optional: move the switch (or press the button) for FLIGHT MODE (acro / horizon / angle). Press Skip to keep the current setting.', auto: true, optional: true },
  { key: 'done', prompt: 'Done. Your mapping is saved for this controller. Check the RC channel bars, then arm and fly.', auto: false },
];

const MOVE = 0.6;      // axis travel (of 2.0 full scale) that counts as a deliberate movement
const LATCH_MS = 600;  // a button still held after this is a latching switch -> 'hold' binding

export class RadioWizard {
  step = 0;
  profile: InputProfile;
  message = '';
  private baseAxes: number[] = [];
  private baseButtons: boolean[] = [];
  private used = new Set<number>();
  private min: number[] = [];
  private max: number[] = [];
  private pending: { at: number; index: number } | null = null;

  constructor(profile: InputProfile) {
    this.profile = structuredClone(profile);
  }

  get current(): WizardStep { return WIZARD_STEPS[this.step]; }
  get finished(): boolean { return this.current.key === 'done'; }

  private snapshot(pad: Gamepad) {
    this.baseAxes = [...pad.axes];
    this.baseButtons = pad.buttons.map((b) => b.pressed || b.value > 0.5);
  }

  /** Advance (Next / Skip). Captures baselines and finalises calibration where needed. */
  next(pad: Gamepad): void {
    const key = this.current.key;
    if (key === 'center') { this.used.clear(); this.min = [...pad.axes]; this.max = [...pad.axes]; }
    if (key === 'sweep') this.finishCalibration(pad);
    if (key === 'done') return;
    this.step++;
    this.pending = null;
    this.snapshot(pad);
    if (this.current.key === 'done') this.profile.needsSetup = false;
  }

  private finishCalibration(pad: Gamepad) {
    for (const k of ['roll', 'pitch', 'yaw', 'throttle'] as const) {
      const b: AxisBind = this.profile[k];
      if (b.src !== 'axis') continue;
      const lo = this.min[b.index] ?? -1, hi = this.max[b.index] ?? 1;
      if (hi - lo < 0.5) continue; // stick not moved during the sweep: keep defaults
      b.min = lo; b.max = hi;
      // throttle has no reliable rest position (non-centring on radios): use mid-travel
      b.center = k === 'throttle' ? (lo + hi) / 2 : pad.axes[b.index] ?? (lo + hi) / 2;
    }
  }

  /** Feed the live pad every frame. Returns true when a step auto-completed. */
  update(pad: Gamepad, now = performance.now()): boolean {
    pad.axes.forEach((v, i) => { this.min[i] = Math.min(this.min[i] ?? v, v); this.max[i] = Math.max(this.max[i] ?? v, v); });
    const st = this.current;
    if (!st.auto) return false;
    if (st.key === 'throttle' || st.key === 'yaw' || st.key === 'pitch' || st.key === 'roll') {
      const hit = this.movedAxis(pad);
      if (!hit) return false;
      const b = this.profile[st.key];
      // positive bound value must mean: throttle up, yaw right, pitch forward, roll right
      this.profile[st.key] = { ...b, src: 'axis', index: hit.index, invert: hit.delta < 0, min: -1, center: 0, max: 1 };
      // a radio's throttle doesn't spring back: full travel. A standard gamepad keeps its (self-
      // centring) mode, unless it was the trigger, which this step just replaced with a stick
      if (st.key === 'throttle' && (pad.mapping !== 'standard' || this.profile.throttleMode === 'trigger')) this.profile.throttleMode = pad.mapping === 'standard' ? 'upper' : 'full';
      this.used.add(hit.index);
      this.message = `${st.key} → axis ${hit.index}${hit.delta < 0 ? ' (reversed)' : ''}`;
      this.next(pad);
      return true;
    }
    // arm / mode: a button or a switch reported as an axis
    const bk = st.key as 'arm' | 'mode';
    if (this.pending) {
      if (now - this.pending.at < LATCH_MS) return false;
      const held = !!(pad.buttons[this.pending.index]?.pressed || (pad.buttons[this.pending.index]?.value ?? 0) > 0.5);
      const bind: ButtonBind = st.key === 'arm'
        ? { index: this.pending.index, src: 'button', mode: held ? 'hold' : 'toggle' }
        : { index: this.pending.index, src: 'button', mode: held ? 'hold' : 'cycle3' };
      this.profile[bk] = bind;
      this.message = `${st.key} → button ${this.pending.index} (${bind.mode === 'hold' ? 'switch' : 'button'})`;
      this.next(pad);
      return true;
    }
    const bi = pad.buttons.findIndex((b, i) => (b.pressed || b.value > 0.5) && !this.baseButtons[i]);
    if (bi >= 0) { this.pending = { at: now, index: bi }; return false; }
    const hit = this.movedAxis(pad);
    if (hit) {
      // a switch on an axis: active when moved away from where it rested at the start of the step
      this.profile[bk] = bk === 'arm'
        ? { index: hit.index, src: 'axis', mode: 'hold', invert: hit.delta < 0 }
        : { index: hit.index, src: 'axis', mode: 'switch3', invert: hit.delta < 0 };
      this.used.add(hit.index);
      this.message = `${st.key} → switch on axis ${hit.index}`;
      this.next(pad);
      return true;
    }
    return false;
  }

  private movedAxis(pad: Gamepad): { index: number; delta: number } | null {
    let best: { index: number; delta: number } | null = null;
    pad.axes.forEach((v, i) => {
      if (this.used.has(i)) return;
      const d = v - (this.baseAxes[i] ?? 0);
      if (Math.abs(d) > MOVE && (!best || Math.abs(d) > Math.abs(best.delta))) best = { index: i, delta: d };
    });
    return best;
  }
}

/** Pad state to compare against when listening for "the control the pilot just used". */
export interface ControlBase { axes: number[]; buttons: boolean[] }
export const controlBase = (pad: Gamepad): ControlBase => ({ axes: [...pad.axes], buttons: pad.buttons.map((b) => b.pressed || b.value > 0.5) });

/** First control used since `base`: a newly pressed button, else the axis that moved most. */
export function detectControl(pad: Gamepad, base: ControlBase): { src: 'button'; index: number } | { src: 'axis'; index: number; delta: number; rest: number } | null {
  const bi = pad.buttons.findIndex((b, i) => (b.pressed || b.value > 0.5) && !base.buttons[i]);
  if (bi >= 0) return { src: 'button', index: bi };
  let best: { src: 'axis'; index: number; delta: number; rest: number } | null = null;
  pad.axes.forEach((v, i) => {
    const d = v - (base.axes[i] ?? 0);
    if (Math.abs(d) > MOVE && (!best || Math.abs(d) > Math.abs(best.delta))) best = { src: 'axis', index: i, delta: d, rest: base.axes[i] ?? 0 };
  });
  return best;
}
