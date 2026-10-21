// Feeds the in-flight HUD every frame: notices, key hints for the device in use, the arming coach,
// telemetry, race / drill panel, crash banner (+ rumble and impact sound), and lays it out around the OSD.
import { buttonName } from '../input/gamepad';
import { webHidSupported } from '../input/steamHid';
import { el, touchOnly } from '../ui/dom';
import { armingAdvice, CoachGlyphs } from '../ui/hud/coach';
import { Hud, KeyHint, osdRects } from '../ui/hud/hud';
import { newestTime, R, sampleRing } from '../worker/shared';
import type { AppCtx } from './context';
import type { SpectrumView, SticksView } from './instruments';
import { raceInfo, updateDrill } from './race';

const KB_HINTS: KeyHint[] = [['Esc', 'Menu'], ['W S', 'Throttle'], ['A D', 'Yaw'], ['↑↓←→', 'Pitch / roll'], ['Space', 'Arm'], ['1-3', 'Mode'], ['T', 'Turtle'], ['R', 'Respawn'], ['B', 'Fresh battery'], ['C', 'Camera'], ['H', 'Telemetry'], ['G', 'Drill'], ['F', 'Spectrum'], ['V', 'DVR']].map(([glyph, label]) => ({ glyph, cls: 'key', label }));
// phones / tablets without a keyboard or controller: only the (tappable) menu chip makes sense
const TOUCH_HINTS: KeyHint[] = [{ glyph: '☰', cls: 'key', label: 'Menu' }];
const KB_GLYPHS: CoachGlyphs = { arm: 'Space', respawn: 'R', throttleUp: 'W', throttleDown: 'S', keyboard: true };
const DPAD: Record<number, string> = { 12: '↑', 13: '↓', 14: '←', 15: '→' };

/** Set once the pilot has flown (armed for a few seconds): the first-flight steps stop showing. */
const FLOWN_KEY = 'fpv-flown';
const hasFlown = () => { try { return localStorage.getItem(FLOWN_KEY) === '1'; } catch { return true; } };

export class HudController {
  readonly hud: Hud;
  private hidStatus = el('p', { class: 'sub' });
  // Shown while no controller is available. The 2026 Steam Controller is never visible to the
  // Gamepad API (outside Steam it acts as keyboard + mouse), so offer the direct WebHID driver.
  private padNotice: HTMLElement;
  // Phones / tablets: there is no keyboard to fall back on.
  private touchNotice = el('div', { class: 'card notice warn' }, el('b', {}, 'No controller'), el('p', {}, 'Pair a Bluetooth gamepad, then press a button on it. FPV Sim has no touch controls: tap Menu to go back.'));
  // Radios / HID joysticks with an unknown stick layout: point at the setup wizard.
  private setupNotice = el('div', { class: 'card notice' }, el('b', {}, 'New controller'), el('p', {}, 'Run the stick & switch setup once: Esc, Settings, Controller.'));
  private radioNotice = el('div', { class: 'card notice' }, el('b', {}, 'Radio connected'), el('p', {}, 'Set up its sticks and switches once (Esc, Settings, Controller): every radio orders its channels differently. Until then it flies nothing; the keyboard still works.'));
  private fwNotice = el('div', { class: 'card notice status' });
  private lostNotice = el('div', { class: 'card notice warn status' }, el('b', {}, 'VIDEO SIGNAL LOST'), el('p', {}, 'Fly back toward yourself, or respawn: A / ✕ on a controller, R on the keyboard.'));
  // Browsers block audio until a click / key press on the page (controller buttons don't count).
  private soundChip = el('div', { class: 'chip' }, 'Click or press a key to enable sound');
  // multiplayer: the room connection dropped (retrying with backoff) or was given up
  private mpTitle = el('b');
  private mpText = el('p');
  private mpNotice = el('div', { class: 'card notice warn status' }, this.mpTitle, this.mpText);
  private lostSince = -1;
  private armedSince = -1;
  private layoutAt = 0;
  private lastCrash: string | null = null;
  private newPilot = !hasFlown();

  constructor(private ctx: AppCtx, private sticks: SticksView, private spectrum: SpectrumView) {
    this.hud = new Hud(sticks.canvas, spectrum.canvas);
    const k = (t: string) => el('kbd', {}, t);
    this.padNotice = el('div', { class: 'card notice warn' },
      el('b', {}, 'No controller: keyboard fallback'),
      el('p', { class: 'keys-line' }, k('W'), ' / ', k('S'), ' throttle · ', k('A'), ' / ', k('D'), ' yaw · arrow keys pitch / roll · ', k('Space'), ' arm'),
      el('p', {}, 'Connect a controller, then press a button on it: browsers only reveal a gamepad after its first input.'),
      ...(webHidSupported()
        ? [el('p', { class: 'sub' }, 'Steam Controller (2026) without Steam Input: connect it by USB or its dongle, then'), el('button', { onclick: () => void ctx.input.steamHid.request() }, 'Connect Steam Controller')]
        // Safari / Firefox: no WebHID, which the 2026 Steam Controller's direct connection needs
        : [el('p', { class: 'sub' }, 'Steam Controller (2026) needs Chrome or Edge (WebHID), or Steam Input.')]),
      this.hidStatus);
  }

