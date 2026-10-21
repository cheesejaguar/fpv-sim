// Device-agnostic controller input -> 16 RC channels (µs, AETR + AUX), like a radio's mixer.
// Works with any HID gamepad/joystick the browser exposes via the Gamepad API (USB or Bluetooth):
// Steam Controller (through Steam Input as XInput), Xbox, DualSense, generic HID joysticks.

import { SteamHidController } from './steamHid';

export type ThrottleMode = 'full' | 'upper' | 'trigger';

export interface AxisBind {
  src: 'axis' | 'button' | 'none';
  index: number;
  invert: boolean;
  min: number; center: number; max: number; // calibration (raw)
  deadzone: number;  // fraction of half-range
  expo: number;      // 0..1 radio-side expo (normally 0; Betaflight rates do the shaping)
}

export interface ButtonBind { index: number; mode: 'toggle' | 'hold' | 'cycle3' }

export interface InputProfile {
  id: string;            // gamepad.id this profile was made for ('' = default)
  name: string;
  roll: AxisBind; pitch: AxisBind; yaw: AxisBind; throttle: AxisBind;
  throttleMode: ThrottleMode;
  arm: ButtonBind | null; mode: ButtonBind | null; turtle: ButtonBind | null; beeper: ButtonBind | null;
  reset: number | null;  // respawn button
  menu: number | null;
}

const ax = (index: number, invert = false): AxisBind => ({ src: 'axis', index, invert, min: -1, center: 0, max: 1, deadzone: 0.02, expo: 0 });

/** Mode 2, standard mapping (XInput / Steam Input / DualSense in Chrome & Edge). */
export function standardProfile(id = '', name = 'Standard gamepad (Mode 2)'): InputProfile {
  return {
    id, name,
    yaw: ax(0), throttle: ax(1, true), roll: ax(2), pitch: ax(3, true),
    throttleMode: 'full',
    arm: { index: 5, mode: 'toggle' },      // RB / R1
    mode: { index: 4, mode: 'cycle3' },     // LB / L1: acro -> horizon -> angle
    turtle: { index: 2, mode: 'toggle' },   // X / Square
    beeper: { index: 3, mode: 'hold' },     // Y / Triangle
    reset: 0,                               // A / Cross
    menu: 9,                                // Start / Options
  };
}

export function steamControllerProfile(id = ''): InputProfile {
  // Steam Controller via Steam Input "Gamepad" desktop config: left stick = stick, right trackpad
  // = right joystick (set it to "Joystick Move", absolute). Triggers are analog (buttons 6/7).
  const p = standardProfile(id, 'Steam Controller (Steam Input, Mode 2)');
  p.roll.deadzone = 0.0; p.pitch.deadzone = 0.0; // trackpad has no centre slop
  return p;
}

export function triggerThrottleProfile(id = ''): InputProfile {
  const p = standardProfile(id, 'Gamepad, right-trigger throttle');
  p.throttleMode = 'trigger';
  p.throttle = { src: 'button', index: 7, invert: false, min: 0, center: 0, max: 1, deadzone: 0, expo: 0 };
  return p;
}

export function genericJoystickProfile(id = ''): InputProfile {
  // Typical USB HID joystick/RC-style controller exposing 4+ axes in AETR order
  return { ...standardProfile(id, 'Generic HID joystick (AETR axes)'), roll: ax(0), pitch: ax(1, true), throttle: ax(2, true), yaw: ax(3), throttleMode: 'full' };
}

export const PRESET_PROFILES = { standard: standardProfile, steam: steamControllerProfile, trigger: triggerThrottleProfile, joystick: genericJoystickProfile };

export function guessProfile(pad: Gamepad): InputProfile {
  const id = pad.id.toLowerCase();
  if (id.includes('webhid')) return standardProfile(pad.id, 'Steam Controller 2026 via WebHID (Mode 2)'); // real sticks
  if (id.includes('steam') || id.includes('valve') || id.includes('28de')) return steamControllerProfile(pad.id);
  if (pad.mapping === 'standard') return standardProfile(pad.id);
  return genericJoystickProfile(pad.id);
}

// ---------------------------------------------------------------------------------------------

function readRaw(pad: Gamepad, b: AxisBind): number {
  if (b.src === 'axis') return pad.axes[b.index] ?? 0;
  if (b.src === 'button') return pad.buttons[b.index]?.value ?? 0;
  return 0;
}

/** Calibrated bipolar value -1..1 */
export function bipolar(pad: Gamepad, b: AxisBind): number {
  const raw = readRaw(pad, b);
  let v = raw >= b.center ? (raw - b.center) / Math.max(1e-6, b.max - b.center) : (raw - b.center) / Math.max(1e-6, b.center - b.min);
  v = Math.max(-1, Math.min(1, v));
  if (b.invert) v = -v;
  const dz = b.deadzone;
  if (Math.abs(v) < dz) v = 0; else v = Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
  if (b.expo > 0) v = v * (1 - b.expo) + v * v * v * b.expo;
  return v;
}

export class InputManager {
  profiles: Record<string, InputProfile> = {};
  active: Gamepad | null = null;
  activeIndex = -1;
  readonly channels = new Float32Array(16).fill(1500);
  private prevButtons: boolean[] = [];
  armed = false; modeIdx = 0; turtle = false; beeper = false;
  onReset: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  keyboard = new KeyboardInput();
  lastRaw: { axes: number[]; buttons: number[] } = { axes: [], buttons: [] };

