// Device-agnostic controller input -> 16 RC channels (µs, AETR + AUX), like a radio's mixer.
// Works with any HID gamepad/joystick the browser exposes via the Gamepad API (USB or Bluetooth):
// Xbox and PlayStation 5 DualSense pads (W3C "standard" mapping), the 2026 Steam Controller
// (direct WebHID driver), RC radios in USB-joystick mode such as the DJI FPV Remote Controller 3
// ("DJI Virtual Joystick", USB 2ca3:1021), and generic HID joysticks.

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

/**
 * A control bound to an action. Gamepads use buttons; RC radios often report their switches as
 * axes, so a binding can also read an axis (active when value > 0.5, or < -0.5 when inverted).
 *  toggle  : momentary button flips the state      hold    : active while pressed / switch on
 *  cycle3  : each press steps acro -> horizon -> angle
 *  switch3 : a 3-position switch on an axis selects acro / horizon / angle directly
 */
export interface ButtonBind { index: number; mode: 'toggle' | 'hold' | 'cycle3' | 'switch3'; src?: 'button' | 'axis'; invert?: boolean }

export type SimAction = 'battery' | 'camera' | 'telemetry' | 'drill' | 'spectrum';
/** Buttons free in flight on every standard-mapping pad (Xbox / DualSense / Steam Input / WebHID). */
export const STANDARD_ACTIONS: Record<SimAction, number> = { battery: 1, camera: 12, telemetry: 13, drill: 14, spectrum: 15 };

export type ControllerKind = 'xbox' | 'playstation' | 'steam' | 'dji' | 'generic';

