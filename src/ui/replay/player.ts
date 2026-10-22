// Full-screen lap replay player, over the game menu (in its design language, theme.css): play /
// pause, a timeline with the gate splits to scrub, speed 0.1× to 4×, frame step, restart and loop;
// FPV (the real camera pipeline, without latency), chase, line of sight and an orbit camera; stick,
// speed / altitude, split and battery overlays; the motors heard at 1×. Kinematic playback: neither
// Betaflight nor the physics run, the live session waits paused behind the menu and comes back as
// it was (src/app/replaySession.ts). Keyboard and controller go through the menu's navigation as
// an overlay (nav.ts). Loaded the first time a replay is opened.
import './player.css';
import { decodeReplay, REPLAY_MIME } from '../../../server/src/replayFormat';
import type { AppCtx, ReplayView } from '../../app/context';
import { replayUrl } from '../../app/replayLink';
import { enterReplay, replayWorld } from '../../app/replaySession';
import { OsdPlayback, ReplayClock, ReplayTrack, SPEEDS } from '../../app/replayTrack';
import { className } from '../../builder/droneClass';
import { isStandard } from '../../input/gamepad';
import { MAP_LIST } from '../../maps/maps';
import { formatLap } from '../../net/leaderboard';
import { R, REC } from '../../worker/shared';
import { el } from '../dom';
import type { ReplayLabel, ReplayUi } from '../menu/gameMenu';
import { icon } from '../menu/icons';
import type { Dir, NavOverlay } from '../menu/nav';

export interface Player { close(): void }

type Cam = ReplayView['cam'];
const CAMS: Cam[] = ['fpv', 'chase', 'los', 'orbit'];
const CAM_NAMES: Record<Cam, string> = { fpv: 'FPV', chase: 'Chase', los: 'Line of sight', orbit: 'Orbit' };
type Overlay = 'sticks' | 'flight' | 'splits' | 'battery';
const OVERLAYS: [Overlay, string][] = [['sticks', 'Sticks'], ['flight', 'Speed'], ['splits', 'Splits'], ['battery', 'Battery']];
/** kept for the session: the next replay opens the way the last one was left */
const prefs = { cam: 'fpv' as Cam, show: { sticks: true, flight: true, splits: true, battery: true } as Record<Overlay, boolean>, loop: false, link: null as boolean | null };