  /** Key hints for what is in use: keyboard keys, or this controller's own buttons (by family). */
  keyHints(): KeyHint[] {
    const input = this.ctx.input, pad = input.active;
    if (!pad) return touchOnly() ? TOUCH_HINTS : KB_HINTS;
    const p = input.profileFor(pad), acts = input.actionButtons(pad, p);
    const btn = (i: number) => ({ glyph: DPAD[i] ?? buttonName(p.kind, i).replace(/ \(\d+\)$/, '').replace(/^button /, '#'), cls: DPAD[i] ? 'sh' : (['a', 'b', 'x', 'y'][i] ?? 'sh') });
    const out: KeyHint[] = [];
    const add = (i: number | null | undefined, label: string) => { if (i != null) out.push({ ...btn(i), label }); };
    const sw = (b: { index: number; src?: string } | null) => (b && (b.src ?? 'button') === 'button' ? b.index : null);
    add(p.menu, 'Menu'); if (!out.length) out.push({ glyph: 'Esc', cls: 'key', label: 'Menu' });
    add(sw(p.arm), 'Arm'); add(sw(p.mode), 'Mode'); add(p.reset, 'Respawn'); add(acts.battery, 'Fresh battery');
    add(sw(p.turtle), 'Turtle'); add(acts.camera, 'Camera'); add(acts.telemetry, 'Telemetry'); add(acts.drill, 'Drill'); add(acts.spectrum, 'Spectrum');
    p.aux?.forEach((b, i) => { if (b?.src === 'button') add(b.index, `AUX${i + 5}`); });
    return out;
  }

  /** Names of the arm / respawn controls for the arming coach. */
  private coachGlyphs(hints: KeyHint[]): CoachGlyphs {
    if (!this.ctx.input.active) return KB_GLYPHS;
    const find = (label: string) => hints.find((h) => h.label === label)?.glyph;
    return { arm: find('Arm') ?? 'arm switch', respawn: find('Respawn') ?? 'Esc → Respawn', throttleUp: 'left stick', throttleDown: 'left stick', keyboard: false };
  }

