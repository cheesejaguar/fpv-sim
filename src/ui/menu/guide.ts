// Betaflight quick start guide: a chaptered walkthrough of the things a new pilot meets in the real
// firmware the sim runs (Betaflight 4.5.5): arming, modes, rates, PIDs, filters, OSD / link quality,
// the CLI and "diff all". Content is static (this file), so it is set as HTML.
import { el } from '../dom';
import { icon } from './icons';

export type GuideAction = 'fly' | 'bf' | 'controller' | 'builder' | 'sim';
export interface Chapter { id: string; title: string; minutes: number; html: string; figure?: () => HTMLElement; actions?: { label: string; go: GuideAction }[] }

const tip = (s: string) => `<div class="gm-callout">${svg('info')}<p>${s}</p></div>`;
const warn = (s: string) => `<div class="gm-callout warn">${svg('alert')}<p>${s}</p></div>`;
const svg = (n: Parameters<typeof icon>[0]) => icon(n).outerHTML;

export const CHAPTERS: Chapter[] = [
  {
    id: 'welcome', title: 'What Betaflight is', minutes: 2,
    html: `<p>Betaflight is the open-source firmware that runs on the flight controller (FC) of almost every FPV quad. It reads the gyro thousands of times a second, compares how the quad is rotating with what your sticks ask for, and drives the four motors to close the gap.</p>
      <p>This simulator does not imitate Betaflight. It runs <b>the real Betaflight 4.5.5 firmware</b>, compiled to WebAssembly, against a physics model of your quad. Settings you change here behave the way they do on a real FC, and you can paste a real <code>diff all</code> in to fly your own tune.</p>
      <h4>What you'll learn</h4>
      <ol><li>Arming, and why Betaflight sometimes refuses to arm</li><li>Flight modes: Acro, Angle, Horizon and Turtle</li><li>Rates: how stick position becomes rotation speed</li><li>PIDs and filters, in plain words</li><li>Reading the OSD: battery, link quality and RSSI</li><li>The CLI and importing your own quad</li></ol>
      ${tip('Every chapter takes a couple of minutes. Use LB / RB (or Q / E) to move between chapters with a controller or keyboard.')}`,
  },
  {
    id: 'arming', title: 'Arming & the switches', minutes: 3,
    html: `<p>A quad's motors only spin once it is <b>armed</b>. Betaflight arms when the <b>ARM</b> mode switch (AUX1 here) goes high, as long as no safety check is blocking it.</p>
      <table class="gm-table-lite"><thead><tr><th>Action</th><th>Xbox / Steam</th><th>PlayStation</th><th>Keyboard</th></tr></thead><tbody>
      <tr><td>Arm / disarm (AUX1)</td><td>RB</td><td>R1</td><td>Space</td></tr>
      <tr><td>Flight mode, Acro → Horizon → Angle (AUX2)</td><td>LB</td><td>L1</td><td>1 / 2 / 3</td></tr>
      <tr><td>Turtle mode (AUX3)</td><td>X</td><td>□</td><td>T</td></tr>
      <tr><td>Beeper (AUX4)</td><td>Y (hold)</td><td>△ (hold)</td><td>—</td></tr>
      <tr><td>Respawn after a crash</td><td>A</td><td>✕</td><td>R</td></tr>
      <tr><td>Pause menu</td><td>Menu / Start</td><td>Options</td><td>Esc</td></tr>
      </tbody></table>
      <p>Sticks are <b>Mode 2</b>: left stick is throttle (up/down) and yaw (left/right), right stick is pitch and roll. Radios and other controllers can be remapped in <b>Settings → Controller</b>.</p>
      <h4>When it won't arm</h4>
      <p>Betaflight lists the reasons in the <b>arming disabled flags</b>. The telemetry overlay (H) shows them after <code>blocked:</code>. The common ones:</p>
      <ul><li><code>THROTTLE</code>: throttle isn't at the bottom. Pull the left stick fully down and arm again.</li>
      <li><code>RXLOSS</code> / <code>FAILSAFE</code>: no RC link. Check that the controller is detected.</li>
      <li><code>CLI</code> / <code>MSP</code>: a configurator or the CLI is connected. Leave the CLI with <code>exit</code>.</li>
      <li><code>BOOTGRACE</code> / <code>CALIB</code>: the FC just rebooted and is still calibrating the gyro. Wait a second.</li>
      <li><code>ARMSWITCH</code>: the arm switch was already on when the FC booted. Flip it off, then on.</li></ul>
      ${warn('Treat every armed quad as live. On a real one, never arm with props on while it is close to you or on the bench.')}`,
    actions: [{ label: 'Controller setup', go: 'controller' }],
  },
  {
    id: 'modes', title: 'Flight modes', minutes: 3,
    html: `<table class="gm-table-lite"><thead><tr><th>Mode</th><th>What the sticks do</th><th>Use it for</th></tr></thead><tbody>
      <tr><td><b>Acro</b> (rate)</td><td>The right stick commands <i>rotation speed</i>. Centre the stick and the quad holds whatever angle it is at. It never levels itself.</td><td>Real FPV flying, racing and freestyle. Every pilot ends up here.</td></tr>
      <tr><td><b>Angle</b></td><td>The right stick commands <i>tilt angle</i> (limited, around 55°). Let go and it levels.</td><td>The first hover practice and line-of-sight flying.</td></tr>
      <tr><td><b>Horizon</b></td><td>Self-levels near centre stick and flips at full stick.</td><td>A bridge between Angle and Acro.</td></tr>
      <tr><td><b>Turtle</b> (crash flip)</td><td>Disarmed, upside down: arm with Turtle on, and the stick spins pairs of motors backwards to flip the quad over.</td><td>Getting back in the air after a crash without walking over.</td></tr>
      </tbody></table>
      ${tip('Learn in Acro early. Use the hover drill (New Game → Hover drill, or the G key) to build throttle control first, then do slow figure-eights in Acro.')}
      <p>The OSD shows the active mode, for example <code>ACRO</code>, <code>ANGL</code> or <code>HOR</code>, and Betaflight warns <code>CRASH FLIP</code> while Turtle is on.</p>`,
    actions: [{ label: 'Fly a hover drill', go: 'fly' }],
  },
  {
    id: 'rates', title: 'Rates', minutes: 4,
    html: `<p><b>Rates</b> turn stick deflection into a rotation speed in degrees per second. Betaflight 4.5 uses <b>Actual rates</b>, which have three numbers per axis:</p>
      <ul><li><b>Center sensitivity</b> (<code>roll_rc_rate</code> ×10 °/s): how fast the quad turns for small stick moves near the centre. Lower values give finer control.</li>
      <li><b>Max rate</b> (<code>roll_srate</code> ×10 °/s): the rotation speed at full stick. 600–800 °/s is typical freestyle, 400–600 °/s is calmer.</li>
      <li><b>Expo</b> (<code>roll_expo</code>): bends the curve, so the area around centre stays soft while the maximum stays the same.</li></ul>
      <p>Drag the sliders and watch the curve. The default is 70 / 670 / 0.</p>`,
    figure: rateExplorer,
    actions: [{ label: 'Open rates in Betaflight', go: 'bf' }],
  },
  {
    id: 'pids', title: 'PIDs, without the maths', minutes: 4,
    html: `<p>Every gyro sample, Betaflight's PID controller computes the error, meaning how far the measured rotation is from the requested one, and corrects it with these terms:</p>
      <table class="gm-table-lite"><thead><tr><th>Term</th><th>Job</th><th>Too low</th><th>Too high</th></tr></thead><tbody>
      <tr><td><b>P</b></td><td>Pushes against the error now</td><td>Mushy, floaty, drifts in wind</td><td>Fast oscillation, buzzy after flips</td></tr>
      <tr><td><b>I</b></td><td>Fixes error that persists (CG offset, wind)</td><td>Won't hold an angle, drifts on punch-outs</td><td>Slow wobble, bounce-back after moves</td></tr>
      <tr><td><b>D</b></td><td>Damps the motion and resists overshoot</td><td>Overshoot, prop-wash wobble</td><td>Hot motors, amplified noise</td></tr>
      <tr><td><b>FF</b></td><td>Reacts to how fast you move the stick</td><td>Lags behind the sticks</td><td>Overshoots fast stick moves, jittery</td></tr>
      </tbody></table>
      ${tip('Change one thing at a time, in steps of 10–15 %, and fly the same line each time. The defaults fly well on the stock builds, so tune only when you can name the problem.')}
      <p>Related settings in the Betaflight tab: <b>TPA</b> lowers P and D at high throttle, <b>anti-gravity</b> boosts I during throttle punches, and <b>dynamic idle</b> keeps motors spinning fast enough to avoid desyncs.</p>`,
    actions: [{ label: 'Open PID tuning', go: 'bf' }],
  },
  {
    id: 'filters', title: 'Filters & noise', minutes: 3,
    html: `<p>Spinning props make the frame vibrate. The gyro sees that vibration as noise, the D term amplifies it, and the motors get hot. Betaflight filters it out before the PID controller sees it:</p>
      <ul><li><b>RPM filter</b>: uses bidirectional DShot motor telemetry to place a notch exactly on each motor's frequency and its harmonics. It is the most effective filter, and it is on by default here.</li>
      <li><b>Dynamic notch</b>: finds the strongest leftover peaks (frame resonance) and notches them.</li>
      <li><b>Gyro and D-term lowpass</b>: remove everything above a cutoff. Less filtering gives a sharper feel but more noise. More filtering adds delay, which feels like prop wash.</li></ul>
      ${tip('Press F in flight to open the live noise spectrum. The orange trace is the raw gyro, the blue trace is what Betaflight filtered, and the yellow bands are your motor harmonics. Bend a prop in a crash and watch new peaks appear.')}`,
    actions: [{ label: 'Open filters', go: 'bf' }],
  },
  {
    id: 'osd', title: 'OSD, LQ & RSSI', minutes: 3,
    html: `<p>The OSD (on-screen display) is drawn by Betaflight itself into your video feed, using the same fonts and layout as in real goggles.</p>
      <table class="gm-table-lite"><thead><tr><th>Element</th><th>Meaning</th></tr></thead><tbody>
      <tr><td>Battery voltage</td><td>Pack voltage, which sags under throttle. Land at about 3.5 V per cell resting. Betaflight warns <code>LOW BATTERY</code> at 3.5 V per cell.</td></tr>
      <tr><td>mAh drawn</td><td>Capacity used so far. Land with about 20–30 % of the pack left.</td></tr>
      <tr><td><b>LQ</b></td><td>Link quality: the percentage of RC packets that arrive. The sim's ELRS-style link drops packets with distance and obstructions. Below about 70 % control gets stuttery. At 0 Betaflight goes into failsafe.</td></tr>
      <tr><td><b>RSSI dBm</b></td><td>Received signal strength. Around −50 dBm is close and strong. Near the receiver's sensitivity limit (about −105 to −110 dBm at 250 Hz) packets start dropping.</td></tr>
      <tr><td>Flight mode / timers</td><td>Active mode, armed time and on time.</td></tr>
      <tr><td>Warnings</td><td>Messages such as <code>RXLOSS</code>, <code>LOW BATTERY</code> and <code>CRASH FLIP</code> blink in the centre.</td></tr>
      </tbody></table>
      ${tip('Higher RC transmitter power (Settings → Simulation → RC transmitter power) extends range. A lower packet rate also adds range, at the cost of latency.')}
      <p>Move OSD elements with the CLI using <code>set osd_&lt;element&gt;_pos</code>, or import a layout from your own quad's <code>diff all</code>.</p>`,
    actions: [{ label: 'Simulation settings', go: 'sim' }],
  },
  {
    id: 'cli', title: 'The CLI & your own quad', minutes: 3,
    html: `<p>The <b>CLI</b> (command line interface) is Betaflight's text console. It is in the Betaflight tab of Settings. Commands you'll actually use:</p>
      <pre>get rc_rate            # search settings by name
set roll_srate = 70    # change a value (×10 °/s)
diff                   # show what differs from defaults
save                   # write to EEPROM and reboot
exit                   # leave without saving</pre>
      <h4>Bring your real quad</h4>
      <ol><li>Connect your real quad in Betaflight Configurator, open the CLI tab, type <code>diff all</code> and copy the output.</li>
      <li>Here, open <b>Settings → Betaflight → Bring your real quad</b>, paste it and select <b>Preview</b>.</li>
      <li>Rates, PIDs, filters, modes and OSD layout are applied to the simulated FC. Hardware lines that would break the sim (resources, serial pins, the board's own motor protocol) are skipped and listed so you can see what was skipped.</li></ol>
      ${warn('<code>save</code> reboots the flight controller and disarms it. The simulated FC reboots just like a real one, so land first.')}
      <p>You can also go the other way: <b>Export sim diff all</b> gives you a tune you have dialled in here, to paste into a real quad.</p>`,
    actions: [{ label: 'Open the CLI', go: 'bf' }],
  },
  {
    id: 'first', title: 'Your first flight', minutes: 2,
    html: `<ol>
      <li><b>Pick a build.</b> A tiny whoop (New Game → Drone) is slow and forgiving. A 5" quad is the standard freestyle and racing class.</li>
      <li><b>Check the controller.</b> Move the sticks and confirm the stick preview (H) follows them. Throttle should rest at the bottom.</li>
      <li><b>Arm in Angle.</b> Press LB until the OSD shows <code>ANGL</code>, then arm with RB.</li>
      <li><b>Hover.</b> Add throttle slowly until the quad lifts, and hold it about a metre up. The hover drill scores this.</li>
      <li><b>Switch to Acro</b> once hovering feels easy. Fly slow laps of the stadium and keep the horizon level with gentle inputs.</li>
      <li><b>Crash, respawn, repeat.</b> A (✕) respawns. Menu / Options or Esc opens the pause menu.</li></ol>
      ${tip('Ten minutes a day beats an hour a week. The sim models the hard parts honestly: battery sag, prop wash, video latency and link loss. Skills you build here carry over to a real quad.')}`,
    actions: [{ label: 'Fly now', go: 'fly' }],
  },
];

