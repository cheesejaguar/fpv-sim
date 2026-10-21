// Device-agnostic controller input -> 16 RC channels (µs, AETR + AUX), like a radio's mixer.
// Works with any HID gamepad/joystick the browser exposes via the Gamepad API (USB or Bluetooth):
// Xbox and PlayStation 5 DualSense pads (W3C "standard" mapping), the 2026 Steam Controller
// (direct WebHID driver), RC radios in USB-joystick mode such as the DJI FPV Remote Controller 3
// ("DJI Virtual Joystick", USB 2ca3:1021), and generic HID joysticks.

import { SteamHidController } from './steamHid';

export type ThrottleMode = 'full' | 'upper' | 'trigger';

/** AUX2 flight mode index (Betaflight ranges here: 1000 acro, 1500 horizon, 2000 angle). */
export const MODE_ACRO = 0, MODE_HORIZON = 1, MODE_ANGLE = 2;
/** New pilots start self-levelling: Quick fly and the guide both say "arm in Angle". */
export const FIRST_MODE = MODE_ANGLE;

export interface AxisBind {
  src: 'axis' | 'button' | 'none';
  index: number;
  invert: boolean;
  min: number; center: number; max: number; // calibration (raw)
  deadzone: number;  // fraction of half-range (radial per stick on standard pads)
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

/**
 * AUX5-AUX12 (CH9-16), for extra Betaflight modes (prearm, launch control, acro trainer, VTX pit
 * mode …; the pilot assigns them in Betaflight with `aux` ranges).
 *  hold / toggle : button, or 2-position switch on an axis -> 1000 / 2000 µs
 *  switch3       : 3-position switch on an axis -> 1000 / 1500 / 2000
 *  axis          : proportional (pot, slider, analog trigger) -> 1000..2000
 */
export interface AuxBind { src: 'button' | 'axis'; index: number; invert?: boolean; mode: 'hold' | 'toggle' | 'switch3' | 'axis' }
export const AUX_EXTRA = 8; // AUX5..AUX12

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
  kind?: ControllerKind; // button layout family (names); 'generic' unless the browser reports the standard mapping
  needsSetup?: boolean;  // stick order unknown: prompt the radio setup wizard
  /** Gamepad sticks move in a round gate, so full roll + full pitch together only reach ~0.7 each:
   *  stretch the circle to the square a radio gimbal covers. Missing: on for standard pads, off for radios. */
  circleToSquare?: boolean;
  /** AUX5..AUX12 ([0] = AUX5 = CH9). Unbound channels stay centred (1500). */
  aux?: (AuxBind | null)[];
  /** RC transmitter in USB-joystick mode (EdgeTX / OpenTX): its axes already are the model's mixed
   *  channels, so send axis i straight to CH i+1 (the radio's own switches, ranges and order). */
  passthrough?: boolean;
}

const ax = (index: number, invert = false): AxisBind => ({ src: 'axis', index, invert, min: -1, center: 0, max: 1, deadzone: 0.02, expo: 0 });

