// Controller setup: device list, live raw axes/buttons, preset profiles (Xbox, PS5, DJI FPV RC3,
// Steam Controller, generic), throttle mode and stick shape, a guided stick/switch setup wizard,
// per-channel axis assignment, inversion, calibration, deadzones, button/switch bindings for AUX1-12,
// radio passthrough and rumble. While the wizard, Detect or calibration listens to the pad, menu
// navigation is locked (nav.ts) so sweeping sticks or flipping switches can't move focus or leave.
import { AUX_EXTRA, AuxBind, AxisBind, ButtonBind, buttonName, controllerKind, genericJoystickProfile, InputManager, InputProfile, isStandard, PRESET_PROFILES, squareSticks, standardProfile, ThrottleMode } from '../input/gamepad';
import { ControlBase, controlBase, detectControl, RadioWizard, WIZARD_STEPS } from '../input/radioWizard';
import { webHidSupported } from '../input/steamHid';
import { checkbox, el, onUnmount, section, select, slider } from './dom';
import { focusEl, lockNav, NavLock, NavLockLevel } from './menu/nav';

type Ch = 'roll' | 'pitch' | 'yaw' | 'throttle';
const CH_NAMES = ['Roll', 'Pitch', 'Throttle', 'Yaw', 'AUX1 arm', 'AUX2 mode', 'AUX3 turtle', 'AUX4 beeper', ...Array.from({ length: AUX_EXTRA }, (_, i) => `AUX${i + 5}`)];
const LISTEN_MS = 10_000; // Detect gives up without movement: a pad user can't press Cancel meanwhile

/** Betaflight modes worth a spare switch; `aux` puts each on its channel (range 1700-2100 µs). */
const BF_MODES = [
  { name: 'PREARM', id: 36, aux: 5, why: 'arming needs this switch on first, so a bumped arm switch can’t start the motors' },
  { name: 'LAUNCH CONTROL', id: 49, aux: 6, why: 'holds the quad on the line until you punch out (race starts)' },
  { name: 'ACRO TRAINER', id: 47, aux: 7, why: 'acro with an angle limit: the step between Angle and full acro' },
  { name: 'VTX PIT MODE', id: 39, aux: 8, why: 'lowest video power on the bench (no VTX is simulated, so no effect here)' },
];