export interface InputProfile {
  id: string;            // gamepad.id this profile was made for ('' = default)
  name: string;
  roll: AxisBind; pitch: AxisBind; yaw: AxisBind; throttle: AxisBind;
  throttleMode: ThrottleMode;
  arm: ButtonBind | null; mode: ButtonBind | null; turtle: ButtonBind | null; beeper: ButtonBind | null;
  reset: number | null;  // respawn button
  menu: number | null;
  /** Sim actions (standard gamepads: B new battery, D-pad camera / telemetry / drill / spectrum).
   *  Missing in profiles saved before they existed: the standard defaults apply. */
  actions?: Partial<Record<SimAction, number | null>>;
  kind?: ControllerKind;
  needsSetup?: boolean;  // stick order unknown: prompt the radio setup wizard
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

export function xboxProfile(id = ''): InputProfile {
  return { ...standardProfile(id, 'Xbox controller (Mode 2)'), kind: 'xbox' };
}

export function ps5Profile(id = ''): InputProfile {
  // DualSense in Chrome/Edge uses the standard mapping: ✕ 0, ○ 1, □ 2, △ 3, L1 4, R1 5, L2 6, R2 7
  return { ...standardProfile(id, 'PlayStation 5 DualSense (Mode 2)'), kind: 'playstation' };
}

/**
 * DJI FPV Remote Controller 3 in USB-joystick mode ("DJI Virtual Joystick"). Its axis order is not
 * documented, so start from the usual radio AETR order and flag the setup wizard, which detects
 * each stick, its direction and the arm / mode switches. Gimbals have no centre slop: no deadzone.
 */
export function djiRc3Profile(id = ''): InputProfile {
  const a = (i: number, inv = false): AxisBind => ({ ...ax(i, inv), deadzone: 0 });
  return {
    id, name: 'DJI FPV Remote Controller 3', kind: 'dji', needsSetup: true,
    roll: a(0), pitch: a(1, true), throttle: a(2, true), yaw: a(3),
    throttleMode: 'full',
    arm: { index: 0, mode: 'toggle' }, mode: { index: 1, mode: 'cycle3' }, turtle: null, beeper: null,
    reset: null, menu: null,
  };
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

export const PRESET_PROFILES = { xbox: xboxProfile, ps5: ps5Profile, dji: djiRc3Profile, standard: standardProfile, steam: steamControllerProfile, trigger: triggerThrottleProfile, joystick: genericJoystickProfile };

/** Identify the controller family from the browser's gamepad id string (name + USB vendor/product). */
export function controllerKind(pad: { id: string }): ControllerKind {
  const id = pad.id.toLowerCase();
  if (id.includes('2ca3') || id.includes('dji')) return 'dji';
  if (id.includes('webhid') || id.includes('steam') || id.includes('valve') || id.includes('28de')) return 'steam';
  if (id.includes('054c') || id.includes('dualsense') || id.includes('dualshock') || id.includes('playstation') || id.startsWith('wireless controller')) return 'playstation';
  if (id.includes('045e') || id.includes('xbox') || id.includes('xinput')) return 'xbox';
  return 'generic';
}

export function guessProfile(pad: Gamepad): InputProfile {
  switch (controllerKind(pad)) {
    case 'dji': return djiRc3Profile(pad.id);
    case 'xbox': return xboxProfile(pad.id);
    case 'playstation': return ps5Profile(pad.id);
    case 'steam':
      if (pad.id.toLowerCase().includes('webhid')) return { ...standardProfile(pad.id, 'Steam Controller 2026 via WebHID (Mode 2)'), kind: 'steam' }; // real sticks
      return { ...steamControllerProfile(pad.id), kind: 'steam' };
  }
  if (pad.mapping === 'standard') return standardProfile(pad.id);
  return { ...genericJoystickProfile(pad.id), needsSetup: true };
}

const STD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-up', 'D-down', 'D-left', 'D-right', 'Guide'];
const PS_NAMES = ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-up', 'D-down', 'D-left', 'D-right', 'PS', 'Touchpad'];
const STEAM_NAMES = [...STD_NAMES.slice(0, 16), 'Steam', 'QAM', 'L4', 'R4', 'L5', 'R5', 'L-pad click', 'R-pad click'];

/** Human name for a button index on this controller family. */
export function buttonName(kind: ControllerKind | undefined, i: number): string {
  const n = kind === 'playstation' ? PS_NAMES[i] : kind === 'steam' ? STEAM_NAMES[i] : kind === 'xbox' ? STD_NAMES[i] : undefined;
  return n ? `${n} (${i})` : `button ${i}`;
}

/** Is a bound control currently active (button pressed, or switch axis past half travel)? */
export function bindActive(pad: Gamepad, b: ButtonBind): boolean {
  if (b.src === 'axis') { const v = (pad.axes[b.index] ?? 0) * (b.invert ? -1 : 1); return v > 0.5; }
  const btn = pad.buttons[b.index];
  return !!btn && (btn.pressed || btn.value > 0.5);
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
  onAction: ((a: SimAction) => void) | null = null;
  keyboard = new KeyboardInput();
  /** While a menu is open its buttons navigate it: no arming, mode / turtle changes or respawns. */
  get suspended() { return this.keyboard.suspended; }
  set suspended(on: boolean) { this.keyboard.suspended = on; if (on) this.disarm(); this.turtle = false; this.keyboard.turtle = false; }
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

  private prevBind: Record<string, boolean> = {};
  private buttons(pad: Gamepad, p: InputProfile) {
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i: number | null | undefined) => i != null && pressed[i] && !this.prevButtons[i];
    const act = (key: string, b: ButtonBind | null) => {
      if (!b) return { on: false, rise: false };
      const on = bindActive(pad, b), rise = on && !this.prevBind[key];
      this.prevBind[key] = on;
      return { on, rise };
    };
    const arm = act('arm', p.arm), mode = act('mode', p.mode), turtle = act('turtle', p.turtle), beep = act('beeper', p.beeper);
    if (this.suspended) {
      if (edge(p.menu)) this.onMenu?.();
      this.prevButtons = pressed;
      return;
    }
    if (p.arm) { if (p.arm.mode === 'toggle') { if (arm.rise) this.armed = !this.armed; } else this.armed = arm.on; }
    if (p.mode) {
      if (p.mode.mode === 'switch3' && p.mode.src === 'axis') {
        const v = (pad.axes[p.mode.index] ?? 0) * (p.mode.invert ? -1 : 1);
        this.modeIdx = v < -0.33 ? 0 : v > 0.33 ? 2 : 1;
      } else if (p.mode.mode === 'hold') this.modeIdx = mode.on ? 2 : 0;
      else if (mode.rise) this.modeIdx = (this.modeIdx + 1) % 3;
    }
    if (p.turtle) { if (p.turtle.mode === 'toggle') { if (turtle.rise) this.turtle = !this.turtle; } else this.turtle = turtle.on; }
    if (p.beeper) this.beeper = beep.on;
    if (edge(p.reset)) { this.armed = false; this.turtle = false; this.onReset?.(); }
    for (const [a, b] of Object.entries(this.actionButtons(pad, p))) if (edge(b)) this.onAction?.(a as SimAction);
    if (edge(p.menu)) this.onMenu?.();
    this.prevButtons = pressed;
  }

  /** Button for each sim action on this pad (none on radios / unmapped joysticks). */
  actionButtons(pad: { mapping: string }, p: InputProfile): Partial<Record<SimAction, number>> {
    const std = pad.mapping === 'standard' || p.kind === 'steam' || p.kind === 'xbox' || p.kind === 'playstation';
    const taken = new Set([p.arm, p.mode, p.turtle, p.beeper].filter((b) => b && (b.src ?? 'button') === 'button').map((b) => b!.index).concat([p.reset, p.menu].filter((x): x is number => x != null)));
    const out: Partial<Record<SimAction, number>> = {};
    for (const a of Object.keys(STANDARD_ACTIONS) as SimAction[]) {
      const b = p.actions?.[a] !== undefined ? p.actions[a] : std && !p.needsSetup ? STANDARD_ACTIONS[a] : null;
      if (b != null && !taken.has(b)) out[a] = b;
    }
    return out;
  }

  /** Haptic feedback on pads that support it (Xbox, DualSense in Chrome/Edge). */
  rumbleEnabled = (() => { try { return localStorage.getItem('fpv-rumble') !== '0'; } catch { return true; } })();
  setRumble(on: boolean) { this.rumbleEnabled = on; try { localStorage.setItem('fpv-rumble', on ? '1' : '0'); } catch { /* ignore */ } }
  rumble(strong: number, weak: number, ms: number) {
    if (!this.rumbleEnabled) return;
    const act = (this.active as any)?.vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })?.catch?.(() => {});
  }

  disarm() { this.armed = false; this.keyboard.armed = false; }
}

/** Keyboard fallback (for testing without a controller): not a substitute for sticks. */
export class KeyboardInput {
  private keys = new Set<string>();
  thr = 0; armed = false; modeIdx = 0; turtle = false;
  suspended = false;
  private last = performance.now();
  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (this.suspended) return;
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