/** Interactive Betaflight "Actual" rates curve (same formula as the firmware's applyActualRates). */
function rateExplorer(): HTMLElement {
  const st = { center: 70, max: 670, expo: 0 };
  const W = 520, H = 230, L = 46, B = 26, T = 10;
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Rate curve: stick deflection versus rotation rate');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#f43f5e'); path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-linecap', 'round');
  const grid = document.createElementNS(ns, 'g');
  const out = el('div', { class: 'gm-badge rose' });
  const rate = (x: number) => { // x in 0..1 stick
    const e = st.expo / 100, expof = x * (x ** 5 * e + x * (1 - e));
    return x * st.center + Math.max(0, st.max - st.center) * expof;
  };
  let yMax = 900;
  const draw = () => {
    yMax = Math.max(900, Math.ceil(rate(1) / 300) * 300);
    const pw = W - L - 8, ph = H - T - B;
    grid.replaceChildren();
    for (let v = 0; v <= yMax; v += 300) {
      const y = T + ph - (v / yMax) * ph;
      const ln = document.createElementNS(ns, 'line'); ln.setAttribute('x1', String(L)); ln.setAttribute('x2', String(W - 8)); ln.setAttribute('y1', String(y)); ln.setAttribute('y2', String(y)); ln.setAttribute('stroke', 'rgba(167,139,250,.18)');
      const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', String(L - 6)); tx.setAttribute('y', String(y + 4)); tx.setAttribute('text-anchor', 'end'); tx.setAttribute('fill', '#94a3b8'); tx.setAttribute('font-size', '11'); tx.textContent = String(v);
      grid.append(ln, tx);
    }
    for (let k = 0; k <= 4; k++) {
      const x = L + (k / 4) * pw;
      const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', String(x)); tx.setAttribute('y', String(H - 8)); tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('fill', '#94a3b8'); tx.setAttribute('font-size', '11'); tx.textContent = `${k * 25}%`;
      grid.append(tx);
    }
    let d = '';
    for (let i = 0; i <= 100; i++) { const x = i / 100, v = Math.min(yMax, rate(x)); d += `${i ? 'L' : 'M'}${(L + x * pw).toFixed(1)},${(T + ph - (v / yMax) * ph).toFixed(1)}`; }
    path.setAttribute('d', d);
    out.textContent = `full stick ${Math.round(rate(1))} °/s · half stick ${Math.round(rate(0.5))} °/s`;
  };
  s.append(grid, path);
  const sl = (label: string, key: keyof typeof st, min: number, max: number, step: number, unit: string) => {
    const val = el('span', { class: 'val' }, `${st[key]}${unit}`);
    const i = el('input', { type: 'range', min, max, step, value: st[key], 'aria-label': label, oninput: () => { st[key] = +i.value; val.textContent = `${st[key]}${unit}`; if (key === 'center' && st.max < st.center) st.max = st.center; draw(); } }) as HTMLInputElement;
    return el('label', { class: 'slider' }, el('span', { class: 'lbl' }, label), i, val);
  };
  draw();
  return el('figure', { class: 'gm-figure' }, s,
    el('div', { class: 'gm-settings', style: { marginTop: '10px' } },
      sl('Center sensitivity', 'center', 10, 400, 5, ' °/s'), sl('Max rate', 'max', 100, 1800, 10, ' °/s'), sl('Expo', 'expo', 0, 100, 1, '')),
    el('figcaption', {}, out, ' Horizontal: stick deflection. Vertical: rotation rate in °/s.'));
}

const DONE_KEY = 'fpv-guide-done';
export function guideDone(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } }
export function markDone(id: string) { const s = guideDone(); s.add(id); try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch { /* ignore */ } }