  constructor() {
    try { const s = localStorage.getItem('fpv-input-profiles'); if (s) this.profiles = JSON.parse(s); } catch { /* none */ }
    window.addEventListener('gamepadconnected', (e) => { const g = (e as GamepadEvent).gamepad; if (this.activeIndex < 0) this.activeIndex = g.index; });
    window.addEventListener('gamepaddisconnected', (e) => { if ((e as GamepadEvent).gamepad.index === this.activeIndex) this.activeIndex = -1; });
  }
  save() { try { localStorage.setItem('fpv-input-profiles', JSON.stringify(this.profiles)); } catch { /* ignore */ } }

  /** Direct WebHID driver for the 2026 Steam Controller (invisible to the Gamepad API). */
  steamHid = new SteamHidController();

  pads(): Gamepad[] {
    const list = (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g);
    const h = this.steamHid.current();
    if (h) list.unshift(h as unknown as Gamepad);
    return list;
  }
  profileFor(pad: Gamepad): InputProfile {
    let p = this.profiles[pad.id];
    if (!p) { p = guessProfile(pad); this.profiles[pad.id] = p; this.save(); }
    return p;
  }
  setProfile(pad: Gamepad, p: InputProfile) { this.profiles[pad.id] = { ...p, id: pad.id }; this.save(); }

  /** Poll devices and update RC channels. Call every animation frame (and more often if possible). */
  poll(): Float32Array {
    const pads = this.pads();
    let pad = pads.find((g) => g.index === this.activeIndex) ?? null;
    if (!pad && pads.length) { pad = pads[0]; this.activeIndex = pad.index; }
    this.active = pad;
    const ch = this.channels;
    if (pad) {
      this.lastRaw = { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value) };
      const p = this.profileFor(pad);
      const roll = bipolar(pad, p.roll), pitch = bipolar(pad, p.pitch), yaw = bipolar(pad, p.yaw);
      let thr: number;
      if (p.throttleMode === 'trigger') thr = Math.max(0, Math.min(1, readRaw(pad, p.throttle)));
      else { const t = bipolar(pad, p.throttle); thr = p.throttleMode === 'upper' ? Math.max(0, t) : (t + 1) / 2; }
      ch[0] = 1500 + roll * 500; ch[1] = 1500 + pitch * 500; ch[2] = 1000 + thr * 1000; ch[3] = 1500 + yaw * 500;
      this.buttons(pad, p);
    } else {
      this.keyboard.update(ch);
      this.armed = this.keyboard.armed; this.modeIdx = this.keyboard.modeIdx; this.turtle = this.keyboard.turtle;
    }
    ch[4] = this.armed ? 1900 : 1000;
    ch[5] = [1000, 1500, 2000][this.modeIdx];
    ch[6] = this.turtle ? 2000 : 1000;
    ch[7] = this.beeper ? 2000 : 1000;
    for (let i = 8; i < 16; i++) ch[i] = 1500;
    return ch;
  }

  private buttons(pad: Gamepad, p: InputProfile) {
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i: number | null | undefined) => i != null && pressed[i] && !this.prevButtons[i];
    if (p.arm) { if (p.arm.mode === 'toggle') { if (edge(p.arm.index)) this.armed = !this.armed; } else this.armed = !!pressed[p.arm.index]; }
    if (p.mode && edge(p.mode.index)) this.modeIdx = (this.modeIdx + 1) % 3;
    if (p.turtle) { if (p.turtle.mode === 'toggle') { if (edge(p.turtle.index)) this.turtle = !this.turtle; } else this.turtle = !!pressed[p.turtle.index]; }
    if (p.beeper) this.beeper = !!pressed[p.beeper.index];
    if (edge(p.reset)) { this.armed = false; this.turtle = false; this.onReset?.(); }
    if (edge(p.menu)) this.onMenu?.();
    this.prevButtons = pressed;
  }

  disarm() { this.armed = false; this.keyboard.armed = false; }
}

/** Keyboard fallback (for testing without a controller): not a substitute for sticks. */
export class KeyboardInput {
  private keys = new Set<string>();
  thr = 0; armed = false; modeIdx = 0; turtle = false;
  private last = performance.now();
  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      this.keys.add(e.code);
      if (e.code === 'Space') { this.armed = !this.armed; e.preventDefault(); }
      if (e.code === 'Digit1') this.modeIdx = 0; if (e.code === 'Digit2') this.modeIdx = 1; if (e.code === 'Digit3') this.modeIdx = 2;
      if (e.code === 'KeyT') this.turtle = !this.turtle;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  update(ch: Float32Array) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    this.thr = Math.max(0, Math.min(1, this.thr + (k('KeyW') - k('KeyS')) * dt * 0.8));
    ch[2] = 1000 + this.thr * 1000;
    // Keys are on/off; slew the stick toward the target (~0.3 s to full) so it's not bang-bang.
    const slew = (cur: number, target: number) => { const s = dt / 0.3; return cur + Math.max(-s, Math.min(s, target - cur)); };
    this.yaw = slew(this.yaw, k('KeyD') - k('KeyA'));
    this.pitch = slew(this.pitch, k('ArrowUp') - k('ArrowDown'));
    this.roll = slew(this.roll, k('ArrowRight') - k('ArrowLeft'));
    ch[3] = 1500 + this.yaw * 350;
    ch[1] = 1500 + this.pitch * 350;
    ch[0] = 1500 + this.roll * 350;
  }
  private roll = 0; private pitch = 0; private yaw = 0;
  /** True once any key that drives a stick has been pressed (used to explain the fallback). */
  get used() { return this.keys.size > 0 || this.thr > 0; }
}