export function inputPanel(im: InputManager): HTMLElement {
  const root = el('div', { class: 'panel input' });
  const live = el('div', { class: 'live' });
  const chans = el('div', { class: 'chans' });
  let calibrating: { min: number[]; max: number[] } | null = null;
  let detecting: { ch: Ch; base: number[]; until: number } | null = null;
  let auxListen: { i: number; base: ControlBase; until: number } | null = null;
  let wiz: RadioWizard | null = null;
  const detectMsg = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const wizBox = el('div', { class: 'wizard' });
  let auxVals: HTMLElement[] = [];

  // --- pad capture: lock menu navigation while anything listens to the controller -------------
  let lock: NavLock | null = null;
  const syncLock = () => {
    const pad = im.active, std = !!pad && isStandard(pad);
    // where a step waits for an on-screen button, a standard pad keeps A / B; radios (switches on
    // buttons 0 / 1) and the listening steps lock everything
    const want: NavLockLevel | null = !pad ? null
      : detecting || auxListen ? 'all'
      : wiz ? (wiz.current.auto || !std ? 'all' : 'sticks')
      : calibrating ? (std ? 'sticks' : 'all') : null;
    if (want && !lock) { lock = lockNav(want); im.capture++; }
    else if (want && lock) lock.level = want;
    else if (!want && lock) { lock.release(); lock = null; im.capture = Math.max(0, im.capture - 1); }
  };
  const listening = () => !!(wiz || detecting || calibrating || auxListen);
  const cancelListening = () => { wiz = null; detecting = null; auxListen = null; calibrating = null; };

  // --- small builders: stable data-keys (focus survives re-renders), full accessible names, help -
  let uid = 0;
  const help = (...kids: (Node | string | null)[]) => el('div', { class: 'note', id: `inp-help-${++uid}` }, ...kids);
  const para = (...kids: (Node | string | null)[]) => el('p', { style: { margin: '4px 0' } }, ...kids);
  const describe = (c: Element, h?: HTMLElement) => { if (h) c.setAttribute('aria-describedby', h.id); };
  function sel<T extends string>(key: string, label: string, options: { value: T; label: string }[], value: T, on: (v: T) => void, o: { aria?: string; help?: HTMLElement } = {}): HTMLElement {
    const row = select(label, options, value, on), s = row.querySelector('select')!;
    s.dataset.key = key;
    if (o.aria) s.setAttribute('aria-label', o.aria);
    describe(s, o.help);
    return o.help ? el('div', {}, row, o.help) : row;
  }
  const chk = (key: string, label: string, value: boolean, on: (v: boolean) => void, o: { help?: HTMLElement; disabled?: boolean } = {}) => {
    const row = checkbox(label, value, on), c = row.querySelector('input')!;
    c.dataset.key = key; c.disabled = !!o.disabled;
    describe(c, o.help);
    return o.help ? el('div', {}, row, o.help) : row;
  };
  const btn = (key: string, label: string, onclick: () => void, o: { primary?: boolean; aria?: string } = {}) =>
    el('button', { class: o.primary ? 'primary' : '', 'data-key': key, 'aria-label': o.aria, onclick }, label);
  const ringed = () => !!(document.activeElement as HTMLElement | null)?.classList.contains('is-focus');
  /** Focus a control by key; with the controller / keyboard focus ring if the user had it. */
  const focusKey = (key: string, ring: boolean) => {
    const n = root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (n) { if (ring) focusEl(n); else n.focus({ preventScroll: true }); }
  };
  /** Rebuild the panel, keeping focus on the same control so a pad / keyboard user stays put. */
  const keepFocus = (build: () => void) => {
    const a = document.activeElement as HTMLElement | null;
    const key = a && root.contains(a) ? a.dataset.key : undefined, ring = ringed();
    build();
    if (key && document.activeElement !== a) focusKey(CSS.escape(key), ring);
  };

  const renderWizard = () => {
    const pad = im.active;
    const a = document.activeElement as HTMLElement | null, inWiz = !!a && wizBox.contains(a), ring = ringed();
    if (!pad) { wizBox.replaceChildren(); syncLock(); return; }
    if (!wiz) {
      const p = im.profileFor(pad);
      wizBox.replaceChildren(
        el('p', {}, p.needsSetup
          ? 'This controller’s stick layout isn’t known (RC radio, HID joystick, or a browser without the standard gamepad mapping). Run the setup once: it detects each stick, its direction and your arm / mode switches.'
          : 'Re-detect every stick, direction and switch by moving them one at a time.'),
        el('div', { class: 'actions' },
          btn('wiz-start', 'Start stick & switch setup', () => { wiz = new RadioWizard(im.profileFor(pad)); renderWizard(); }, { primary: true }),
          p.needsSetup ? btn('wiz-ok', 'My sticks already work', () => { p.needsSetup = false; im.setProfile(pad, p); render(); }) : null),
        ...(p.needsSetup ? [help('“My sticks already work” keeps the current mapping and stops the setup prompt.')] : []),
      );
      syncLock();
      if (inWiz) focusKey('wiz-start', ring);
      return;
    }
    const st = wiz.current;
    const n = WIZARD_STEPS.length - 1;
    const std = isStandard(pad);
    const primary = wiz.finished
      ? btn('wiz-save', 'Save & close', () => { const r = ringed(); im.setProfile(pad, wiz!.profile); wiz = null; render(); focusKey('wiz-start', r); }, { primary: true })
      : !st.auto ? btn('wiz-next', 'Next', () => { wiz!.next(pad); renderWizard(); }, { primary: true }) : null;
    wizBox.replaceChildren(
      el('div', { class: 'wiz-step' }, `Step ${Math.min(wiz.step + 1, n)} of ${n}`),
      el('p', { class: 'wiz-prompt', 'aria-live': 'polite' }, st.prompt),
      el('div', { class: 'status', role: 'status' }, wiz.message),
      el('div', { class: 'actions' },
        primary,
        st.optional ? btn('wiz-skip', 'Skip', () => { wiz!.next(pad); renderWizard(); }) : null,
        st.auto ? el('span', { class: 'note' }, 'Waiting for movement…') : null,
        btn('wiz-cancel', 'Cancel', () => { wiz = null; renderWizard(); }),
      ),
      help(std && !st.auto
        ? 'Controller: A presses the highlighted button, B leaves. Sticks and D-pad don’t move the menu during the setup.'
        : 'The controller doesn’t navigate the menu while the setup listens to it: use the mouse or keyboard (Tab, Enter, Esc) for these buttons.'),
    );
    syncLock();
    // keep a pad / keyboard user on the step's main button as steps advance by themselves
    if (inWiz || document.activeElement === document.body) focusKey(primary ? (primary.dataset.key ?? '') : 'wiz-cancel', ring);
  };

  const render = () => keepFocus(() => {
    const pad = im.active;
    const notes = section('Controller notes',
      el('ul', {},
        el('li', {}, el('b', {}, 'Xbox (Series / One / 360) and PS5 DualSense: '), 'plug in by USB or pair over Bluetooth, then press a button with this page focused. They’re recognized automatically (Mode 2: left stick throttle/yaw, right stick pitch/roll; RB / R1 arms, LB / L1 changes flight mode — you start in Acro (the OSD shows AIR), and Angle is the self-levelling one — A / ✕ respawns, B / ○ fresh battery, D-pad ↑ camera, ↓ telemetry, ← hover drill, → noise spectrum). Crashes rumble the controller in Chrome and Edge.'),
        el('li', {}, el('b', {}, 'DJI FPV Remote Controller 3: '), 'power it on and connect its USB-C port to the computer; it appears as “DJI Virtual Joystick”. Move a stick, then run the stick & switch setup once. If its throttle springs back to center, the “Full stick travel” throttle mode treats center as 50%; DJI’s manual describes adjusting the throttle stick for manual (M-mode) flying.'),
        el('li', {}, el('b', {}, 'Other RC radios (EdgeTX / OpenTX, USB joystick mode) and HID joysticks: '), 'same as the DJI radio — run the setup, or turn on radio passthrough to fly with the radio’s own mixer and switches.'),
        el('li', {}, el('b', {}, 'Gamepad throttle: '), 'gamepad sticks spring to center, so new gamepads use “Upper half” (center = off). “Full stick travel” and “Analog trigger” are in the Throttle mode list.'),
      ));
    const hidSec = section('Steam Controller (2026) — direct USB / wireless puck',
      el('p', {}, 'The 2026 Steam Controller is invisible to the browser Gamepad API (outside Steam it pretends to be a keyboard and mouse). The simulator drives it directly over WebHID using Valve’s protocol (from SDL). If connecting fails while Steam is running (Steam can hold the controller, mostly on macOS and Linux), close Steam and try again.'),
      webHidSupported()
        ? btn('hid-connect', 'Connect Steam Controller', async () => { await im.steamHid.request(); render(); }, { primary: true })
        : el('p', { class: 'status' }, 'Not available in this browser: it has no WebHID (Safari and Firefox don’t implement it). Use Chrome or Edge for this controller; Xbox, PS5 and USB joysticks/radios work here.'),
      el('div', { class: 'status', role: 'status' }, im.steamHid.status));
    if (!pad) {
      auxVals = [];
      root.replaceChildren(el('div', { class: 'cols' },
        el('div', { class: 'col' }, section('No controller detected', el('p', {}, 'Connect a controller and press a button (or move a stick) with this page focused. Keyboard fallback: W/S throttle, A/D yaw, arrows pitch/roll, Space arm, 1/2/3 acro/horizon/angle (you start in acro), T turtle, R respawn.')), section('RC channels sent to Betaflight', chans)),
        el('div', { class: 'col' }, notes), el('div', { class: 'col' }, hidSec)));
      return;
    }
    const p = im.profileFor(pad);
    const kind = p.kind ?? controllerKind(pad);
    const std = isStandard(pad);
    const save = () => im.setProfile(pad, p);

    // --- stick assignment ---------------------------------------------------------------------
    const axisRow = (name: Ch) => {
      const b: AxisBind = p[name], Name = name[0].toUpperCase() + name.slice(1);
      const dz = slider({ label: 'deadzone', min: 0, max: 0.2, step: 0.005, value: b.deadzone, onInput: (v) => { b.deadzone = v; save(); } });
      const ex = slider({ label: 'expo', min: 0, max: 1, step: 0.01, value: b.expo, onInput: (v) => { b.expo = v; save(); } });
      dz.input.dataset.key = `${name}-dz`; dz.input.setAttribute('aria-label', `${Name} deadzone`);
      ex.input.dataset.key = `${name}-expo`; ex.input.setAttribute('aria-label', `${Name} expo`);
      return el('div', { class: 'axisrow', role: 'group', 'aria-label': `${Name} stick` },
        el('b', {}, Name),
        sel(`${name}-src`, 'source', [{ value: 'axis', label: 'axis' }, { value: 'button', label: 'analog button' }], b.src as 'axis' | 'button', (v) => { b.src = v; save(); }, { aria: `${Name} source` }),
        sel(`${name}-idx`, 'index', Array.from({ length: Math.max(pad.axes.length, pad.buttons.length) }, (_, i) => ({ value: String(i), label: String(i) })), String(b.index), (v) => { b.index = +v; save(); }, { aria: `${Name} axis or button number` }),
        chk(`${name}-inv`, `invert ${name}`, b.invert, (v) => { b.invert = v; save(); }),
        btn(`${name}-detect`, 'Detect', () => {
          detecting = { ch: name, base: [...pad.axes], until: performance.now() + LISTEN_MS };
          detectMsg.textContent = `Move the stick for ${name.toUpperCase()} fully… (the controller doesn’t navigate the menu for up to 10 s)`;
          syncLock();
        }, { aria: `Detect the ${name} axis` }),
        dz.row, ex.row,
      );
    };
    // --- AUX1-4 bindings: a button or a switch reported on an axis (common on RC radios) --------
    const bindOptions = [
      { value: 'none', label: 'none' },
      ...pad.buttons.map((_, i) => ({ value: `b${i}`, label: buttonName(kind, i) })),
      ...pad.axes.map((_, i) => ({ value: `a${i}`, label: `switch on axis ${i}` })),
      ...pad.axes.map((_, i) => ({ value: `A${i}`, label: `switch on axis ${i} (reversed)` })),
    ];
    const bindValue = (b: ButtonBind | null) => (!b ? 'none' : b.src === 'axis' ? `${b.invert ? 'A' : 'a'}${b.index}` : `b${b.index}`);
    const BIND_NAMES = { arm: 'Arm (AUX1)', mode: 'Flight mode (AUX2)', turtle: 'Turtle / crash flip (AUX3)', beeper: 'Beeper (AUX4)' };
    const bindRow = (k: 'arm' | 'mode' | 'turtle' | 'beeper', modes: { value: ButtonBind['mode']; label: string }[]) => el('div', { class: 'axisrow', role: 'group', 'aria-label': BIND_NAMES[k] },
      sel(k, BIND_NAMES[k], bindOptions, bindValue(p[k]), (v) => {
        if (v === 'none') p[k] = null;
        else {
          const src = v[0] === 'b' ? 'button' : 'axis';
          const def: ButtonBind['mode'] = src === 'axis' ? (k === 'mode' ? 'switch3' : 'hold') : k === 'mode' ? 'cycle3' : k === 'beeper' ? 'hold' : 'toggle';
          p[k] = { index: +v.slice(1), src, invert: v[0] === 'A', mode: p[k]?.src === src ? p[k]!.mode : def };
        }
        save(); render();
      }),
      p[k] ? sel(`${k}-mode`, 'behavior', modes, p[k]!.mode, (v) => { p[k]!.mode = v; save(); }, { aria: `${BIND_NAMES[k]} behavior` }) : null,
    );
    // --- AUX5-12 ------------------------------------------------------------------------------
    const auxOptions = [
      { value: 'none', label: 'none (centered, 1500)' },
      ...pad.buttons.map((_, i) => ({ value: `b${i}`, label: buttonName(kind, i) })),
      ...pad.axes.map((_, i) => ({ value: `a${i}`, label: `switch on axis ${i}` })),
      ...pad.axes.map((_, i) => ({ value: `A${i}`, label: `switch on axis ${i} (reversed)` })),
      ...pad.axes.map((_, i) => ({ value: `p${i}`, label: `proportional axis ${i} (pot / slider)` })),
      ...pad.axes.map((_, i) => ({ value: `P${i}`, label: `proportional axis ${i} (reversed)` })),
    ];
    const auxCode = (b: AuxBind | null | undefined) => (!b ? 'none' : b.src === 'button' ? `b${b.index}` : `${b.mode === 'axis' ? 'p' : 'a'}${b.index}`.replace(/^./, (c) => (b.invert ? c.toUpperCase() : c)));
    auxVals = [];
    const auxRow = (i: number) => {
      const b = p.aux?.[i] ?? null, n = i + 5;
      const val = el('span', { class: 'note', style: { fontVariantNumeric: 'tabular-nums' } }, '1500 µs');
      auxVals[i] = val;
      const modes: { value: AuxBind['mode']; label: string }[] | null = b?.src === 'button'
        ? [{ value: 'hold', label: 'hold (on while pressed)' }, { value: 'toggle', label: 'toggle (press on, press off)' }, { value: 'axis', label: 'analog (trigger travel)' }]
        : b && b.mode !== 'axis' ? [{ value: 'hold', label: '2-position switch' }, { value: 'switch3', label: '3-position switch' }] : null;
      return el('div', { class: 'axisrow', role: 'group', 'aria-label': `AUX${n}, channel ${n + 4}` },
        sel(`aux${i}`, `AUX${n} · CH${n + 4}`, auxOptions, auxCode(b), (v) => {
          if (v === 'none') bindAux(p, i, null);
          else {
            const c = v[0], index = +v.slice(1);
            bindAux(p, i, c === 'b' ? { src: 'button', index, mode: b?.src === 'button' ? b.mode : 'hold' }
              : c === 'p' || c === 'P' ? { src: 'axis', index, invert: c === 'P', mode: 'axis' }
                : { src: 'axis', index, invert: c === 'A', mode: b?.src === 'axis' && b.mode !== 'axis' ? b.mode : 'hold' });
          }
          save(); render();
        }, { aria: `Control for AUX${n} (channel ${n + 4})` }),
        modes && b ? sel(`aux${i}-mode`, 'behavior', modes, b.mode, (v) => { b.mode = v; save(); }, { aria: `AUX${n} behavior` }) : null,
        el('div', { class: 'actions', style: { alignItems: 'center', margin: '2px 0' } },
          btn(`aux${i}-detect`, 'Detect', () => {
            auxListen = { i, base: controlBase(pad), until: performance.now() + LISTEN_MS };
            detectMsg.textContent = `Press the button, or move the switch / pot, for AUX${n}… (the controller doesn’t navigate the menu for up to 10 s)`;
            syncLock();
          }, { aria: `Detect the control for AUX${n}` }),
          el('span', { class: 'note' }, 'output'), val),
      );
    };

    // --- throttle & stick geometry --------------------------------------------------------------
    const thrHelp = help(
      para(el('b', {}, 'Upper half'), ' (gamepad default): stick released = throttle off, push up for power. Letting go never leaves 50 % throttle, about twice what a light quad needs to hover.'),
      para(el('b', {}, 'Full stick travel'), ': bottom = off, center = 50 %. For radios and throttle sticks that stay where you leave them; on a spring-centered gamepad stick the quad climbs when you let go.'),
      para(el('b', {}, 'Analog trigger'), ': the right trigger (RT / R2) is the throttle, released = off; the left stick only yaws.'));
    const squareHelp = help(std
      ? 'Gamepad sticks move in a circle, so full roll plus full pitch only reaches about 70 % of each. This stretches the circle to the square a radio gimbal covers; small moves near center stay the same. Leave it off for RC radios.'
      : 'Needs the standard gamepad mapping (which axes share a stick is unknown here). Radio gimbals are square already.');
    const passHelp = help('For EdgeTX / OpenTX radios in USB joystick mode, whose axes already are the model’s mixed channels: axis 1…N goes to CH1…N unchanged, with the radio’s own switches, endpoints and channel order (Betaflight here uses AETR, “map AETR1234”). Stick assignment, calibration and the bindings below are bypassed for those channels; opening the menu still disarms.');
    const stickHelp = help('Detect: press it, then push that stick fully (stops after 10 s). Deadzone: travel ignored around center; on standard gamepads it is round per stick (the larger of its two axes’ settings), so small diagonal moves aren’t snapped onto an axis. Expo: softens the center (normally 0, Betaflight rates do the shaping).');
    const auxHelp = help(
      para('Spare buttons, switches or pots for extra Betaflight modes. Bind a control here, then give that channel a mode in Settings → Betaflight → CLI (type the line, then ', el('code', {}, 'save'), '):'),
      el('ul', { style: { margin: '4px 0', paddingLeft: '18px' } }, ...BF_MODES.map((m) => el('li', {}, el('b', {}, m.name), ` on AUX${m.aux}: `, el('code', {}, `aux ${m.aux} ${m.id} ${m.aux - 1} 1700 2100 0 0`), ` — ${m.why}.`))));

    const presetHelp = help(std ? 'Presets use the standard gamepad layout this browser reports.' : 'Vendor presets assume the standard gamepad layout, which this browser doesn’t report for this device: prefer the stick & switch setup.');
    root.replaceChildren(
      el('div', { class: 'cols' },
        el('div', { class: 'col' },
          section('Device',
            sel('pad', 'Active controller', im.pads().map((g) => ({ value: String(g.index), label: `${g.index}: ${g.id}` })), String(pad.index), (v) => { im.activeIndex = +v; render(); }),
            el('p', { class: 'note' }, `${p.name} · mapping: ${pad.mapping || 'non-standard'} · ${pad.axes.length} axes · ${pad.buttons.length} buttons`),
            std ? null : el('p', { class: 'note', role: 'note', style: { color: '#ffcf6a' } }, 'The browser reports no standard layout for this controller (RC radio, joystick, or a gamepad in Firefox on Linux and some Safari versions), so its stick order is unknown. Run the stick & switch setup below.'),
            sel('preset', 'Load preset profile', [
              { value: '', label: '— choose —' },
              { value: 'xbox', label: 'Xbox controller (Mode 2)' }, { value: 'ps5', label: 'PlayStation 5 DualSense (Mode 2)' },
              { value: 'dji', label: 'DJI FPV Remote Controller 3' }, { value: 'steam', label: 'Steam Controller via Steam Input (Mode 2)' },
              { value: 'standard', label: 'Standard gamepad (Mode 2)' }, { value: 'trigger', label: 'Gamepad, trigger throttle' },
              { value: 'joystick', label: 'Generic HID joystick (AETR)' },
            ], '', (v) => { if (v) { im.setProfile(pad, (PRESET_PROFILES as any)[v](pad.id) as InputProfile); render(); } }, { help: presetHelp }),
            chk('rumble', 'Rumble on crashes (Xbox / DualSense, where the browser supports it)', im.rumbleEnabled, (v) => { im.setRumble(v); if (v) im.rumble(0.6, 0.6, 200); }),
          ),
          section('Throttle & sticks',
            sel('thr-mode', 'Throttle mode', [{ value: 'upper', label: 'Upper half (center = off)' }, { value: 'full', label: 'Full stick travel (center = 50%)' }, { value: 'trigger', label: 'Analog trigger' }], p.throttleMode, (v: ThrottleMode) => {
              p.throttleMode = v;
              if (v === 'trigger' && p.throttle.src !== 'button') p.throttle = { ...p.throttle, src: 'button', index: 7, min: 0, center: 0, max: 1, invert: false };
              // back from the trigger: the throttle stick again (a button would idle at 50 % in "full")
              if (v !== 'trigger' && p.throttle.src === 'button') p.throttle = (std ? standardProfile() : genericJoystickProfile()).throttle;
              save(); render();
            }, { help: thrHelp }),
            chk('square', 'Square stick corners (full roll + full pitch together)', std && squareSticks(pad, p), (v) => { p.circleToSquare = v; save(); }, { help: squareHelp, disabled: !std }),
            std && !p.passthrough ? null : chk('passthrough', 'Radio passthrough: axis 1…N → CH1…N', !!p.passthrough, (v) => { p.passthrough = v; save(); render(); }, { help: passHelp }),
          ),
          section('Stick & switch setup wizard', wizBox),
          section('Stick assignment', axisRow('throttle'), axisRow('yaw'), axisRow('pitch'), axisRow('roll'), stickHelp, detectMsg),
          section('Calibration',
            el('p', {}, 'Press Start, move every stick to all its extremes (circles), center roll / pitch / yaw, then press Finish.'),
            el('div', { class: 'actions' }, ...(calibrating
              ? [btn('cal-finish', 'Finish', () => {
                if (!calibrating) return;
                for (const n of ['roll', 'pitch', 'yaw', 'throttle'] as const) {
                  const b = p[n]; if (b.src !== 'axis') continue;
                  b.min = calibrating.min[b.index]; b.max = calibrating.max[b.index];
                  // throttle may not self-center (radios): use mid-travel instead of its resting value
                  b.center = n === 'throttle' ? (b.min + b.max) / 2 : pad.axes[b.index] ?? 0;
                }
                const r = ringed();
                calibrating = null; save(); detectMsg.textContent = 'Calibration saved.'; render(); focusKey('cal-start', r);
              }, { primary: true }), btn('cal-cancel', 'Cancel', () => { const r = ringed(); calibrating = null; detectMsg.textContent = 'Calibration cancelled.'; render(); focusKey('cal-start', r); })]
              : [btn('cal-start', 'Start', () => {
                const r = ringed();
                calibrating = { min: pad.axes.map(() => 1), max: pad.axes.map(() => -1) };
                detectMsg.textContent = 'Calibrating… move all sticks to their extremes';
                render(); focusKey('cal-finish', r);
              })])),
            calibrating ? help(std ? 'Controller: A = Finish, B leaves; sticks don’t move the menu meanwhile.' : 'Use the mouse or keyboard for Finish: the controller only calibrates now.') : null,
          ),
        ),
        el('div', { class: 'col' },
          section('Buttons & switches',
            bindRow('arm', [{ value: 'toggle', label: 'toggle (button)' }, { value: 'hold', label: 'switch / hold' }]),
            bindRow('mode', [{ value: 'cycle3', label: 'cycle acro → horizon → angle' }, { value: 'switch3', label: '3-position switch' }, { value: 'hold', label: '2-position: acro / angle' }]),
            bindRow('turtle', [{ value: 'toggle', label: 'toggle' }, { value: 'hold', label: 'switch / hold' }]),
            bindRow('beeper', [{ value: 'hold', label: 'hold' }, { value: 'toggle', label: 'toggle' }]),
            sel('reset', 'Respawn button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: buttonName(kind, i) }))], String(p.reset ?? -1), (v) => { p.reset = +v < 0 ? null : +v; save(); }),
            sel('menu', 'Menu button', [{ value: '-1', label: 'none' }, ...pad.buttons.map((_, i) => ({ value: String(i), label: buttonName(kind, i) }))], String(p.menu ?? -1), (v) => { p.menu = +v < 0 ? null : +v; save(); }),
            help('The flight mode starts in Acro and each press of the mode button steps acro → horizon → angle (self-levelling).'),
          ),
          section('AUX 5–12 (CH9–CH16)', ...Array.from({ length: AUX_EXTRA }, (_, i) => auxRow(i)), auxHelp),
          section('RC channels sent to Betaflight', chans),
        ),
        el('div', { class: 'col' }, section('Live raw input', live), notes, hidSec),
      ),
    );
    renderWizard();
  });

  // --- live: listening steps, raw input and channel bars (updated in place) ---------------------
  const bar = (label: string) => { const i = el('i'), em = el('em'); return { row: el('div', { class: 'bar' }, el('span', {}, label), i, em), i, em }; };
  const chBars = CH_NAMES.map(bar);
  chans.replaceChildren(...chBars.map((b) => b.row));
  let liveSig = '', axBars: ReturnType<typeof bar>[] = [], btnEls: HTMLElement[] = [];

  const listen = (pad: Gamepad, now: number) => {
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
      } else if (now > detecting.until) { detectMsg.textContent = `Nothing moved: ${detecting.ch} unchanged.`; detecting = null; }
    }
    if (auxListen) {
      const hit = detectControl(pad, auxListen.base), i = auxListen.i;
      if (hit) {
        const p = im.profileFor(pad);
        // a switch rests at an end of its travel; a pot or slider anywhere in between
        const b: AuxBind = hit.src === 'button' ? { src: 'button', index: hit.index, mode: 'hold' }
          : Math.abs(hit.rest) > 0.8 ? { src: 'axis', index: hit.index, invert: hit.delta < 0, mode: 'hold' }
            : { src: 'axis', index: hit.index, mode: 'axis' };
        bindAux(p, i, b); im.setProfile(pad, p);
        detectMsg.textContent = `AUX${i + 5} → ${hit.src === 'button' ? buttonName(p.kind, hit.index) : `${b.mode === 'axis' ? 'proportional' : 'switch on'} axis ${hit.index}`}`;
        auxListen = null; render();
      } else if (now > auxListen.until) { detectMsg.textContent = `Nothing moved: AUX${i + 5} unchanged.`; auxListen = null; }
    }
  };

  const draw = (pad: Gamepad | null) => {
    if (pad) {
      const kind = im.profileFor(pad).kind ?? controllerKind(pad);
      const sig = `${pad.index}|${pad.id}|${pad.axes.length}|${pad.buttons.length}|${kind}`;
      if (sig !== liveSig) {
        liveSig = sig;
        axBars = pad.axes.map((_, i) => bar(`axis ${i}`));
        btnEls = pad.buttons.map((_, i) => el('span', {}, buttonName(kind, i)));
        live.replaceChildren(...axBars.map((b) => b.row), el('div', { class: 'btns' }, ...btnEls));
      }
      pad.axes.forEach((v, i) => { axBars[i].i.style.width = `${((v + 1) / 2) * 100}%`; axBars[i].em.textContent = v.toFixed(3); });
      pad.buttons.forEach((b, i) => {
        const e = btnEls[i]; if (!e) return;
        e.classList.toggle('on', b.pressed || b.value > 0.5);
        const t = b.value > 0 && b.value < 1 ? `${buttonName(kind, i)}:${b.value.toFixed(2)}` : buttonName(kind, i);
        if (e.textContent !== t) e.textContent = t;
      });
    } else if (liveSig) { liveSig = ''; live.replaceChildren(); }
    chBars.forEach((b, i) => { const v = im.channels[i]; b.i.style.width = `${(v - 1000) / 10}%`; b.em.textContent = v.toFixed(0); });
    auxVals.forEach((e, i) => { e.textContent = `${im.channels[8 + i].toFixed(0)} µs`; });
  };

  // --- lifecycle: one loop per panel, stopped for good once the panel leaves the page ------------
  let raf = 0, alive = true, attached = false, waited = 0, lastCount = im.pads().length;
  const poll = window.setInterval(() => { const n = im.pads().length; if (n !== lastCount) { lastCount = n; render(); } }, 1000);
  const stop = () => { alive = false; cancelAnimationFrame(raf); clearInterval(poll); cancelListening(); syncLock(); };
  const tick = () => {
    if (!alive) return;
    if (!root.isConnected) {
      // removed (tab switch, menu re-render): stop. Not attached yet: give the host a few frames.
      if (attached || ++waited > 300) { stop(); return; }
      raf = requestAnimationFrame(tick); return;
    }
    attached = true;
    raf = requestAnimationFrame(tick);
    // menu closed into flight: nothing to draw, and nothing may listen to the pad while it flies
    if (root.closest('.hidden, [hidden]')) { if (listening()) { cancelListening(); render(); } syncLock(); return; }
    const pad = im.active;
    if (pad) listen(pad, performance.now());
    draw(pad);
    syncLock();
  };
  render();
  raf = requestAnimationFrame(tick);
  onUnmount(root, stop); // the menu closing into flight (its screen stays in the page, hidden) or moving on
  return root;
}

function bindAux(p: InputProfile, i: number, b: AuxBind | null) {
  const a = (p.aux ??= []);
  while (a.length < AUX_EXTRA) a.push(null);
  a[i] = b;
}