/** Lap time as the player shows it: m:ss.cc, with a minus before the start (the approach to gate 0). */
export function lapClock(t: number): string {
  const neg = t < -0.005, cs = Math.round(Math.abs(t) * 100), m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100);
  return `${neg ? '−' : ''}${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const speedLabel = (s: number) => `${s}×`;

/** Put text on the clipboard: the Clipboard API, else the older copy command (embedded pages, older browsers). */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* blocked: try the old way */ }
  const ta = el('textarea', { readonly: '', style: { position: 'fixed', opacity: '0', top: '0', left: '0' } }) as HTMLTextAreaElement;
  ta.value = text; document.body.append(ta); ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}

export async function openPlayer(ctx: AppCtx, bytes: Uint8Array, label: ReplayLabel, ui: ReplayUi): Promise<Player> {
  const track = new ReplayTrack(await decodeReplay(bytes));
  const world = await replayWorld(track);
  const h = track.header, gates = world.map.gates;
  const clock = new ReplayClock(track.t0, track.t1, 1 / track.rate, label.startAt ?? track.t0); // a permalink may start mid-lap
  clock.loop = prefs.loop;
  const osd = new OsdPlayback(track.osd);
  const rec = new Float64Array(REC);
  const orbit = { az: Math.PI * 0.75, el: 0.35, dist: 2.4 };
  let link = prefs.link ?? ctx.view.linkEffects, muted = false, closed = false, lastNow = 0;
  let exit = () => {};
  // the bars fade out while it plays untouched (they would cover the OSD's top and bottom rows)
  let lastActive = performance.now(), idle = false;
  const wake = () => { lastActive = performance.now(); };

  // ---- DOM ----------------------------------------------------------------------------------
  const btn = (key: string, label: string, ico: Parameters<typeof icon>[0] | null, onclick: () => void, cls = 'gm-btn rp-btn') =>
    el('button', { class: cls, 'data-key': key, 'aria-label': label, title: label, onclick }, ...(ico ? [icon(ico)] : [])) as HTMLButtonElement;
  const trackName = MAP_LIST[h.map]?.name.split(' — ')[0] ?? h.map;
  const courseName = h.course ? world.map.courses?.find((c) => c.id === h.course)?.name ?? h.course : '';
  const date = h.date ? new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const who = label.pilot ? el('b', { class: 'rp-who' }, label.pilot) : el('b', { class: 'rp-who' }, { best: 'Your best', last: 'Your last lap', file: 'Replay file', board: 'Lap' }[label.source]);
  const title = el('div', { class: 'rp-title' },
    el('span', { class: 'rp-tag' }, 'Replay'), who,
    label.rank ? el('span', { class: 'gm-badge' }, `#${label.rank}`) : null,
    el('span', { class: 'lb-time' }, formatLap(h.lapMs)),
    h.invalid ? el('span', { class: 'gm-badge rose', title: h.invalid }, 'Didn’t count') : null,
    el('span', { class: 'rp-meta' }, [courseName ? `${trackName} · ${courseName}` : trackName, h.cls === 'custom' ? h.summary : className(h.cls), date].filter(Boolean).join(' · ')));
  const toggles = el('div', { class: 'rp-toggles', role: 'group', 'aria-label': 'Overlays' });
  const drawToggles = () => toggles.replaceChildren(
    ...OVERLAYS.map(([k, name]) => el('button', { class: 'rp-chip', 'data-key': `ov-${k}`, 'aria-pressed': String(prefs.show[k]), onclick: () => { prefs.show[k] = !prefs.show[k]; drawToggles(); layoutCards(); } }, name)),
    el('button', { class: 'rp-chip', 'data-key': 'ov-link', 'aria-pressed': String(link), title: 'FPV camera: the video link’s noise and breakup, as the pilot saw them', onclick: () => toggleLink() }, 'Video link'));
  // the link only shows in the FPV picture, and a paused picture is drawn again so the change shows at once
  const toggleLink = () => {
    link = prefs.link = !link; drawToggles();
    if (link && prefs.cam !== 'fpv') setCam('fpv');
    clock.redraw();
    toast(link ? 'Video link on: noise and breakup as the pilot saw them (little of either close to the pilot)' : 'Video link off: a clean picture');
  };
  const download = el('button', { class: 'gm-btn rp-btn', 'data-key': 'rp-download', title: 'Download this replay (.fpvreplay)', onclick: () => save() }, icon('download'), el('span', { class: 'rp-wide' }, 'Download'));
  // a leaderboard lap has a permalink: at the paused moment, or from the start
  const id = label.entryId;
  const copyLink = id ? el('button', { class: 'gm-btn rp-btn', 'data-key': 'rp-link', title: 'Copy a link to this replay (paused mid-lap: to that moment)', onclick: () => void copy(id) }, icon('copy'), el('span', { class: 'rp-wide' }, 'Copy link')) : null;
  const back = el('button', { class: 'gm-btn ghost rp-back', 'data-key': 'rp-back', onclick: () => close() }, icon('back'), 'Back');
  const top = el('header', { class: 'rp-top' }, back, title, el('span', { class: 'gm-spacer' }), toggles, copyLink, download);

  // overlays
  const sticksCv = el('canvas', { width: 196, height: 92, class: 'rp-sticks', 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const sticksTxt = el('p', { class: 'rp-small' });
  const sticksCard = el('section', { class: 'gm-card rp-card', 'aria-label': 'Sticks' }, el('h3', {}, 'Sticks'), sticksCv, sticksTxt);
  const speedVal = el('b', { class: 'rp-big' }), altVal = el('b', { class: 'rp-big' });
  const flightCard = el('section', { class: 'gm-card rp-card', 'aria-label': 'Speed and altitude' }, el('h3', {}, 'Speed'),
    el('div', { class: 'rp-kv' }, el('span', {}, speedVal, el('small', {}, ' km/h')), el('span', {}, altVal, el('small', {}, ' m up'))));
  const battV = el('b', { class: 'rp-big' }), battSub = el('p', { class: 'rp-small' });
  const battCard = el('section', { class: 'gm-card rp-card', 'aria-label': 'Battery' }, el('h3', {}, 'Battery'), el('div', {}, battV, el('small', {}, ' V')), battSub);
  const cards = el('div', { class: 'rp-cards' }, sticksCard, flightCard, battCard);
  const lapNow = el('div', { class: 'rp-lapclock lb-time' });
  const splitRows = h.gates.slice(1).map((g, i) => {
    const n = i === h.gates.length - 2 ? 'Finish' : `Gate ${i + 2}`;
    return el('li', { class: 'rp-split' }, el('span', {}, n), el('span', { class: 'lb-time' }, lapClock(g.t)));
  });
  const splitsCard = el('aside', { class: 'gm-card rp-card rp-splits', 'aria-label': 'Splits' }, el('h3', {}, 'Lap'), lapNow, el('ol', {}, ...splitRows));

  // timeline
  const span = Math.max(1e-6, track.t1 - track.t0), frac = (t: number) => (t - track.t0) / span;
  // played part and playhead move by transform (compositor only, no layout per frame)
  const fill = el('div', { class: 'rp-fill' }), head = el('div', { class: 'rp-head' }), headTrack = el('div', { class: 'rp-headtrack' }, head);
  const marks = el('div', { class: 'rp-marks' }, ...h.gates.map((g, i) => el('span', {
    class: `rp-mark${i === 0 || i === h.gates.length - 1 ? ' end' : ''}`, style: { left: `${frac(g.t) * 100}%` },
    title: i === 0 ? 'Start' : i === h.gates.length - 1 ? `Finish · ${lapClock(g.t)}` : `Gate ${i + 1} · ${lapClock(g.t)}`,
  })));
  const timeline = el('div', { class: 'rp-timeline', role: 'slider', tabindex: '0', 'aria-label': 'Replay position', 'aria-valuemin': track.t0.toFixed(2), 'aria-valuemax': track.t1.toFixed(2) },
    el('div', { class: 'rp-rail' }, fill, marks), headTrack);
  const timeTxt = el('span', { class: 'rp-time', 'aria-live': 'off' });
  const playBtn = btn('rp-play', 'Play', 'play', () => { clock.toggle(); }, 'gm-btn primary rp-btn rp-play');
  const loopBtn = btn('rp-loop', 'Loop', 'repeat', () => { clock.loop = prefs.loop = !clock.loop; loopBtn.setAttribute('aria-pressed', String(clock.loop)); });
  loopBtn.setAttribute('aria-pressed', String(clock.loop));
  const speedSeg = el('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Speed' }, ...SPEEDS.map((s, i) => el('button', { class: 'rp-segbtn', 'data-key': `sp-${i}`, 'aria-pressed': 'false', onclick: () => clock.setSpeed(i) }, speedLabel(s))));
  const camSeg = el('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Camera' }, ...CAMS.map((c) => el('button', { class: 'rp-segbtn', 'data-key': `cam-${c}`, 'aria-pressed': 'false', onclick: () => setCam(c) }, c === 'los' ? 'LOS' : CAM_NAMES[c])));
  const controls = el('div', { class: 'rp-controls' },
    btn('rp-restart', 'Restart', 'skipBack', () => clock.restart()),
    btn('rp-stepb', 'Back one frame', 'chevronLeft', () => clock.step(-1)),
    playBtn,
    btn('rp-stepf', 'Forward one frame', 'chevron', () => clock.step(1)),
    loopBtn, timeTxt, el('span', { class: 'gm-spacer' }), speedSeg, camSeg);
  const hints = el('div', { class: 'rp-hints' });
  const bar = el('footer', { class: 'rp-bar' }, timeline, controls, hints);
  const stage = el('div', { class: 'rp-stage' });
  const status = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const toastEl = el('div', { class: 'rp-toast', 'aria-hidden': 'true' });
  const root = el('div', { class: 'rp', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Lap replay: ${formatLap(h.lapMs)} on ${trackName}` }, stage, top, cards, splitsCard, bar, status, toastEl);

  const layoutCards = () => {
    sticksCard.hidden = !prefs.show.sticks; flightCard.hidden = !prefs.show.flight; battCard.hidden = !prefs.show.battery; splitsCard.hidden = !prefs.show.splits;
  };
  const say = (t: string) => { status.textContent = t; };
  /** A short visible message (and the same words for screen readers). */
  let toastTimer = 0;
  const toast = (t: string, ms = 3000, selectable = false) => {
    say(t); toastEl.textContent = t; wake();
    toastEl.classList.toggle('sel', selectable); // a link to copy by hand
    toastEl.style.top = `${Math.round(top.getBoundingClientRect().bottom + 8)}px`; // under the header, however it wraps
    toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
  };
  const copy = async (entry: number) => {
    const at = !clock.playing && clock.t > track.t0 + 0.05 && !clock.atEnd ? clock.t : undefined;
    const url = replayUrl(location.origin, entry, at);
    if (await copyText(url)) toast(at === undefined ? 'Link to this replay copied' : `Link copied: it starts at ${lapClock(at)}`);
    else toast(url, 12_000, true); // clipboard blocked (permissions, an embedded page): select and copy it by hand
  };
  const setCam = (c: Cam) => { prefs.cam = c; say(`${CAM_NAMES[c]} camera`); };
  const save = () => {
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: REPLAY_MIME })), download: `fpv-sim-${h.map}${h.course ? `-${h.course}` : ''}-${formatLap(h.lapMs).replace(/[:.]/g, '-')}.fpvreplay` }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  drawToggles(); layoutCards();

  // ---- input --------------------------------------------------------------------------------
  const seekBy = (s: number) => clock.seek(clock.t + s);
  const allOverlays = () => { const on = !OVERLAYS.some(([k]) => prefs.show[k]); for (const [k] of OVERLAYS) prefs.show[k] = on; drawToggles(); layoutCards(); };
  const overlay: NavOverlay = {
    target: root, el: root, onClose: null,
    move(dir: Dir) { wake(); if (dir === 'left') seekBy(-1); else if (dir === 'right') seekBy(1); else clock.step(dir === 'up' ? 1 : -1); },
    activate() { wake(); clock.toggle(); },
    back() { close(); },
    button(i: number) { wake(); if (i === 2) setCam(CAMS[(CAMS.indexOf(prefs.cam) + 1) % CAMS.length]); else if (i === 3) allOverlays(); else if (i === 4) clock.slower(); else if (i === 5) clock.faster(); },
    key(e: KeyboardEvent) {
      wake();
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = e.key;
      if (k === ' ' || k === 'k' || k === 'K') clock.toggle();
      else if (k === 'ArrowLeft' || k === 'ArrowRight') seekBy((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
      else if (k === 'ArrowUp' || k === 'ArrowDown') clock.step(k === 'ArrowUp' ? 1 : -1);
      else if (k === ',' || k === '.') clock.step(k === '.' ? 1 : -1);
      else if (k === '[') clock.slower();
      else if (k === ']') clock.faster();
      else if (k === 'c' || k === 'C') setCam(CAMS[(CAMS.indexOf(prefs.cam) + (e.shiftKey ? CAMS.length - 1 : 1)) % CAMS.length]);
      else if (k >= '1' && k <= '4') setCam(CAMS[+k - 1]);
      else if (k === 'o' || k === 'O') allOverlays();
      else if (k === 'l' || k === 'L') loopBtn.click();
      else if (k === 'm' || k === 'M') { muted = !muted; say(muted ? 'Sound off' : 'Sound on'); }
      else if (k === 'Home') clock.restart();
      else if (k === 'End') clock.seek(clock.max);
      else return false;
      return true;
    },
    close() { close(); },
  };

  for (const ev of ['pointermove', 'pointerdown', 'wheel'] as const) root.addEventListener(ev, wake, { passive: true });

  // timeline: click / drag to scrub (paused while dragging)
  let scrub: { id: number; was: boolean } | null = null;
  const scrubTo = (x: number) => { const r = timeline.getBoundingClientRect(); clock.seek(track.t0 + Math.max(0, Math.min(1, (x - r.left) / r.width)) * span); };
  timeline.addEventListener('pointerdown', (e) => { scrub = { id: e.pointerId, was: clock.playing }; clock.pause(); timeline.setPointerCapture(e.pointerId); scrubTo(e.clientX); });
  timeline.addEventListener('pointermove', (e) => { if (scrub?.id === e.pointerId) scrubTo(e.clientX); });
  const endScrub = (e: PointerEvent) => { if (scrub?.id !== e.pointerId) return; if (scrub.was && !clock.atEnd) clock.playing = true; scrub = null; };
  timeline.addEventListener('pointerup', endScrub);
  timeline.addEventListener('pointercancel', endScrub);
  // the 3D view: drag turns the orbit camera, the wheel zooms it; a click elsewhere plays / pauses
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  stage.addEventListener('pointerdown', (e) => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (drag?.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    if (prefs.cam !== 'orbit') setCam('orbit');
    orbit.az -= dx * 0.008; orbit.el = Math.max(-0.2, Math.min(1.45, orbit.el + dy * 0.006));
  });
  stage.addEventListener('pointerup', (e) => { if (drag?.id === e.pointerId && !drag.moved) clock.toggle(); drag = null; });
  stage.addEventListener('pointercancel', () => { drag = null; });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); if (prefs.cam !== 'orbit') setCam('orbit'); orbit.dist = Math.max(0.3, Math.min(60, orbit.dist * Math.exp(e.deltaY * 0.0015))); }, { passive: false });
  // the right stick turns the orbit camera, the triggers zoom (standard pads)
  const padOrbit = (dt: number) => {
    if (prefs.cam !== 'orbit') return;
    const g = ui.pads().find((p) => isStandard(p));
    if (!g) return;
    const ax = g.axes[2] ?? 0, ay = g.axes[3] ?? 0, dz = (x: number) => (Math.abs(x) < 0.15 ? 0 : x);
    orbit.az -= dz(ax) * 2.2 * dt; orbit.el = Math.max(-0.2, Math.min(1.45, orbit.el - dz(ay) * 1.6 * dt));
    const zoom = (g.buttons[7]?.value ?? 0) - (g.buttons[6]?.value ?? 0);
    if (Math.abs(zoom) > 0.05) orbit.dist = Math.max(0.3, Math.min(60, orbit.dist * Math.exp(-zoom * 1.5 * dt)));
  };

  // ---- drawing (every frame, from the frame loop) -------------------------------------------
  const shown = { play: '', speed: -1, cam: '' as Cam | '', time: '', lap: '', split: -2, pad: null as boolean | null, sticks: '', flight: '', batt: '', pos: -1 };
  const drawnRc = new Float64Array(4).fill(NaN);
  const drawSticks = () => {
    // only when a stick moved (a paused replay, or a held stick, draws nothing new)
    if (rec[R.rc0] === drawnRc[0] && rec[R.rc1] === drawnRc[1] && rec[R.rc2] === drawnRc[2] && rec[R.rc3] === drawnRc[3]) return;
    drawnRc[0] = rec[R.rc0]; drawnRc[1] = rec[R.rc1]; drawnRc[2] = rec[R.rc2]; drawnRc[3] = rec[R.rc3];
    const c = sticksCv.getContext('2d')!, w = sticksCv.width, hh = sticksCv.height, r = hh / 2 - 6;
    c.clearRect(0, 0, w, hh);
    const gimbal = (cx: number, x: number, y: number) => {
      c.strokeStyle = 'rgba(196,181,253,.45)'; c.lineWidth = 1.5; c.strokeRect(cx - r, hh / 2 - r, 2 * r, 2 * r);
      c.beginPath(); c.moveTo(cx, hh / 2 - r); c.lineTo(cx, hh / 2 + r); c.moveTo(cx - r, hh / 2); c.lineTo(cx + r, hh / 2); c.strokeStyle = 'rgba(196,181,253,.18)'; c.stroke();
      c.fillStyle = '#f43f5e'; c.beginPath(); c.arc(cx + x * r, hh / 2 - y * r, 6, 0, 7); c.fill();
    };
    const n = (v: number) => Math.max(-1, Math.min(1, (v - 1500) / 500));
    gimbal(w / 4, n(rec[R.rc3]), n(rec[R.rc2])); // mode 2: yaw / throttle left
    gimbal((3 * w) / 4, n(rec[R.rc0]), n(rec[R.rc1])); // roll / pitch right
  };
  const drawHints = (pad: boolean) => {
    const g = (cls: string, t: string) => el('span', { class: `gm-glyph ${cls}` }, t);
    const hint = (glyph: HTMLElement, text: string) => el('span', { class: 'gm-hint' }, glyph, text);
    hints.replaceChildren(...(pad
      ? [hint(g('a', 'A'), 'Play / pause'), hint(g('key', 'LB · RB'), 'Speed'), hint(g('key', 'D-pad ←→'), 'Seek'), hint(g('key', '↑↓'), 'Frame'), hint(g('x', 'X'), 'Camera'), hint(g('y', 'Y'), 'Overlays'), hint(g('key', 'R-stick · LT RT'), 'Orbit'), hint(g('b', 'B'), 'Exit')]
      : [hint(g('key', 'Space'), 'Play / pause'), hint(g('key', '← →'), 'Seek'), hint(g('key', '[ ]'), 'Speed'), hint(g('key', ', .'), 'Frame'), hint(g('key', 'C'), 'Camera'), hint(g('key', 'O'), 'Overlays'), hint(g('key', 'L'), 'Loop'), hint(g('key', 'Drag · wheel'), 'Orbit'), hint(g('key', 'Esc'), 'Exit')]));
  };
  const draw = () => {
    const t = clock.t;
    const play = clock.playing ? 'pause' : clock.atEnd ? 'again' : 'play';
    if (play !== shown.play) {
      shown.play = play;
      playBtn.replaceChildren(icon(play === 'pause' ? 'pause' : play === 'again' ? 'rotate' : 'play'));
      playBtn.setAttribute('aria-label', play === 'pause' ? 'Pause' : play === 'again' ? 'Play again' : 'Play'); playBtn.title = playBtn.getAttribute('aria-label')!;
    }
    if (clock.speedIdx !== shown.speed) { shown.speed = clock.speedIdx; speedSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === clock.speedIdx))); }
    if (prefs.cam !== shown.cam) { shown.cam = prefs.cam; camSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(CAMS[i] === prefs.cam))); root.dataset.cam = prefs.cam; }
    // (in 1/20 % steps: a long lap on a wide screen still moves less than a pixel per step)
    const pos = Math.round(Math.max(0, Math.min(1, frac(t))) * 2000);
    if (pos !== shown.pos) { shown.pos = pos; fill.style.transform = `scaleX(${pos / 2000})`; headTrack.style.transform = `translateX(${pos / 20}%)`; }
    const tt = `${lapClock(t)} / ${formatLap(h.lapMs)}`;
    if (tt !== shown.time) { shown.time = tt; timeTxt.textContent = tt; timeline.setAttribute('aria-valuenow', t.toFixed(2)); timeline.setAttribute('aria-valuetext', lapClock(t)); }
    if (prefs.show.splits) {
      const lt = lapClock(Math.max(0, Math.min(t, track.lap)));
      if (lt !== shown.lap) { shown.lap = lt; lapNow.textContent = lt; }
      const k = track.passed(t); // passes done: 1 = started
      if (k !== shown.split) { shown.split = k; splitRows.forEach((row, i) => { row.classList.toggle('done', i + 1 < k); row.classList.toggle('next', i + 1 === k && k > 0); }); }
    }
    if (prefs.show.sticks) {
      drawSticks();
      const m = track.modesAt(t), s = `${rec[R.armed] > 0.5 ? 'ARMED' : 'disarmed'} · ${m & 1 ? 'ANGLE' : m & 2 ? 'HORIZON' : 'ACRO'} · throttle ${Math.round(Math.max(0, Math.min(1, rec[R.thr])) * 100)} %`;
      if (s !== shown.sticks) { shown.sticks = s; sticksTxt.textContent = s; }
    }
    if (prefs.show.flight) {
      const spd = (Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]) * 3.6).toFixed(0), alt = (rec[R.pz] - ctx.map.terrain(rec[R.px], rec[R.py])).toFixed(1);
      if (spd + alt !== shown.flight) { shown.flight = spd + alt; speedVal.textContent = spd; altVal.textContent = alt; }
    }
    if (prefs.show.battery) {
      const s = `${rec[R.vbus].toFixed(2)}|${rec[R.cellV].toFixed(2)} V/cell · ${rec[R.ibus].toFixed(1)} A · ${rec[R.mah].toFixed(0)} mAh`;
      if (s !== shown.batt) { shown.batt = s; const [v, sub] = s.split('|'); battV.textContent = v; battSub.textContent = sub; }
    }
    const pad = ui.usingPad();
    if (pad !== shown.pad) { shown.pad = pad; drawHints(pad); }
    const quiet = clock.playing && !scrub && !drag && performance.now() - lastActive > 2500;
    if (quiet !== idle) { idle = quiet; root.classList.toggle('idle', idle); }
  };

  // ---- the view the frame loop renders -------------------------------------------------------
  const view: ReplayView = {
    frame(now: number) {
      const dt = lastNow ? (now - lastNow) / 1000 : 0;
      lastNow = now;
      if (!scrub) clock.tick(dt);
      padOrbit(Math.min(0.1, dt));
      osd.seek((clock.t - track.t0) * 1000);
      track.sample(clock.t, rec);
      draw();
    },
    sample: (t, o) => track.sample(t, o),
    get time() { return clock.t; },
    get playing() { return clock.playing && !scrub; },
    get speed() { return clock.speed; },
    get seq() { return clock.seq; },
    get cam() { return prefs.cam; },
    orbit,
    get link() { return link; },
    get sound() { return clock.playing && !scrub && clock.speed === 1 && !muted; },
    get nextGate() { return gates.length ? track.passed(clock.t) % gates.length : 0; },
    osd,
    wind: { speed: h.wind?.speed ?? 0, direction: h.wind?.direction ?? 0 },
    close: () => close(),
  };

  const close = () => {
    if (closed) return;
    closed = true;
    exit();
    root.remove();
    const cb = overlay.onClose; overlay.onClose = null; cb?.();
    ui.onClose();
  };

  ui.root.append(root);
  try { exit = enterReplay(ctx, track, world, view); } catch (e) { root.remove(); throw e; }
  // the orbit starts at a distance that suits the quad (1.6 m behind a 5", ~0.5 m behind a 65 mm whoop)
  orbit.dist = 2.2 * Math.max(0.3, Math.min(1.3, ctx.build.info.components.frame.wheelbaseMm / 225));
  ui.open(overlay);
  playBtn.focus({ preventScroll: true });
  say(`Playing the lap replay: ${formatLap(h.lapMs)} on ${trackName}`);
  return { close };
}
