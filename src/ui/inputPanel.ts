// Controller setup: device list, live raw axes/buttons, preset profiles, throttle mode, per-channel
// axis assignment by "move the stick", inversion, calibration and deadzones.
import { AxisBind, InputManager, InputProfile, PRESET_PROFILES, ThrottleMode } from '../input/gamepad';
import { checkbox, el, section, select, slider } from './dom';

export function inputPanel(im: InputManager): HTMLElement {
  const root = el('div', { class: 'panel input' });
  const live = el('div', { class: 'live' });
  const chans = el('div', { class: 'chans' });
  let calibrating: { min: number[]; max: number[] } | null = null;
  let detecting: { ch: 'roll' | 'pitch' | 'yaw' | 'throttle'; base: number[] } | null = null;
  const detectMsg = el('div', { class: 'status' });

  const render = () => {
    const pad = im.active;
    const help = section('Steam Controller on Windows',
      el('ol', {},
        el('li', {}, 'Keep Steam running. In Steam → Settings → Controller, set the Desktop Layout to "Gamepad" (or add your browser as a non-Steam game and pick the "Gamepad" template).'),
        el('li', {}, 'Set the right trackpad to "Joystick Move" (absolute) so it acts as the right stick, with low smoothing.'),
        el('li', {}, 'Press any button with this page focused: browsers only expose a controller after the first input.'),
        el('li', {}, 'Throttle sticks spring to the centre on gamepads. Pick a throttle mode below: full range (centre = 50%), upper half only, or the analog right trigger.'),
      ));
    const hidSec = section('Steam Controller (2026) — direct USB / wireless puck',
      el('p', {}, 'The 2026 Steam Controller is invisible to the browser Gamepad API (outside Steam it pretends to be a keyboard and mouse). The simulator can drive it directly over WebHID using Valve’s protocol (from SDL). Quit Steam completely first, since it holds the controller.'),
      el('button', { class: 'primary', onclick: async () => { await im.steamHid.request(); render(); } }, 'Connect Steam Controller'),
      el('div', { class: 'status' }, im.steamHid.status));
    if (!pad) {
      root.replaceChildren(hidSec, section('No controller detected', el('p', {}, 'Connect a USB/Bluetooth controller and press a button. Keyboard fallback: W/S throttle, A/D yaw, arrows pitch/roll, Space arm, 1/2/3 acro/horizon/angle, T turtle, R reset.')), help);
      return;
    }
    const p = im.profileFor(pad);
    const save = () => im.setProfile(pad, p);
    const axisRow = (name: 'roll' | 'pitch' | 'yaw' | 'throttle') => {
      const b: AxisBind = p[name];
      return el('div', { class: 'axisrow' },
        el('b', {}, name),
        select('source', [{ value: 'axis', label: 'axis' }, { value: 'button', label: 'analog button' }], b.src as 'axis' | 'button', (v) => { b.src = v; save(); }),
        select('index', Array.from({ length: Math.max(pad.axes.length, pad.buttons.length) }, (_, i) => ({ value: String(i), label: String(i) })), String(b.index), (v) => { b.index = +v; save(); }),
        checkbox('invert', b.invert, (v) => { b.invert = v; save(); }),
        el('button', { onclick: () => { detecting = { ch: name, base: [...pad.axes] }; detectMsg.textContent = `Move the stick for ${name.toUpperCase()} fully…`; } }, 'Detect'),
        slider({ label: 'deadzone', min: 0, max: 0.2, step: 0.005, value: b.deadzone, onInput: (v) => { b.deadzone = v; save(); } }).row,
        slider({ label: 'expo', min: 0, max: 1, step: 0.01, value: b.expo, onInput: (v) => { b.expo = v; save(); } }).row,
      );
    };
    root.replaceChildren(
      el('div', { class: 'cols' },
        el('div', { class: 'col' },
          section('Device',
            select('Active controller', im.pads().map((g) => ({ value: String(g.index), label: `${g.index}: ${g.id}` })), String(pad.index), (v) => { im.activeIndex = +v; render(); }),
            el('p', { class: 'note' }, `mapping: ${pad.mapping || 'non-standard'} · ${pad.axes.length} axes · ${pad.buttons.length} buttons`),
            select('Load preset profile', [{ value: '', label: '— choose —' }, { value: 'steam', label: 'Steam Controller (Mode 2)' }, { value: 'standard', label: 'Standard gamepad (Mode 2)' }, { value: 'trigger', label: 'Gamepad, trigger throttle' }, { value: 'joystick', label: 'Generic HID joystick (AETR)' }], '', (v) => { if (v) { im.setProfile(pad, (PRESET_PROFILES as any)[v](pad.id) as InputProfile); render(); } }),
            select('Throttle mode', [{ value: 'full', label: 'Full stick range (centre = 50%)' }, { value: 'upper', label: 'Upper half only (centre = 0%)' }, { value: 'trigger', label: 'Analog trigger' }], p.throttleMode, (v: ThrottleMode) => { p.throttleMode = v; if (v === 'trigger' && p.throttle.src !== 'button') { p.throttle = { ...p.throttle, src: 'button', index: 7, min: 0, center: 0, max: 1, invert: false }; } save(); render(); }),
          ),
          section('Stick assignment', axisRow('throttle'), axisRow('yaw'), axisRow('pitch'), axisRow('roll'), detectMsg),
          section('Calibration',
            el('p', {}, 'Click Start, move every stick to all extremes (circles), let them return to centre, then click Finish.'),
            el('button', { onclick: () => { calibrating = { min: pad.axes.map(() => 1), max: pad.axes.map(() => -1) }; detectMsg.textContent = 'Calibrating… move all sticks to their extremes'; } }, 'Start'),
            el('button', { onclick: () => {
              if (!calibrating) return;
              for (const n of ['roll', 'pitch', 'yaw', 'throttle'] as const) {
                const b = p[n]; if (b.src !== 'axis') continue;
                b.min = calibrating.min[b.index]; b.max = calibrating.max[b.index]; b.center = pad.axes[b.index] ?? 0;
              }
              calibrating = null; save(); detectMsg.textContent = 'Calibration saved.'; render();
            } }, 'Finish'),
          ),
        ),
        el('div', { class: 'col' },
          section('Buttons',
            ...(['arm', 'mode', 'turtle', 'beeper'] as const).map((k) => select(`${k} button`, [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: `button ${i}` }))], String(p[k]?.index ?? -1), (v) => { p[k] = +v < 0 ? null : { index: +v, mode: k === 'mode' ? 'cycle3' : k === 'beeper' ? 'hold' : (p[k]?.mode ?? 'toggle') }; save(); })),
            select('arm behaviour', [{ value: 'toggle', label: 'toggle' }, { value: 'hold', label: 'hold (dead-man)' }], (p.arm?.mode ?? 'toggle') as 'toggle' | 'hold', (v) => { if (p.arm) p.arm.mode = v; save(); }),
            select('reset / respawn button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: `button ${i}` }))], String(p.reset ?? -1), (v) => { p.reset = +v < 0 ? null : +v; save(); }),
            select('menu button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: `button ${i}` }))], String(p.menu ?? -1), (v) => { p.menu = +v < 0 ? null : +v; save(); }),
          ),
          section('Live raw input', live), section('RC channels sent to Betaflight', chans),
        ),
        el('div', { class: 'col' }, hidSec, help),
      ),
    );
  };

  const tick = () => {
    if (!root.isConnected) { requestAnimationFrame(tick); return; }
    const pad = im.active;
    if (pad) {
      if (calibrating) pad.axes.forEach((v, i) => { calibrating!.min[i] = Math.min(calibrating!.min[i], v); calibrating!.max[i] = Math.max(calibrating!.max[i], v); });
      if (detecting) {
        let best = -1, bd = 0.5;
        pad.axes.forEach((v, i) => { const d = Math.abs(v - detecting!.base[i]); if (d > bd) { bd = d; best = i; } });
        if (best >= 0) {
          const p = im.profileFor(pad);
          p[detecting.ch] = { ...p[detecting.ch], src: 'axis', index: best };
          im.setProfile(pad, p);
          detectMsg.textContent = `${detecting.ch} → axis ${best}`;
          detecting = null; render();
        }
      }
      live.replaceChildren(
        ...pad.axes.map((v, i) => el('div', { class: 'bar' }, el('span', {}, `axis ${i}`), el('i', { style: { width: `${((v + 1) / 2) * 100}%` } }), el('em', {}, v.toFixed(3)))),
        el('div', { class: 'btns' }, ...pad.buttons.map((b, i) => el('span', { class: b.pressed || b.value > 0.5 ? 'on' : '' }, b.value > 0 && b.value < 1 ? `${i}:${b.value.toFixed(2)}` : String(i)))),
      );
    }
    const names = ['Roll', 'Pitch', 'Throttle', 'Yaw', 'AUX1 arm', 'AUX2 mode', 'AUX3 turtle', 'AUX4 beeper'];
    chans.replaceChildren(...names.map((n, i) => el('div', { class: 'bar' }, el('span', {}, n), el('i', { style: { width: `${(im.channels[i] - 1000) / 10}%` } }), el('em', {}, im.channels[i].toFixed(0)))));
    requestAnimationFrame(tick);
  };
  render();
  requestAnimationFrame(tick);
  let lastCount = 0;
  setInterval(() => { const n = im.pads().length; if (n !== lastCount) { lastCount = n; render(); } }, 1000);
  return root;
}