  update() {
    const ctx = this.ctx, hud = this.hud, rec = ctx.rec, view = ctx.view, input = ctx.input, tel = ctx.tel;
    hud.setVisible(!ctx.menuOpen);
    if (ctx.menuOpen) return;
    const now = performance.now();
    const head = newestTime(ctx.sh);
    sampleRing(ctx.sh, head, rec);
    const armed = rec[R.armed] > 0.5;
    if (armed && this.armedSince < 0) this.armedSince = now; else if (!armed) this.armedSince = -1;
    if (this.newPilot && armed && now - this.armedSince > 5000) { this.newPilot = false; try { localStorage.setItem(FLOWN_KEY, '1'); } catch { /* ignore */ } }
    const video = ctx.build.info.components.video;
    // notices: only the ones that matter right now, and controller help only while disarmed
    setText(this.hidStatus, input.steamHid.status);
    setText(this.fwNotice, ctx.fwStatus);
    const notices: HTMLElement[] = [];
    if (ctx.fwStatus) notices.push(this.fwNotice);
    // digital link down for more than a moment: say so, and how to get the quad back
    const vLost = view.view === 'fpv' && video.kind === 'digital' && (ctx.link.state.lost > 0 || ctx.link.state.freeze);
    if (vLost && this.lostSince < 0) this.lostSince = now; else if (!vLost) this.lostSince = -1;
    if (vLost && now - this.lostSince > 1200) notices.push(this.lostNotice);
    if (!input.active && !armed) notices.push(touchOnly() ? this.touchNotice : this.padNotice);
    if (input.blocked) notices.push(this.radioNotice);
    else if (input.active && input.profileFor(input.active).needsSetup && !armed) notices.push(this.setupNotice);
    if (ctx.audio.blocked) notices.push(this.soundChip);
    { // multiplayer connection notice
      const mp = ctx.mp;
      if (mp.room && (mp.status === 'reconnecting' || mp.status === 'error')) {
        const t = mp.status === 'reconnecting' ? 'Room connection lost — reconnecting…' : 'Disconnected from room';
        const p = mp.status === 'reconnecting' ? `Room ${mp.room}, attempt ${mp.attempt} of ${mp.maxAttempts}. Keep flying; other pilots reappear when it is back.` : `${mp.error} To leave or retry: Esc, then Leave room (or Settings, Multiplayer).`;
        if (this.mpTitle.textContent !== t) this.mpTitle.textContent = t;
        if (this.mpText.textContent !== p) this.mpText.textContent = p;
        notices.push(this.mpNotice);
      }
    }
    hud.notices(notices);
    // key hints collapse to a single "menu" chip a few seconds after arming
    const hints = this.keyHints();
    hud.keys(hints, this.armedSince >= 0 && now - this.armedSince > 3000);
    // arming coach: why Betaflight refuses to arm (and the fix), first-flight steps for new pilots
    hud.coach(!armed && tel && !ctx.fwStatus && (input.active || !touchOnly()) ? armingAdvice({ flags: tel.armingFlagNames, armRequested: input.armed, newPilot: this.newPilot, glyphs: this.coachGlyphs(hints) }) : null);
    if (view.telemetry && tel) {
      const b = tel.battery;
      const spd = Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]) * 3.6;
      const rpm = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]].map((r) => Math.abs(r).toFixed(0).padStart(5)).join(' ');
      const modes = tel.modeFlags;
      hud.tel([
        `${tel.fw}  sim ${(tel.simRate).toFixed(1)}× rt  ${tel.stepCostUs.toFixed(0)} µs`,
        `${Atomics.load(ctx.sh.ctrl, 5) ? 'ARMED' : 'disarmed'}  ${modes & 1 ? 'ANGLE' : modes & 2 ? 'HORIZON' : 'ACRO'}${rec[R.crashFlip] ? '  TURTLE' : ''}${tel.armingFlagNames.length ? '  blocked: ' + tel.armingFlagNames.join(',') : ''}`,
        `batt ${b.v.toFixed(2)} V  ${b.cellV.toFixed(2)} V/cell  ${b.i.toFixed(1)} A  sag ${b.sag.toFixed(2)} V`,
        `     ${b.mah.toFixed(0)} mAh  SoC ${(b.soc * 100).toFixed(0)} %  ${b.tempC.toFixed(1)} °C`,
        `rpm ${rpm}`,
        `motor °C ${tel.motorTemps.map((t) => t.toFixed(0)).join(' ')}`,
        `${spd.toFixed(0)} km/h  alt ${(rec[R.pz] - ctx.map.terrain(rec[R.px], rec[R.py])).toFixed(1)} m  wash ${(rec[R.vrs] * 100).toFixed(0)} %`,
        `video ${ctx.link.state.distance.toFixed(0)} m  ${ctx.link.state.rssiDbm.toFixed(0)} dBm${video.kind === 'analog' ? `  CNR ${ctx.link.state.cnr.toFixed(0)} dB` : ''}`,
        `props ${tel.rotorDamage.map((d) => (d.broken ? 'BROKEN' : `${(d.thrust * 100).toFixed(0)}%`)).join(' ')}`,
        ...ctx.logLines.slice(-2),
      ]);
      hud.sticks(true);
      this.sticks.draw(input.channels);
    } else { hud.tel(null); hud.sticks(false); }
    hud.spectrum(this.spectrum.shown);
    hud.race(raceInfo(ctx), updateDrill(ctx, head, armed), now);
    // crash banner; haptic thump + impact sound on a new crash, scaled by impact speed ("Impact 12.3 m/s")
    const crash = tel?.crash ?? null;
    hud.crash(crash ? crash.toUpperCase() : null);
    if (crash && crash !== this.lastCrash) {
      const v = parseFloat(crash.match(/\d+(\.\d+)?/)?.[0] ?? '') || 8; // first number: the impact speed
      input.rumble(Math.min(1, v / 15), Math.min(1, v / 25), 180 + Math.min(320, v * 15));
      const p = ctx.pilot;
      ctx.audio.impact(Math.min(1, v / 12), view.view === 'chase' ? 2 : Math.hypot(rec[R.px] - p.x, rec[R.py] - p.y, rec[R.pz] - p.z));
    }
    this.lastCrash = crash;
    // place everything around the OSD (~8 Hz: cheap, and widgets don't jitter)
    if (now - this.layoutAt > 120) {
      this.layoutAt = now;
      hud.layout(this.osdCells(), view.view === 'fpv' ? ctx.fpv.layout.frame : null);
    }
  }

  /** Screen rects the HUD keeps clear of: the drawn Betaflight OSD characters and the goggles' own
   *  overlay (signal, bitrate, DVR); none in spectator views. */
  osdCells() {
    const ctx = this.ctx, osd = ctx.osd;
    if (ctx.view.view !== 'fpv') return [];
    return [...(ctx.view.osd && osd.hasContent ? osdRects(osd.occupied, osd.cols, osd.rows, ctx.fpv.layout.osd) : []), ...ctx.fpv.layout.goggle];
  }
}

/** Only touch the DOM when the text actually changes (the HUD is fed every frame). */
function setText(n: HTMLElement, t: string) { if (n.textContent !== t) n.textContent = t; }