/** Mode 2, standard mapping (XInput / Steam Input / DualSense in Chrome & Edge). */
const STANDARD_NAME = 'Standard gamepad (Mode 2)';
export function standardProfile(id = '', name = STANDARD_NAME): InputProfile {
  return {
    id, name,
    yaw: ax(0), throttle: ax(1, true), roll: ax(2), pitch: ax(3, true),
    // the throttle stick springs back to centre: centre = idle, so letting go never leaves 50 % (≈2× hover)
    throttleMode: 'upper', circleToSquare: true,
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
    throttleMode: 'full', circleToSquare: false,
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
  return { ...standardProfile(id, 'Generic HID joystick (AETR axes)'), roll: ax(0), pitch: ax(1, true), throttle: ax(2, true), yaw: ax(3), throttleMode: 'full', circleToSquare: false };
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

/**
 * RC radios and flight joysticks: ExpressLRS in BLE joystick mode ("ELRS Joystick"), EdgeTX / OpenTX
 * radios over USB ("<radio> Joystick"), TBS / FrSky / RadioMaster / Jumper transmitters. Their axes
 * are RC channels in the radio's (and the receiver firmware's) own order, and switches rest at an
 * end, even where the browser labels the device with the standard gamepad mapping (macOS can).
 * Gamepad presets, stick geometry and menu stick navigation must never apply to them.
 */
const RADIO_ID = /elrs|expresslrs|edgetx|opentx|frsky|taranis|radiomaster|jumper|tbs|crossfire|joystick/i;
export const isRadio = (pad: { id: string }) => RADIO_ID.test(pad.id) && controllerKind(pad) !== 'dji';

/** Button / axis indices follow the W3C standard layout (a real gamepad in the browser's standard
 *  mapping, or our WebHID driver), not a radio the browser happens to label "standard". */
export const isStandard = (pad: { mapping: string; id: string }) => pad.mapping === 'standard' && !isRadio(pad);

export function guessProfile(pad: Gamepad): InputProfile {
  const kind = controllerKind(pad);
  if (kind === 'dji') return djiRc3Profile(pad.id);
  // Vendor presets assume the standard layout. Without it (Firefox on Linux, some Safari mappings,
  // radios, joysticks) indices are the driver's raw order: sticks would be mis-mapped, so start
  // generic and ask for the stick setup. A known gamepad family keeps its self-centring throttle.
  if (!isStandard(pad)) {
    const p: InputProfile = { ...genericJoystickProfile(pad.id), kind: 'generic', needsSetup: true };
    if (isRadio(pad)) {
      // as on the real quad: Betaflight's deadband is 0, the radio's own calibration centres the sticks
      p.name = 'RC radio (set up its channels)';
      for (const k of ['roll', 'pitch', 'yaw', 'throttle'] as const) p[k] = { ...p[k], deadzone: 0, expo: 0 };
    } else if (kind !== 'generic') { p.name = 'Gamepad, non-standard browser mapping'; p.throttleMode = 'upper'; }
    return p;
  }
  switch (kind) {
    case 'xbox': return xboxProfile(pad.id);
    case 'playstation': return ps5Profile(pad.id);
    case 'steam':
      if (pad.id.toLowerCase().includes('webhid')) return { ...standardProfile(pad.id, 'Steam Controller 2026 via WebHID (Mode 2)'), kind: 'steam' }; // real sticks
      return { ...steamControllerProfile(pad.id), kind: 'steam' };
  }
  return standardProfile(pad.id);
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
export function bindActive(pad: Gamepad, b: { index: number; src?: 'button' | 'axis'; invert?: boolean }): boolean {
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

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Calibrated -1..1, before inversion / deadzone / expo. */
function calibrated(pad: Gamepad, b: AxisBind): number {
  const raw = readRaw(pad, b);
  return clamp1(raw >= b.center ? (raw - b.center) / Math.max(1e-6, b.max - b.center) : (raw - b.center) / Math.max(1e-6, b.center - b.min));
}

/** Inversion, then a 1-D deadzone (unless the stick pair already applied a radial one), then expo. */
function shape(v: number, b: AxisBind, dzDone: boolean): number {
  if (b.invert) v = -v;
  const dz = b.deadzone;
  if (!dzDone) { if (Math.abs(v) < dz) v = 0; else v = Math.sign(v) * (Math.abs(v) - dz) / (1 - dz); }
  if (b.expo > 0) v = v * (1 - b.expo) + v * v * v * b.expo;
  return v;
}

/** Calibrated bipolar value -1..1 (single axis, per-axis deadzone). */
export function bipolar(pad: Gamepad, b: AxisBind): number {
  return shape(calibrated(pad, b), b, false);
}

/**
 * One physical stick: radial deadzone (a round dead spot, so small diagonal moves aren't snapped
 * onto an axis), then optionally the circular gate stretched to a square with the elliptical-grid
 * mapping: identity near centre and along the axes, full corners (0.707, 0.707) -> (1, 1).
 */
export function stick2d(x: number, y: number, dz: number, square: boolean): [number, number] {
  const r = Math.hypot(x, y);
  if (r <= dz || r < 1e-9) return [0, 0];
  const k = (Math.min(1, r) - dz) / (1 - dz) / r; // radius rescaled past the deadzone, gate clamped
  const u = x * k, v = y * k;
  if (!square) return [u, v];
  const s2 = 2 * Math.SQRT2, a = 2 + u * u - v * v, b = 2 - u * u + v * v;
  const sq = (t: number) => Math.sqrt(Math.max(0, t));
  return [clamp1(0.5 * sq(a + s2 * u) - 0.5 * sq(a - s2 * u)), clamp1(0.5 * sq(b + s2 * v) - 0.5 * sq(b - s2 * v))];
}

/** Two bound axes on the same standard stick (0/1 left, 2/3 right; WebHID trackpads 4/5, 6/7). */
const sameStick = (a: AxisBind, b: AxisBind) => a.src === 'axis' && b.src === 'axis' && a.index !== b.index && a.index >> 1 === b.index >> 1;

/** Square sticks on? Saved profiles from before the option: on for standard pads, off for radios. */
export function squareSticks(pad: { mapping: string; id: string }, p: InputProfile): boolean {
  return p.circleToSquare ?? (isStandard(pad) && p.kind !== 'dji');
}

export interface Sticks { roll: number; pitch: number; yaw: number; throttle: number } // -1..1 each

const CHANNELS = ['roll', 'pitch', 'yaw', 'throttle'] as const;

/** Stick values after calibration, stick geometry (standard pads), inversion, deadzone and expo. */
export function readSticks(pad: Gamepad, p: InputProfile): Sticks {
  const v = CHANNELS.map((n) => calibrated(pad, p[n]));
  const paired = [false, false, false, false];
  // which axes share a stick is only known on the standard layout; radios keep per-axis processing
  if (isStandard(pad)) {
    const square = squareSticks(pad, p);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const a = p[CHANNELS[i]], b = p[CHANNELS[j]];
      if (paired[i] || paired[j] || !sameStick(a, b)) continue;
      [v[i], v[j]] = stick2d(v[i], v[j], Math.max(a.deadzone, b.deadzone), square);
      paired[i] = paired[j] = true;
    }
  }
  const out = {} as Sticks;
  CHANNELS.forEach((n, i) => { out[n] = shape(v[i], p[n], paired[i]); });
  return out;
}

/** Output of an AUX5-12 binding in µs (toggle state supplied by the caller). */
export function auxMicros(pad: Gamepad, b: AuxBind, toggled = false): number {
  if (b.mode === 'toggle') return toggled ? 2000 : 1000;
  if (b.src === 'axis') {
    const v = clamp1((pad.axes[b.index] ?? 0) * (b.invert ? -1 : 1));
    if (b.mode === 'axis') return 1500 + 500 * v;
    if (b.mode === 'switch3') return v < -0.33 ? 1000 : v > 0.33 ? 2000 : 1500;
    return v > 0.5 ? 2000 : 1000;
  }
  const raw = Math.max(0, Math.min(1, pad.buttons[b.index]?.value ?? 0)), val = b.invert ? 1 - raw : raw;
  if (b.mode === 'axis') return 1000 + 1000 * val; // analog trigger
  return bindActive(pad, b) !== !!b.invert ? 2000 : 1000;
}

export class InputManager {
  profiles: Record<string, InputProfile> = {};
  active: Gamepad | null = null;
  activeIndex = -1;
  readonly channels = new Float32Array(16).fill(1500);
  private prevButtons: boolean[] = [];
  armed = false; modeIdx = FIRST_MODE; turtle = false; beeper = false;
  private auxToggled: boolean[] = [];
  onReset: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onAction: ((a: SimAction) => void) | null = null;
  keyboard = new KeyboardInput();
  /** While a menu is open its buttons navigate it: no arming, mode / turtle changes or respawns. */
  get suspended() { return this.keyboard.suspended; }
  set suspended(on: boolean) { this.keyboard.suspended = on; if (on) this.disarm(); this.turtle = false; this.keyboard.turtle = false; }
  /** > 0 while the Controller tab listens to the pad (stick wizard, Detect, calibration): its buttons
   *  belong to that, so the menu button can't toggle the menu either. */
  capture = 0;
  lastRaw: { axes: number[]; buttons: number[] } = { axes: [], buttons: [] };

  constructor() {
    try { const s = localStorage.getItem('fpv-input-profiles'); if (s) this.profiles = JSON.parse(s); } catch { /* none */ }
    window.addEventListener('gamepadconnected', (e) => { const g = (e as GamepadEvent).gamepad; if (this.activeIndex < 0) this.activeIndex = g.index; });
    window.addEventListener('gamepaddisconnected', (e) => { if ((e as GamepadEvent).gamepad.index === this.activeIndex) this.activeIndex = -1; });
  }
  save() { try { localStorage.setItem('fpv-input-profiles', JSON.stringify(this.profiles)); } catch { /* ignore */ } }

  /** Direct WebHID driver for the 2026 Steam Controller (invisible to the Gamepad API). */
  steamHid = new SteamHidController();

  /** Connected pads, the one in use first (menu navigation falls back to the first pad). */
  pads(): Gamepad[] {
    const list = (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g);
    const h = this.steamHid.current();
    if (h) list.unshift(h as unknown as Gamepad);
    const i = list.findIndex((g) => g.index === this.activeIndex);
    if (i > 0) list.unshift(...list.splice(i, 1));
    return list;
  }
  profileFor(pad: Gamepad): InputProfile {
    let p = this.profiles[pad.id];
    if (!p) { p = guessProfile(pad); this.profiles[pad.id] = p; this.save(); return p; }
    if (isStandard(pad)) {
      // profiles saved before `kind` existed: identify the family now, so button names (A / B / RB …)
      // show instead of raw indices
      if (!p.kind) { const k = controllerKind(pad); if (k !== 'generic') { p.kind = k; this.save(); } }
    } else if (p.kind === 'xbox' || p.kind === 'playstation' || p.kind === 'steam') {
      // saved from a vendor preset on a non-standard mapping: names and sticks don't match the layout
      p.kind = 'generic'; p.needsSetup ??= true; this.save();
    } else if (isRadio(pad) && p.needsSetup === undefined && p.name === STANDARD_NAME) {
      // a radio the browser labels "standard" was given the Xbox-style preset before radios were
      // recognised (its arm switch became roll): start over with the setup prompt
      p = guessProfile(pad); this.profiles[pad.id] = p; this.save();
    }
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
    let p: InputProfile | null = null;
    if (pad) {
      this.lastRaw = { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value) };
      p = this.profileFor(pad);
    }
    // a radio whose channel order isn't set up yet: any guess could put a switch on throttle or roll,
    // so it flies nothing (the keyboard still does) until the setup or "My sticks already work"
    this.blocked = !!pad && !!p?.needsSetup && isRadio(pad);
    if (this.blocked) p = null;
    if (pad && p) {
      const s = readSticks(pad, p);
      let thr: number;
      if (p.throttleMode === 'trigger') thr = Math.max(0, Math.min(1, readRaw(pad, p.throttle)));
      else thr = p.throttleMode === 'upper' ? Math.max(0, s.throttle) : (s.throttle + 1) / 2;
      ch[0] = 1500 + s.roll * 500; ch[1] = 1500 + s.pitch * 500; ch[2] = 1000 + thr * 1000; ch[3] = 1500 + s.yaw * 500;
      this.buttons(pad, p);
    } else {
      this.keyboard.update(ch);
      this.armed = this.keyboard.armed; this.modeIdx = this.keyboard.modeIdx; this.turtle = this.keyboard.turtle;
    }
    ch[4] = this.armed ? 1900 : 1000;
    ch[5] = [1000, 1500, 2000][this.modeIdx];
    ch[6] = this.turtle ? 2000 : 1000;
    ch[7] = this.beeper ? 2000 : 1000;
    for (let i = 0; i < AUX_EXTRA; i++) {
      const b = p?.aux?.[i];
      ch[8 + i] = pad && b ? auxMicros(pad, b, this.auxToggled[i]) : 1500;
    }
    if (pad && p?.passthrough) this.passthrough(pad);
    return ch;
  }

  /** The active pad is a radio waiting for its stick setup (its sticks are ignored meanwhile). */
  blocked = false;

  /**
   * Menu navigation for pads off the standard layout (radios, joysticks): their set-up roll and pitch
   * (right stick on a Mode 2 radio), calibrated so a centred stick reads 0. Never raw axes, where a
   * throttle or switch rests at an end. Null before the setup, and for standard pads (raw sticks).
   */
  navStick(pad: Gamepad): [number, number] | null {
    if (isStandard(pad)) return null;
    const p = this.profileFor(pad);
    if (p.needsSetup) return null;
    const s = readSticks(pad, p);
    return [s.roll, -s.pitch]; // screen y grows downward: pitch forward = up
  }

  /** Radio passthrough: axis i -> CH i+1 as the radio mixed it. Arming still drops while suspended. */
  private passthrough(pad: Gamepad) {
    const ch = this.channels, n = Math.min(16, pad.axes.length);
    for (let i = 0; i < n; i++) ch[i] = 1500 + 500 * clamp1(pad.axes[i] ?? 0);
    if (n > 4 && this.suspended) ch[4] = 1000;
    if (n > 4) this.armed = ch[4] > 1700;
    if (n > 5) this.modeIdx = ch[5] < 1300 ? MODE_ACRO : ch[5] < 1700 ? MODE_HORIZON : MODE_ANGLE;
  }

  private prevBind: Record<string, boolean> = {};
  private buttons(pad: Gamepad, p: InputProfile) {
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i: number | null | undefined) => i != null && pressed[i] && !this.prevButtons[i];
    const act = (key: string, b: ButtonBind | AuxBind | null | undefined) => {
      if (!b) return { on: false, rise: false };
      const on = bindActive(pad, b), rise = on && !this.prevBind[key];
      this.prevBind[key] = on;
      return { on, rise };
    };
    const arm = act('arm', p.arm), mode = act('mode', p.mode), turtle = act('turtle', p.turtle), beep = act('beeper', p.beeper);
    const aux = Array.from({ length: AUX_EXTRA }, (_, i) => { const b = p.aux?.[i]; return b?.mode === 'toggle' ? act(`aux${i}`, b) : null; });
    if (this.suspended) {
      if (!this.capture && edge(p.menu)) this.onMenu?.();
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
    aux.forEach((a, i) => { if (a?.rise) this.auxToggled[i] = !this.auxToggled[i]; });
    if (edge(p.reset)) { this.armed = false; this.turtle = false; this.onReset?.(); }
    for (const [a, b] of Object.entries(this.actionButtons(pad, p))) if (edge(b)) this.onAction?.(a as SimAction);
    if (edge(p.menu)) this.onMenu?.();
    this.prevButtons = pressed;
  }

  /** Button for each sim action on this pad (none on radios / unmapped joysticks). */
  actionButtons(pad: { mapping: string; id: string }, p: InputProfile): Partial<Record<SimAction, number>> {
    const std = isStandard(pad) || p.kind === 'steam' || p.kind === 'xbox' || p.kind === 'playstation';
    const binds: ({ index: number; src?: string } | null | undefined)[] = [p.arm, p.mode, p.turtle, p.beeper, ...(p.aux ?? [])];
    const taken = new Set(binds.filter((b) => b && (b.src ?? 'button') === 'button').map((b) => b!.index).concat([p.reset, p.menu].filter((x): x is number => x != null)));
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
  thr = 0; armed = false; modeIdx = FIRST_MODE; turtle = false;
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
