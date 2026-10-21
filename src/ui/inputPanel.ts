// Controller setup: device list, live raw axes/buttons, preset profiles (Xbox, PS5, DJI FPV RC3,
// Steam Controller, generic), throttle mode, a guided stick/switch setup wizard, per-channel axis
// assignment, inversion, calibration, deadzones, button/switch bindings and rumble.
import { AxisBind, ButtonBind, buttonName, controllerKind, InputManager, InputProfile, PRESET_PROFILES, ThrottleMode } from '../input/gamepad';
import { RadioWizard, WIZARD_STEPS } from '../input/radioWizard';
import { webHidSupported } from '../input/steamHid';
import { checkbox, el, section, select, slider } from './dom';

export function inputPanel(im: InputManager): HTMLElement {
  const root = el('div', { class: 'panel input' });
  const live = el('div', { class: 'live' });
  const chans = el('div', { class: 'chans' });
  let calibrating: { min: number[]; max: number[] } | null = null;
  let detecting: { ch: 'roll' | 'pitch' | 'yaw' | 'throttle'; base: number[] } | null = null;
  let wiz: RadioWizard | null = null;
  const detectMsg = el('div', { class: 'status' });
  const wizBox = el('div', { class: 'wizard' });

  const renderWizard = () => {
    const pad = im.active;
    if (!pad) { wizBox.replaceChildren(); return; }
    if (!wiz) {
      const p = im.profileFor(pad);
      wizBox.replaceChildren(
        el('p', {}, p.needsSetup
          ? 'This controller’s stick layout isn’t standardised (RC radio / HID joystick). Run the setup once: it detects each stick, its direction and your arm / mode switches.'
          : 'Re-detect every stick, direction and switch by moving them one at a time.'),
        el('button', { class: 'primary', onclick: () => { wiz = new RadioWizard(im.profileFor(pad)); renderWizard(); } }, 'Start stick & switch setup'),
      );
      return;
    }
    const st = wiz.current;
    const n = WIZARD_STEPS.length - 1;
    wizBox.replaceChildren(
      el('div', { class: 'wiz-step' }, `Step ${Math.min(wiz.step + 1, n)} of ${n}`),
      el('p', { class: 'wiz-prompt' }, st.prompt),
      el('div', { class: 'status' }, wiz.message),
      el('div', { class: 'actions' },
        ...(wiz.finished
          ? [el('button', { class: 'primary', onclick: () => { im.setProfile(pad, wiz!.profile); wiz = null; render(); } }, 'Save & close')]
          : [
            !st.auto ? el('button', { class: 'primary', onclick: () => { wiz!.next(pad); renderWizard(); } }, 'Next') : null,
            st.optional ? el('button', { onclick: () => { wiz!.next(pad); renderWizard(); } }, 'Skip') : null,
            st.auto ? el('span', { class: 'note' }, 'Waiting for movement…') : null,
          ]),
        el('button', { onclick: () => { wiz = null; renderWizard(); } }, 'Cancel'),
      ),
    );
  };

  const render = () => {
    const pad = im.active;
    const notes = section('Controller notes',
      el('ul', {},
        el('li', {}, el('b', {}, 'Xbox (Series / One / 360) and PS5 DualSense: '), 'plug in by USB or pair over Bluetooth, then press a button with this page focused. They’re recognised automatically (Mode 2: left stick throttle/yaw, right stick pitch/roll; RB / R1 arms, LB / L1 changes flight mode, A / ✕ respawns, B / ○ fresh battery, D-pad ↑ camera, ↓ telemetry, ← hover drill, → noise spectrum). Crashes rumble the controller in Chrome and Edge.'),
        el('li', {}, el('b', {}, 'DJI FPV Remote Controller 3: '), 'power it on and connect its USB-C port to the computer; it appears as “DJI Virtual Joystick”. Move a stick, then run the stick & switch setup once. If its throttle springs back to centre, the “Full stick range” throttle mode treats centre as 50%; DJI’s manual describes adjusting the throttle stick for manual (M-mode) flying.'),
        el('li', {}, el('b', {}, 'Other RC radios (EdgeTX / OpenTX, USB joystick mode) and HID joysticks: '), 'same as the DJI radio — run the setup.'),
        el('li', {}, el('b', {}, 'Gamepad throttle: '), 'gamepad sticks spring to centre. Pick “Full stick range” (centre = 50%), “Upper half only”, or “Analog trigger”.'),
      ));
    const hidSec = section('Steam Controller (2026) — direct USB / wireless puck',
      el('p', {}, 'The 2026 Steam Controller is invisible to the browser Gamepad API (outside Steam it pretends to be a keyboard and mouse). The simulator drives it directly over WebHID using Valve’s protocol (from SDL). Quit Steam completely first, since it holds the controller.'),
      webHidSupported()
        ? el('button', { class: 'primary', onclick: async () => { await im.steamHid.request(); render(); } }, 'Connect Steam Controller')
        : el('p', { class: 'status' }, 'Not available in this browser: it has no WebHID (Safari and Firefox don’t implement it). Use Chrome or Edge for this controller; Xbox, PS5 and USB joysticks/radios work here.'),
      el('div', { class: 'status' }, im.steamHid.status));
    if (!pad) {
      root.replaceChildren(el('div', { class: 'cols' },
        el('div', { class: 'col' }, section('No controller detected', el('p', {}, 'Connect a controller and press a button (or move a stick) with this page focused. Keyboard fallback: W/S throttle, A/D yaw, arrows pitch/roll, Space arm, 1/2/3 acro/horizon/angle, T turtle, R reset.'))),
        el('div', { class: 'col' }, notes), el('div', { class: 'col' }, hidSec)));
      return;
    }
    const p = im.profileFor(pad);
    const kind = p.kind ?? controllerKind(pad);
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
    // bindings can be a button or a switch reported on an axis (common on RC radios)
    const bindOptions = [
      { value: 'none', label: 'none' },
      ...pad.buttons.map((_, i) => ({ value: `b${i}`, label: buttonName(kind, i) })),
      ...pad.axes.map((_, i) => ({ value: `a${i}`, label: `switch on axis ${i}` })),
      ...pad.axes.map((_, i) => ({ value: `A${i}`, label: `switch on axis ${i} (reversed)` })),
    ];
    const bindValue = (b: ButtonBind | null) => (!b ? 'none' : b.src === 'axis' ? `${b.invert ? 'A' : 'a'}${b.index}` : `b${b.index}`);
    const bindRow = (k: 'arm' | 'mode' | 'turtle' | 'beeper', modes: { value: ButtonBind['mode']; label: string }[]) => el('div', { class: 'axisrow' },
      select(k, bindOptions, bindValue(p[k]), (v) => {
        if (v === 'none') p[k] = null;
        else {
          const src = v[0] === 'b' ? 'button' : 'axis';
          const def: ButtonBind['mode'] = src === 'axis' ? (k === 'mode' ? 'switch3' : 'hold') : k === 'mode' ? 'cycle3' : k === 'beeper' ? 'hold' : 'toggle';
          p[k] = { index: +v.slice(1), src, invert: v[0] === 'A', mode: p[k]?.src === src ? p[k]!.mode : def };
        }
        save(); render();
      }),
      p[k] ? select('behaviour', modes, p[k]!.mode, (v) => { p[k]!.mode = v; save(); }) : null,
    );
    root.replaceChildren(
      el('div', { class: 'cols' },
        el('div', { class: 'col' },
          section('Device',
            select('Active controller', im.pads().map((g) => ({ value: String(g.index), label: `${g.index}: ${g.id}` })), String(pad.index), (v) => { im.activeIndex = +v; render(); }),
            el('p', { class: 'note' }, `${p.name} · mapping: ${pad.mapping || 'non-standard'} · ${pad.axes.length} axes · ${pad.buttons.length} buttons`),
            select('Load preset profile', [
              { value: '', label: '— choose —' },
              { value: 'xbox', label: 'Xbox controller (Mode 2)' }, { value: 'ps5', label: 'PlayStation 5 DualSense (Mode 2)' },
              { value: 'dji', label: 'DJI FPV Remote Controller 3' }, { value: 'steam', label: 'Steam Controller via Steam Input (Mode 2)' },
              { value: 'standard', label: 'Standard gamepad (Mode 2)' }, { value: 'trigger', label: 'Gamepad, trigger throttle' },
              { value: 'joystick', label: 'Generic HID joystick (AETR)' },
            ], '', (v) => { if (v) { im.setProfile(pad, (PRESET_PROFILES as any)[v](pad.id) as InputProfile); render(); } }),
            select('Throttle mode', [{ value: 'full', label: 'Full stick range (centre = 50%)' }, { value: 'upper', label: 'Upper half only (centre = 0%)' }, { value: 'trigger', label: 'Analog trigger' }], p.throttleMode, (v: ThrottleMode) => { p.throttleMode = v; if (v === 'trigger' && p.throttle.src !== 'button') { p.throttle = { ...p.throttle, src: 'button', index: 7, min: 0, center: 0, max: 1, invert: false }; } save(); render(); }),
            checkbox('Rumble on crashes (Xbox / DualSense, where the browser supports it)', im.rumbleEnabled, (v) => { im.setRumble(v); if (v) im.rumble(0.6, 0.6, 200); }),
          ),
          section('Stick & switch setup wizard', wizBox),
          section('Stick assignment', axisRow('throttle'), axisRow('yaw'), axisRow('pitch'), axisRow('roll'), detectMsg),
          section('Calibration',
            el('p', {}, 'Click Start, move every stick to all extremes (circles), centre roll / pitch / yaw, then click Finish.'),
            el('button', { onclick: () => { calibrating = { min: pad.axes.map(() => 1), max: pad.axes.map(() => -1) }; detectMsg.textContent = 'Calibrating… move all sticks to their extremes'; } }, 'Start'),
            el('button', { onclick: () => {
              if (!calibrating) return;
              for (const n of ['roll', 'pitch', 'yaw', 'throttle'] as const) {
                const b = p[n]; if (b.src !== 'axis') continue;
                b.min = calibrating.min[b.index]; b.max = calibrating.max[b.index];
                // throttle may not self-centre (radios): use mid-travel instead of its resting value
                b.center = n === 'throttle' ? (b.min + b.max) / 2 : pad.axes[b.index] ?? 0;
              }
              calibrating = null; save(); detectMsg.textContent = 'Calibration saved.'; render();
            } }, 'Finish'),
          ),
        ),
        el('div', { class: 'col' },
          section('Buttons & switches',
            bindRow('arm', [{ value: 'toggle', label: 'toggle (button)' }, { value: 'hold', label: 'switch / hold' }]),
            bindRow('mode', [{ value: 'cycle3', label: 'cycle acro → horizon → angle' }, { value: 'switch3', label: '3-position switch' }, { value: 'hold', label: '2-position: acro / angle' }]),
            bindRow('turtle', [{ value: 'toggle', label: 'toggle' }, { value: 'hold', label: 'switch / hold' }]),
            bindRow('beeper', [{ value: 'hold', label: 'hold' }, { value: 'toggle', label: 'toggle' }]),
            select('reset / respawn button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: buttonName(kind, i) }))], String(p.reset ?? -1), (v) => { p.reset = +v < 0 ? null : +v; save(); }),
            select('menu button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: buttonName(kind, i) }))], String(p.menu ?? -1), (v) => { p.menu = +v < 0 ? null : +v; save(); }),
          ),
          section('Live raw input', live), section('RC channels sent to Betaflight', chans),
        ),
        el('div', { class: 'col' }, notes, hidSec),
      ),
    );
    renderWizard();
  };

  const tick = () => {
    if (!root.isConnected) { requestAnimationFrame(tick); return; }
    const pad = im.active;
    if (pad) {
      const kind = im.profileFor(pad).kind ?? controllerKind(pad);
      if (wiz && wiz.update(pad)) renderWizard();
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
        el('div', { class: 'btns' }, ...pad.buttons.map((b, i) => el('span', { class: b.pressed || b.value > 0.5 ? 'on' : '', title: buttonName(kind, i) }, b.value > 0 && b.value < 1 ? `${buttonName(kind, i)}:${b.value.toFixed(2)}` : buttonName(kind, i)))),
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
