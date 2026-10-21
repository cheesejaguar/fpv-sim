// Full-screen game menu: title screen, New Game (local / multiplayer), server browser, settings,
// Betaflight quick start guide and the in-flight pause menu. Designed with the UI UX Pro Max design
// system (see theme.css); fully usable with a controller, keyboard or mouse (nav.ts).
import './theme.css';
import { DroneBuild, DroneSpec, PRESETS } from '../../builder/derive';
import type { InputManager } from '../../input/gamepad';
import { MAP_LIST } from '../../maps/maps';
import { fetchRooms, RoomListing } from '../../net/lobby';
import { MultiplayerClient, randomRoomCode } from '../../net/multiplayer';
import type { SimSettings } from '../../worker/shared';
import { el } from '../dom';
import { loadPilot, savePilot } from '../multiplayerPanel';
import { cachedStats, DroneStats, droneStats } from './droneStats';
import { CHAPTERS, GuideAction, guideDone, markDone } from './guide';
import { icon, IconName, logo } from './icons';
import { focusEl, focusables, MenuNav } from './nav';

export type GameMode = 'free' | 'race' | 'drill';
type Screen = 'title' | 'pause' | 'new' | 'browser' | 'settings' | 'guide';
type JoinFrom = 'host' | 'code' | 'browser';

export interface SettingsTab { id: string; label: string; icon: IconName; render: () => HTMLElement }

export interface MenuHost {
  input: InputManager;
  mp: MultiplayerClient;
  spec(): DroneSpec;
  applySpec(s: DroneSpec): void;
  sim(): SimSettings;
  applySim(s: SimSettings): void;
  build(): DroneBuild;
  fwStatus(): string;
  settingsTabs: SettingsTab[];
  /** Respawn with a fresh battery and start the chosen mode. */
  startFlight(mode: GameMode): void;
  joinRoom(code: string, room?: { name: string; public: boolean }): void;
  onOpenChange(open: boolean): void;
}

const MODES: { id: GameMode; title: string; sub: string; icon: IconName }[] = [
  { id: 'free', title: 'Free flight', sub: 'No timer, no rules. Explore the map, practise lines and tricks.', icon: 'wind' },
  { id: 'race', title: 'Race', sub: 'Laps and best-lap timing through the gates. The next gate glows.', icon: 'timer' },
  { id: 'drill', title: 'Hover drill', sub: 'Stay inside a 1.5 m sphere for 30 s. Scored, so you can see your throttle control improve.', icon: 'target' },
];

const TIPS = [
  'Pull the throttle all the way down before arming. Betaflight refuses to arm with throttle up.',
  'Press F in flight to see the live gyro noise spectrum and the RPM filter tracking your motors.',
  'Paste your real quad’s “diff all” in Settings → Betaflight to fly your own tune.',
  'Tiny whoops are the most forgiving way to learn: light, slow and nearly crash-proof.',
  'Watch the LQ on the OSD. When link quality drops, turn back before you fail-safe.',
  'Press C to cycle FPV, chase and line-of-sight cameras.',
];

interface NewGameState { mode: GameMode; map: string; preset: number } // preset -1 = current build
const NG_KEY = 'fpv-newgame';
const loadNg = (sim: SimSettings): NewGameState => {
  const d: NewGameState = { mode: 'free', map: sim.mapId, preset: -1 };
  try { const s = localStorage.getItem(NG_KEY); if (s) return { ...d, ...JSON.parse(s), map: sim.mapId }; } catch { /* ignore */ }
  return d;
};

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Quick fly always uses the easiest quad: the 65 mm 1S tiny whoop (slow, light, crash-proof). */
const EASY_IDX = Math.max(0, PRESETS.findIndex((p) => /65 mm/.test(p.name)));
export const EASY_SPEC = PRESETS[EASY_IDX];

/** The pilot's own (non-preset) build, kept when a preset replaces it so it can be picked again. */
const MINE_KEY = 'fpv-spec-mine';
const sameSpec = (a: DroneSpec, b: DroneSpec) => JSON.stringify(a) === JSON.stringify(b);
// (a preset whose only difference is an older camera angle still counts as that preset)
const isPreset = (s: DroneSpec) => PRESETS.some((p) => sameSpec(p, s) || sameSpec(p, { ...s, cameraUptiltDeg: p.cameraUptiltDeg }));
function loadMine(): DroneSpec | null { try { const s = localStorage.getItem(MINE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function keepMine(s: DroneSpec) { if (!isPreset(s)) try { localStorage.setItem(MINE_KEY, JSON.stringify(s)); } catch { /* ignore */ } }

const SCREEN_NAMES: Record<Screen, string> = { title: 'Main menu', pause: 'Paused', new: 'New game', browser: 'Server browser', settings: 'Settings', guide: 'Betaflight quick start' };

export class GameMenu {
  readonly root = el('div', { class: 'gm hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'FPV Sim menu' });
  private top = el('header', { class: 'gm-top' });
  private main = el('main', { class: 'gm-main' });
  private foot = el('footer', { class: 'gm-foot' });
  private stack: Screen[] = ['title'];
  private screenEl: HTMLElement | null = null;
  private nav: MenuNav;
  private openState = false;
  private ng: NewGameState;
  private settingsIdx = 0;
  private chapter = 0;
  private tabs: { count: number; go: (d: -1 | 1) => void } | null = null;
  private timers: number[] = [];
  private tipIdx = Math.floor(Math.random() * TIPS.length);
  /** true once the pilot has flown this session: the title shows "Continue" */
  inFlight = false;

  constructor(private host: MenuHost) {
    this.ng = loadNg(host.sim());
    this.root.append(this.top, this.main, this.foot);
    this.nav = new MenuNav({
      scope: () => this.screenEl ?? this.root,
      back: () => this.back(),
      tab: (d) => this.tabs?.go(d),
      scroller: () => this.screenEl,
    }, () => host.input.pads());
    this.nav.onDevice = () => this.renderFoot();
    host.mp.listen(() => { this.onMp(); if (this.openState) this.renderTop(); });
    // warm the drone-card stats in the background so New Game opens with numbers already there
    const warm = () => { for (const p of PRESETS) void droneStats(p); };
    if ('requestIdleCallback' in window) (window as any).requestIdleCallback(warm, { timeout: 4000 }); else setTimeout(warm, 1500);
  }

  get isOpen() { return this.openState; }
  /** The title screen wants the live orbiting quad behind it instead of the FPV feed. */
  get backdrop() { return this.openState && this.stack[0] === 'title'; }

  open(screen: Screen = this.inFlight ? 'pause' : 'title') {
    this.stack = screen === 'title' || screen === 'pause' ? [screen] : [this.inFlight ? 'pause' : 'title', screen];
    if (!this.openState) { this.openState = true; this.root.classList.remove('hidden'); this.host.onOpenChange(true); this.nav.start(); }
    this.render();
  }

  close() {
    if (!this.openState) return;
    this.openState = false;
    this.root.classList.add('hidden');
    this.clearTimers();
    this.nav.stop();
    this.host.onOpenChange(false);
  }

  /** Close the menu into flight (e.g. after applying a new build). */
  resume() { this.inFlight = true; this.close(); }

  /** Esc / Start in flight. */
  toggle() {
    if (!this.openState) { this.open(); return; }
    if (this.inFlight) this.close();
    else this.quickFly();
  }

  back() {
    if (this.stack.length > 1) { this.stack.pop(); this.render(); return; }
    if (this.stack[0] === 'pause') this.close();
  }

  private go(s: Screen) { this.stack.push(s); this.render(); }

  private clearTimers() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  // -------------------------------------------------------------------------------------------
  /** soft: re-render the same screen after a choice (keeps focus + scroll, no entry animation) */
  private render(soft = false) {
    this.clearTimers();
    this.tabs = null;
    const s = this.stack[this.stack.length - 1];
    const keep = soft ? (document.activeElement as HTMLElement | null)?.dataset?.key : undefined;
    const scrollY = soft ? this.screenEl?.scrollTop ?? 0 : 0;
    const scr = el('section', { class: soft ? 'gm-screen gm-static' : 'gm-screen enter', 'aria-label': s });
    const build = { title: () => this.titleScreen(false), pause: () => this.titleScreen(true), new: () => this.newGame(), browser: () => this.browser(), settings: () => this.settings(), guide: () => this.guide() }[s];
    scr.append(build());
    this.main.replaceChildren(scr);
    this.root.classList.toggle('deep', s !== 'title');
    this.screenEl = scr;
    if (soft) scr.scrollTop = scrollY;
    this.renderTop(); this.renderFoot();
    // live status chips
    this.timers.push(window.setInterval(() => this.renderTop(), 1000));
    // initial focus: the screen's preferred control, else its first one
    requestAnimationFrame(() => {
      const kept = keep ? scr.querySelector<HTMLElement>(`[data-key="${CSS.escape(keep)}"]`) : null;
      if (soft) { if (kept) { if (this.nav.usingPad) focusEl(kept); else kept.focus({ preventScroll: true }); } return; }
      const pref = scr.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(scr)[0];
      if (pref) { if (this.nav.usingPad) focusEl(pref); else pref.focus({ preventScroll: true }); }
    });
  }

  private renderTop() {
    const s = this.stack[this.stack.length - 1];
    const names = SCREEN_NAMES;
    const fw = this.host.fwStatus();
    const pad = this.host.input.active;
    const mp = this.host.mp;
    const chip = (cls: string, text: string, title = '') => el('span', { class: `gm-chip ${cls}`, title }, el('span', { class: 'dot' }), text);
    this.top.replaceChildren(
      el('div', { class: 'gm-brand' }, logo(), el('div', { class: 'gm-wordmark' }, 'FPV SIM', el('small', {}, 'Betaflight in the loop'))),
      this.stack.length > 1 ? el('div', { class: 'gm-crumbs' }, names[this.stack[0]], icon('chevron'), el('b', {}, names[s])) : el('span'),
      el('span', { class: 'gm-spacer' }),
      el('div', { class: 'gm-status', 'aria-live': 'polite' },
        chip(fw ? (/missing|fail|error/i.test(fw) ? 'err' : 'warn') : 'ok', fw ? 'Firmware loading' : 'Betaflight 4.5.5', fw),
        chip(pad ? 'ok' : 'warn', pad ? shortPad(pad.id) : 'Keyboard', pad?.id ?? 'No controller detected: press a button on it'),
        chip(mp.connected ? 'ok' : mp.status === 'connecting' || mp.status === 'reconnecting' ? 'warn' : mp.status === 'error' ? 'err' : '', mp.connected ? `Room ${mp.room} · ${mp.peers.size + 1}` : mp.status === 'connecting' ? 'Connecting…' : mp.status === 'reconnecting' ? 'Reconnecting…' : 'Offline', mp.error || ''),
      ),
    );
  }

  private renderFoot() {
    const pad = this.nav.usingPad;
    const s = this.stack[this.stack.length - 1];
    const g = (cls: string, t: string) => el('span', { class: `gm-glyph ${cls}` }, t);
    const hint = (glyph: HTMLElement, text: string) => el('span', { class: 'gm-hint' }, glyph, text);
    const kids: HTMLElement[] = [hint(pad ? g('a', 'A') : g('key', 'Enter'), 'Select')];
    if (this.stack.length > 1 || s === 'pause') kids.push(el('button', { class: 'gm-hint gm-hint-btn', tabindex: '-1', onclick: () => this.back() }, pad ? g('b', 'B') : g('key', 'Esc'), s === 'pause' ? 'Resume' : 'Back'));
    if (this.tabs) kids.push(hint(pad ? g('key', 'LB · RB') : g('key', 'Q · E'), s === 'guide' ? 'Chapter' : 'Switch tab'));
    kids.push(hint(pad ? g('key', 'D-pad') : g('key', '↑↓←→'), 'Move'));
    if (pad) kids.push(hint(g('key', 'R-stick'), 'Scroll'));
    this.foot.replaceChildren(...kids, el('span', { class: 'gm-spacer' }),
      el('a', { href: 'https://github.com/cheesejaguar/fpv-sim', target: '_blank', rel: 'noopener' }, 'Source (GPL-3.0)'),
      el('a', { href: 'https://betaflight.com/docs/wiki', target: '_blank', rel: 'noopener' }, 'Betaflight docs'));
  }

  // -------------------------------------------------------------------------------------------
  // Title & pause
  private item(o: { icon: IconName; title: string; sub: string; onClick: () => void; primary?: boolean; disabled?: boolean; autofocus?: boolean }) {
    return el('button', { class: `gm-item${o.primary ? ' primary' : ''}`, onclick: o.onClick, disabled: o.disabled, 'data-autofocus': o.autofocus || undefined },
      el('span', { class: 'ico' }, icon(o.icon)),
      el('span', {}, el('span', { class: 't' }, o.title), el('span', { class: 's' }, o.sub)),
      icon('chevron', 'chev'));
  }

  /** Visible back button at the top of every sub-screen (B / Esc do the same). */
  private backBar(): HTMLElement {
    const prev = this.stack[this.stack.length - 2] ?? 'title';
    return el('button', { class: 'gm-btn ghost gm-back', 'data-key': 'back', onclick: () => this.back(), 'aria-label': `Back to ${SCREEN_NAMES[prev]}` },
      icon('back'), `Back to ${SCREEN_NAMES[prev].toLowerCase()}`);
  }

  private quickFly() {
    if (!sameSpec(this.host.spec(), EASY_SPEC)) { keepMine(this.host.spec()); this.host.applySpec(structuredClone(EASY_SPEC)); }
    this.host.startFlight('free');
    this.inFlight = true;
    this.close();
  }

  private titleScreen(paused: boolean): HTMLElement {
    const mp = this.host.mp;
    const items: HTMLElement[] = paused
      ? [
        this.item({ icon: 'play', title: 'Resume', sub: 'Back to the quad', primary: true, autofocus: true, onClick: () => this.close() }),
        this.item({ icon: 'rotate', title: 'Respawn', sub: 'Repaired quad, fresh battery, back on the pad', onClick: () => { this.host.startFlight(this.ng.mode); this.close(); } }),
        this.item({ icon: 'settings', title: 'Settings', sub: 'Betaflight, controller, drone, simulation', onClick: () => this.go('settings') }),
        this.item({ icon: 'book', title: 'Betaflight quick start', sub: 'Arming, modes, rates, PIDs, OSD', onClick: () => this.go('guide') }),
        ...(mp.room && mp.status !== 'idle' ? [this.item({ icon: 'logout', title: 'Leave room', sub: mp.connected ? `Room ${mp.room}, ${mp.peers.size + 1} pilot(s)` : `Room ${mp.room}: ${mp.status === 'error' ? 'disconnected' : 'reconnecting…'}`, onClick: () => { mp.leave(); history.replaceState(null, '', location.pathname); this.render(); } })] : []),
        this.item({ icon: 'home', title: 'Main menu', sub: 'New game, server browser', onClick: () => { this.stack = ['title']; this.render(); } }),
      ]
      : [
        this.item({ icon: 'play', title: this.inFlight ? 'Continue' : 'Quick fly', sub: this.inFlight ? 'Back to the quad' : `Tiny whoop, the easiest quad to fly · ${MAP_LIST[this.host.sim().mapId]?.name.split(' — ')[0] ?? 'Map'}`, primary: true, autofocus: true, onClick: () => (this.inFlight ? this.close() : this.quickFly()) }),
        this.item({ icon: 'plus', title: 'New game', sub: 'Local flight or multiplayer: map, drone and mode', onClick: () => this.go('new') }),
        this.item({ icon: 'server', title: 'Server browser', sub: 'Join a public room and fly with others', onClick: () => this.go('browser') }),
        this.item({ icon: 'settings', title: 'Settings', sub: 'Betaflight, controller, drone, simulation', onClick: () => this.go('settings') }),
        this.item({ icon: 'book', title: 'Betaflight quick start', sub: `${guideDone().size}/${CHAPTERS.length} chapters done`, onClick: () => this.go('guide') }),
      ];
    const b = this.host.build(), info = b.info;
    const pilot = loadPilot();
    const tip = el('p', {}, TIPS[this.tipIdx % TIPS.length]);
    if (!reduced()) this.timers.push(window.setInterval(() => { this.tipIdx++; tip.textContent = TIPS[this.tipIdx % TIPS.length]; }, 8000));
    return el('div', { class: 'gm-title' },
      el('div', {},
        paused ? el('h1', { class: 'gm-hero' }, 'PAUSED') : el('h1', { class: 'gm-hero' }, 'FPV SIM'),
        el('p', { class: 'gm-tagline' }, paused ? 'Disarmed · physics frozen' : 'Real Betaflight · real physics · real latency'),
        paused ? null : this.roomCardView(),
        el('nav', { class: 'gm-mainnav gm-stagger', 'aria-label': 'Main' }, ...items)),
      el('aside', { class: 'gm-side gm-stagger' },
        el('div', { class: 'gm-card gm-pilot' },
          el('h3', {}, 'Pilot'),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
            el('span', { style: { width: '14px', height: '14px', borderRadius: '50%', background: pilot.color, boxShadow: `0 0 12px ${pilot.color}` } }),
            el('b', { style: { fontSize: '18px' } }, pilot.name)),
          el('dl', { class: 'gm-kv' },
            el('dt', {}, 'Drone'), el('dd', {}, b.spec.name),
            el('dt', {}, 'Weight (AUW)'), el('dd', {}, `${info.auwG.toFixed(0)} g`),
            el('dt', {}, 'Thrust / weight'), el('dd', {}, `${info.thrustToWeight.toFixed(1)} : 1`),
            el('dt', {}, 'Hover throttle'), el('dd', {}, `${(info.hoverThrottle * 100).toFixed(0)} %`),
            el('dt', {}, 'Flight time'), el('dd', {}, `≈ ${info.flightTimeMixedMin.toFixed(1)} min`),
            el('dt', {}, 'Video'), el('dd', {}, info.components.video.name))),
        this.host.input.active ? null : el('div', { class: 'gm-card gm-tip' }, el('h3', {}, 'No controller yet'),
          el('p', { style: { marginBottom: '12px' } }, 'Plug in or pair a controller and press any button on it. Browsers only reveal a gamepad after its first input. The keyboard works as a fallback.'),
          el('button', { class: 'gm-btn', onclick: () => this.openSettings('controller') }, icon('gamepad'), 'Controller setup')),
        el('div', { class: 'gm-card gm-tip' }, el('h3', {}, 'Tip'), tip)),
    );
  }

  // -------------------------------------------------------------------------------------------
  // New game
  private saveNg() { try { localStorage.setItem(NG_KEY, JSON.stringify({ mode: this.ng.mode, preset: this.ng.preset })); } catch { /* ignore */ } }

  private tabsBar<T extends string>(ids: { id: T; label: string; icon: IconName }[], cur: T, pick: (id: T) => void): HTMLElement {
    const i = ids.findIndex((x) => x.id === cur);
    this.tabs = { count: ids.length, go: (d) => pick(ids[(i + d + ids.length) % ids.length].id) };
    return el('div', { class: 'gm-tabs', role: 'tablist' },
      ...ids.map((t) => el('button', { class: 'gm-tab', role: 'tab', 'data-key': `tab-${t.id}`, 'aria-selected': String(t.id === cur), onclick: () => pick(t.id) }, icon(t.icon), t.label)));
  }

  private ngTab: 'local' | 'multi' = 'local';

  /** LB / RB switched tabs: put focus on the newly selected tab so the pilot can see where they are. */
  private refocusTab() {
    requestAnimationFrame(() => { const t = this.screenEl?.querySelector<HTMLElement>('.gm-tab[aria-selected="true"]'); if (t && this.nav.usingPad) focusEl(t); });
  }

  private newGame(): HTMLElement {
    const rerender = () => this.render(true);
    const bar = this.tabsBar([{ id: 'local', label: 'Local', icon: 'drone' }, { id: 'multi', label: 'Multiplayer', icon: 'users' }], this.ngTab, (t) => { this.ngTab = t; rerender(); this.refocusTab(); });
    return el('div', {},
      this.backBar(), el('h1', { class: 'gm-h1' }, 'New game'),
      el('p', { class: 'gm-lead' }, this.ngTab === 'local' ? 'Fly solo. Pick a mode, a map and a drone.' : 'Host a room for friends or join one by code. Everyone flies their own quad on their own Betaflight, on a shared map.'),
      bar,
      this.ngTab === 'local' ? this.localBody(rerender) : this.multiBody(rerender));
  }

  private mapTiles(onPick: () => void): HTMLElement {
    return el('div', { class: 'gm-grid gm-stagger' }, ...Object.entries(MAP_LIST).map(([id, m]) =>
      el('button', { class: 'gm-tile', 'data-key': `map-${id}`, 'aria-pressed': String(this.ng.map === id), onclick: () => { this.ng.map = id; onPick(); } },
        el('div', { class: 'art' }, mapArt(id)),
        el('span', { class: 'tt' }, m.name.split(' — ')[0]),
        el('span', { class: 'ts' }, m.name.split(' — ')[1] ?? (m.community ? `by ${m.community.author}` : '')),
        el('span', { class: 'stats' }, ...mapBadges(id)))));
  }

  private droneTiles(onPick: () => void): HTMLElement {
    const cur = this.host.spec(), mine = loadMine();
    const opts: { idx: number; spec: DroneSpec; label: string }[] = [
      { idx: -1, spec: cur, label: 'Your current build' },
      ...(mine && !sameSpec(mine, cur) && !isPreset(mine) ? [{ idx: -2, spec: mine, label: 'Your custom build' }] : []),
      ...PRESETS.map((p, i) => ({ idx: i, spec: p, label: i === EASY_IDX ? 'Easiest · beginner' : p.name.startsWith('Beginner') ? 'Beginner friendly' : 'Preset' })),
    ];
    const badges = (st: DroneStats) => [
      el('span', { class: 'gm-badge' }, `${st.auwG.toFixed(0)} g`),
      el('span', { class: 'gm-badge rose' }, `T/W ${st.tw.toFixed(1)}`),
      el('span', { class: 'gm-badge green' }, `${st.minutes.toFixed(1)} min`)];
    return el('div', { class: 'gm-grid gm-stagger' }, ...opts.map((o) => {
      // current build is already derived; presets come from the stats worker (cached after first time)
      const info = o.idx === -1 ? this.host.build().info : null;
      const known: DroneStats | null = info ? { auwG: info.auwG, tw: info.thrustToWeight, minutes: info.flightTimeMixedMin } : cachedStats(o.spec);
      const stats = el('span', { class: 'stats' }, ...(known ? badges(known) : [el('span', { class: 'gm-badge gm-badge-wait' }, 'measuring…')]));
      if (!known) void droneStats(o.spec).then((st) => { if (st) stats.replaceChildren(...badges(st)); else stats.replaceChildren(); });
      return el('button', { class: 'gm-tile', 'data-key': `drone-${o.idx}`, 'aria-pressed': String(this.ng.preset === o.idx), onclick: () => { this.ng.preset = o.idx; this.saveNg(); onPick(); } },
        el('span', { class: 'ts' }, o.label),
        el('span', { class: 'tt' }, o.spec.name.replace(/^Beginner: /, '')),
        stats);
    }));
  }

  /** Spec for the New Game drone choice (-1 current, -2 the pilot's saved custom build, else a preset). */
  private chosenSpec(): DroneSpec { return this.ng.preset === -2 ? loadMine() ?? this.host.spec() : this.ng.preset >= 0 ? PRESETS[this.ng.preset] ?? this.host.spec() : this.host.spec(); }

  private applyChoices() {
    if (this.ng.preset !== -1) {
      const next = this.chosenSpec();
      if (!sameSpec(next, this.host.spec())) { keepMine(this.host.spec()); this.host.applySpec(structuredClone(next)); }
    }
    if (this.ng.map !== this.host.sim().mapId) this.host.applySim({ ...this.host.sim(), mapId: this.ng.map });
    this.ng.preset = -1; this.saveNg(); // now the current build
  }

  private summary(cta: HTMLElement, extra?: HTMLElement): HTMLElement {
    const mode = MODES.find((m) => m.id === this.ng.mode)!;
    const spec = this.chosenSpec();
    return el('div', { class: 'gm-card gm-sticky' },
      el('h3', {}, 'Ready to fly'),
      el('dl', { class: 'gm-kv', style: { marginBottom: '16px' } },
        el('dt', {}, 'Mode'), el('dd', {}, mode.title),
        el('dt', {}, 'Map'), el('dd', {}, MAP_LIST[this.ng.map]?.name.split(' — ')[0] ?? this.ng.map),
        el('dt', {}, 'Drone'), el('dd', {}, spec.name)),
      extra ?? null,
      cta);
  }

  private localBody(rerender: () => void): HTMLElement {
    const launch = el('button', { class: 'gm-btn cta', style: { width: '100%' }, onclick: () => {
      this.applyChoices();
      this.host.mp.leave(); history.replaceState(null, '', location.pathname);
      this.host.startFlight(this.ng.mode);
      this.inFlight = true; this.close();
    } }, icon('play'), 'LAUNCH');
    return el('div', { class: 'gm-two' },
      el('div', {},
        el('h2', { class: 'gm-section-title' }, '1 · Mode'),
        el('div', { class: 'gm-grid big gm-stagger' }, ...MODES.map((m, i) =>
          el('button', { class: 'gm-tile', 'data-key': `mode-${m.id}`, 'aria-pressed': String(this.ng.mode === m.id), 'data-autofocus': i === 0 || undefined, onclick: () => { this.ng.mode = m.id; if (m.id === 'race' && !MAP_LIST[this.ng.map]?.name.includes('Stadium') && MAP_LIST.field) this.ng.map = 'field'; this.saveNg(); rerender(); } },
            el('span', { class: 'mico' }, icon(m.icon)),
            el('span', { class: 'tt' }, m.title), el('span', { class: 'ts' }, m.sub)))),
        el('h2', { class: 'gm-section-title' }, '2 · Map'),
        this.mapTiles(rerender),
        el('h2', { class: 'gm-section-title' }, '3 · Drone'),
        this.droneTiles(rerender),
        el('p', { class: 'gm-lead', style: { marginTop: '14px' } }, 'Want to change every component? Settings → Drone builder has frames, motors, props, batteries and video systems, with sliders for every number.')),
      el('div', {}, this.summary(launch)));
  }

  // -------------------------------------------------------------------------------------------
  // Multiplayer joins: Host, Join by code and the server browser wait in the menu for the room's
  // welcome ("Joining…", failures inline with Retry); the menu closes into flight only once in.
  private pending: { from: JoinFrom; code: string; room?: { name: string; public: boolean } } | null = null;
  private joinViews: { from: JoinFrom; box: HTMLElement; btn?: HTMLButtonElement; label?: HTMLElement; idle?: string }[] = [];
  private roomCardDraw: (() => void) | null = null;

  private startJoin(from: JoinFrom, code: string, room?: { name: string; public: boolean }) {
    this.pending = { from, code, room };
    this.host.joinRoom(code, room);
    this.drawJoin();
  }

  private cancelJoin() {
    this.pending = null;
    this.host.mp.leave(); history.replaceState(null, '', location.pathname);
    this.drawJoin();
  }

  private onMp() {
    const mp = this.host.mp, p = this.pending;
    // menu closed meanwhile (e.g. Quick fly) or another join replaced this one: forget it
    if (p && (!this.openState || mp.room !== p.code)) this.pending = null;
    else if (p && mp.connected) { this.pending = null; this.host.startFlight('free'); this.inFlight = true; this.close(); return; }
    this.drawJoin();
    this.roomCardDraw?.();
  }

  /** A status slot for one join source (+ its button, which shows "Joining…" while it waits). */
  private joinView(from: JoinFrom, btn?: HTMLButtonElement, label?: HTMLElement): HTMLElement {
    const box = el('div', { role: 'status', 'aria-live': 'polite' });
    this.joinViews.push({ from, box, btn, label, idle: label?.textContent ?? '' });
    return box;
  }

  private drawJoin() {
    const mp = this.host.mp, p = this.pending;
    this.joinViews = this.joinViews.filter((v) => v.box.isConnected); // views of screens since left
    const busy = !!p && mp.status === 'connecting';
    for (const v of this.joinViews) {
      const mine = !!p && p.from === v.from;
      if (v.btn) { v.btn.disabled = busy; v.btn.setAttribute('aria-busy', String(busy && mine)); }
      if (v.label) v.label.textContent = busy && mine ? 'Joining…' : v.idle!;
      if (!mine || !p) { v.box.replaceChildren(); continue; }
      const cancel = el('button', { class: 'gm-btn ghost', onclick: () => this.cancelJoin() }, 'Cancel');
      if (busy) v.box.replaceChildren(el('p', { class: 'gm-room-sub', style: { margin: '10px 0 0' } }, `Joining room ${p.code}…`, ' ', cancel));
      else if (mp.status === 'error') {
        v.box.replaceChildren(el('div', { class: 'gm-callout warn', style: { margin: '12px 0 0' } }, icon('alert'),
          el('div', {}, el('p', {}, mp.error || 'Could not join the room.'),
            el('div', { class: 'gm-actions', style: { marginTop: '10px' } },
              el('button', { class: 'gm-btn primary', 'data-key': `retry-${v.from}`, onclick: () => this.startJoin(p.from, p.code, p.room) }, icon('refresh'), 'Retry'), cancel))));
      } else v.box.replaceChildren();
    }
  }

  /** Title screen while in (or joining) a room, e.g. opened from an invite link: Fly / Leave. */
  private roomCardView(): HTMLElement {
    const mp = this.host.mp;
    const title = el('h3', {}), sub = el('p', { class: 'gm-room-sub', style: { margin: '0 0 12px' } });
    const fly = el('button', { class: 'gm-btn cta', 'data-key': 'room-fly', onclick: () => { this.host.startFlight('free'); this.inFlight = true; this.close(); } }, icon('play'), 'Fly') as HTMLButtonElement;
    const retry = el('button', { class: 'gm-btn primary', 'data-key': 'room-retry', onclick: () => mp.retry() }, icon('refresh'), 'Retry') as HTMLButtonElement;
    const leave = el('button', { class: 'gm-btn ghost', 'data-key': 'room-leave', onclick: () => { mp.leave(); history.replaceState(null, '', location.pathname); } }, icon('logout'), 'Leave');
    const card = el('div', { class: 'gm-card', style: { margin: '0 0 18px', maxWidth: '520px' }, 'aria-live': 'polite' }, title, sub, el('div', { class: 'gm-actions' }, fly, retry, leave));
    const draw = () => {
      card.hidden = !mp.room || mp.status === 'idle';
      if (card.hidden) return;
      const s = mp.status;
      title.textContent = s === 'connected' ? `In room ${mp.room}` : s === 'error' ? `Couldn’t join room ${mp.room}` : s === 'reconnecting' ? `Reconnecting to room ${mp.room}…` : `Joining room ${mp.room}…`;
      sub.textContent = s === 'connected'
        ? [`${mp.peers.size + 1} pilot${mp.peers.size ? 's' : ''}`, mp.latencyMs ? `ping ${Math.round(mp.latencyMs)} ms` : '', ...mp.versionNotes()].filter(Boolean).join(' · ')
        : s === 'connecting' ? 'Connecting to the room server…' : mp.error;
      fly.disabled = s !== 'connected';
      retry.hidden = s !== 'error';
    };
    draw();
    this.roomCardDraw = () => { if (card.isConnected) draw(); };
    this.timers.push(window.setInterval(this.roomCardDraw, 1000)); // ping readout
    return card;
  }

  private multiBody(rerender: () => void): HTMLElement {
    const mp = this.host.mp, pilot = loadPilot();
    const nameIn = el('input', { class: 'gm-input', value: pilot.name, maxlength: 20, 'aria-label': 'Pilot name', oninput: () => { pilot.name = nameIn.value.trim() || 'Pilot'; savePilot(pilot); } }) as HTMLInputElement;
    const colorIn = el('input', { type: 'color', value: pilot.color, 'aria-label': 'Quad colour', oninput: () => { pilot.color = colorIn.value; savePilot(pilot); } }) as HTMLInputElement;
    const roomIn = el('input', { class: 'gm-input', value: `${pilot.name}'s room`, maxlength: 32, 'aria-label': 'Room name' }) as HTMLInputElement;
    // unlisted unless the host opts in: a public room shows the host's callsign to everyone
    const pub = el('input', { type: 'checkbox', checked: false, role: 'switch', 'aria-label': 'List publicly (shows your callsign)' }) as HTMLInputElement;
    const codeIn = el('input', { class: 'gm-input code', placeholder: 'CODE', maxlength: 8, 'aria-label': 'Room code', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const msg = el('p', { class: 'gm-room-sub', role: 'status' });
    const hostLabel = el('span', {}, 'HOST ROOM'), joinLabel = el('span', {}, 'Join');
    const host = el('button', { class: 'gm-btn cta', style: { width: '100%' }, 'data-autofocus': true, onclick: () => {
      this.applyChoices();
      this.startJoin('host', randomRoomCode(), { name: roomIn.value.trim() || `${pilot.name}'s room`, public: pub.checked });
    } }, icon('users'), hostLabel) as HTMLButtonElement;
    const join = el('button', { class: 'gm-btn primary', onclick: () => {
      const c = codeIn.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(c)) { msg.textContent = 'Room codes are 4–8 letters or digits.'; codeIn.focus(); return; }
      msg.textContent = '';
      if (this.ng.preset !== -1) this.applyChoices();
      this.startJoin('code', c);
    } }, icon('logout'), joinLabel) as HTMLButtonElement;
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
    const joinStatus = this.joinView('code', join, joinLabel), hostStatus = this.joinView('host', host, hostLabel);
    queueMicrotask(() => this.drawJoin()); // a join still waiting shows again after a re-render
    return el('div', { class: 'gm-two' },
      el('div', {},
        el('h2', { class: 'gm-section-title' }, 'Pilot'),
        el('div', { class: 'gm-card' },
          el('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' } },
            el('label', { class: 'gm-field', style: { margin: '0' } }, el('span', {}, 'Callsign'), nameIn),
            el('label', { class: 'gm-field', style: { margin: '0' } }, el('span', {}, 'Colour'), colorIn))),
        el('h2', { class: 'gm-section-title' }, 'Join by code'),
        el('div', { class: 'gm-card' },
          el('div', { style: { display: 'flex', gap: '12px' } }, codeIn, join), msg, joinStatus,
          el('p', { class: 'gm-room-sub', style: { margin: '10px 0 0' } }, 'Or open an invite link: it joins the room automatically.')),
        el('h2', { class: 'gm-section-title' }, 'Room map'),
        this.mapTiles(rerender),
        el('h2', { class: 'gm-section-title' }, 'Your drone'),
        this.droneTiles(rerender)),
      el('div', {}, this.summary(el('div', {}, host, hostStatus), el('div', {},
        el('label', { class: 'gm-field' }, el('span', {}, 'Room name'), roomIn),
        el('label', { class: 'gm-switch', style: { marginBottom: '14px' } }, pub, el('span', {}, 'List publicly (shows your callsign)')),
        mp.connected ? el('p', { class: 'gm-room-sub' }, `You are in room ${mp.room}. Hosting a new room leaves it.`) : null)),
      el('button', { class: 'gm-btn ghost', style: { width: '100%', marginTop: '12px' }, onclick: () => this.go('browser') }, icon('server'), 'Browse public rooms')));
  }

  // -------------------------------------------------------------------------------------------
  // Server browser
  private filters = { q: '', map: '', hideFull: false };
  private rooms: { list: RoomListing[]; latency: number; error: string | null; loading: boolean; at: number } = { list: [], latency: 0, error: null, loading: false, at: 0 };

  private browser(): HTMLElement {
    const tbody = el('tbody');
    const meta = el('span', { class: 'gm-chip' }, el('span', { class: 'dot' }), '…');
    const empty = el('div');
    const refreshBtn = el('button', { class: 'gm-btn', onclick: () => void load() }, icon('refresh'), 'Refresh') as HTMLButtonElement;
    const draw = () => {
      const r = this.rooms, f = this.filters;
      meta.className = `gm-chip ${r.error ? 'err' : r.loading ? 'warn' : 'ok'}`;
      meta.lastChild!.textContent = r.loading ? 'Refreshing…' : r.error ? 'Server unreachable' : `${r.list.length} room${r.list.length === 1 ? '' : 's'} · ${Math.round(r.latency)} ms`;
      refreshBtn.disabled = r.loading;
      if (r.loading && !r.list.length) {
        tbody.replaceChildren(...[0, 1, 2].map(() => el('tr', { class: 'gm-row gm-skel' }, ...[0, 1, 2, 3, 4].map(() => el('td', {}, el('span', {}, '.'))))));
        empty.replaceChildren();
        return;
      }
      const q = f.q.toLowerCase();
      const rows = r.list.filter((x) => (!q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q) || x.code.toLowerCase().includes(q)) && (!f.map || x.map === f.map) && (!f.hideFull || x.players < x.max));
      tbody.replaceChildren(...rows.map((x) => {
        const full = x.players >= x.max;
        const joinIt = () => { if (full || (this.pending && this.host.mp.status === 'connecting')) return; this.startJoin('browser', x.code); };
        const tr = el('tr', { class: 'gm-row', tabindex: '0', role: 'button', 'aria-label': `Join ${x.name}, ${x.players} of ${x.max} pilots`, 'aria-disabled': full ? 'true' : undefined, onclick: joinIt, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinIt(); } } },
          el('td', {}, el('div', { class: 'gm-room-name' }, x.name), el('div', { class: 'gm-room-sub' }, `hosted by ${x.host}`)),
          el('td', {}, x.map ? MAP_LIST[x.map]?.name.split(' — ')[0] ?? x.map : '—'),
          el('td', {}, el('span', { class: 'gm-cap' }, el('span', { class: 'gm-capbar' }, el('i', { style: { width: `${(100 * x.players) / x.max}%` } })), `${x.players}/${x.max}`)),
          el('td', {}, el('code', { style: { letterSpacing: '.15em' } }, x.code)),
          el('td', {}, full ? el('span', { class: 'gm-badge rose' }, 'FULL') : el('span', { class: 'gm-badge green' }, 'JOIN')));
        return tr;
      }));
      if (r.error) empty.replaceChildren(el('div', { class: 'gm-empty' }, icon('wifiOff'), el('h4', {}, 'Can’t reach the room server'), el('p', {}, r.error), el('p', {}, 'You can still join with a code, or host a room under New game → Multiplayer.')));
      else if (!rows.length) empty.replaceChildren(el('div', { class: 'gm-empty' }, icon('globe'), el('h4', {}, r.list.length ? 'No rooms match your filters' : 'No public rooms right now'),
        el('p', {}, r.list.length ? 'Clear the search or show full rooms.' : 'Be the first: host a public room and it shows up here for everyone.'),
        el('div', { class: 'gm-actions', style: { justifyContent: 'center', marginTop: '12px' } }, el('button', { class: 'gm-btn primary', onclick: () => { this.ngTab = 'multi'; this.stack[this.stack.length - 1] = 'new'; this.render(); } }, icon('plus'), 'Host a room'))));
      else empty.replaceChildren();
    };
    const load = async () => {
      if (this.rooms.loading) return;
      this.rooms.loading = true; draw();
      const r = await fetchRooms();
      this.rooms = { list: r.rooms, latency: r.latencyMs, error: r.error, loading: false, at: Date.now() };
      if (this.screenEl?.contains(tbody)) draw();
    };
    const search = el('input', { class: 'gm-input', placeholder: 'Search rooms, hosts or codes', value: this.filters.q, 'aria-label': 'Search rooms', oninput: () => { this.filters.q = search.value; draw(); } }) as HTMLInputElement;
    const mapSel = el('select', { class: 'gm-input', style: { maxWidth: '260px' }, 'aria-label': 'Filter by map', onchange: () => { this.filters.map = mapSel.value; draw(); } },
      el('option', { value: '' }, 'All maps'), ...Object.entries(MAP_LIST).map(([id, m]) => el('option', { value: id, selected: this.filters.map === id }, m.name.split(' — ')[0]))) as HTMLSelectElement;
    const hideFull = el('input', { type: 'checkbox', checked: this.filters.hideFull, role: 'switch', onchange: () => { this.filters.hideFull = hideFull.checked; draw(); } }) as HTMLInputElement;
    draw();
    void load();
    this.timers.push(window.setInterval(() => void load(), 10_000));
    const joinStatus = this.joinView('browser');
    queueMicrotask(() => this.drawJoin());
    return el('div', {},
      this.backBar(), el('h1', { class: 'gm-h1' }, 'Server browser'),
      el('p', { class: 'gm-lead' }, 'Public rooms on the FPV Sim relay. Up to 8 pilots per room, each on their own Betaflight. The list refreshes every 10 seconds.'),
      el('div', { class: 'gm-toolbar' }, search, mapSel, el('label', { class: 'gm-switch' }, hideFull, el('span', {}, 'Hide full')), el('span', { class: 'gm-spacer', style: { flex: '1' } }), meta, refreshBtn,
        el('button', { class: 'gm-btn primary', 'data-autofocus': true, onclick: () => { this.ngTab = 'multi'; this.stack[this.stack.length - 1] = 'new'; this.render(); } }, icon('plus'), 'Host')),
      joinStatus,
      el('table', { class: 'gm-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Room'), el('th', {}, 'Map'), el('th', {}, 'Pilots'), el('th', {}, 'Code'), el('th', {}, ''))),
        tbody),
      empty);
  }

  // -------------------------------------------------------------------------------------------
  // Settings (hosts the existing configuration panels)
  openSettings(tabId: string) {
    const i = this.host.settingsTabs.findIndex((t) => t.id === tabId);
    if (i >= 0) this.settingsIdx = i;
    if (!this.openState) this.open('settings');
    else { this.stack.push('settings'); this.render(); }
  }

  private settings(): HTMLElement {
    const tabs = this.host.settingsTabs;
    const t = tabs[this.settingsIdx] ?? tabs[0];
    const panel = el('div', { class: 'gm-settings' });
    try { panel.append(t.render()); } catch (e) { panel.append(el('p', {}, `This panel failed to load: ${(e as Error).message}`)); }
    const bar = this.tabsBar(tabs.map((x) => ({ id: x.id, label: x.label, icon: x.icon })), t.id, (id) => { this.settingsIdx = tabs.findIndex((x) => x.id === id); this.render(true); this.refocusTab(); });
    return el('div', {}, this.backBar(), el('h1', { class: 'gm-h1' }, 'Settings'), bar, panel);
  }

  // -------------------------------------------------------------------------------------------
  // Betaflight quick start guide
  private guide(): HTMLElement {
    const done = guideDone();
    const c = CHAPTERS[this.chapter] ?? CHAPTERS[0];
    markDone(c.id);
    const goCh = (i: number) => { this.chapter = Math.max(0, Math.min(CHAPTERS.length - 1, i)); this.render(true); if (this.screenEl) this.screenEl.scrollTop = 0; };
    this.tabs = { count: CHAPTERS.length, go: (d) => goCh(this.chapter + d) };
    const art = el('article', { class: 'gm-article', 'aria-labelledby': 'gm-ch-title' });
    const body = el('div');
    body.innerHTML = c.html; // static content from guide.ts
    const act = (a: GuideAction) => {
      if (a === 'fly') { if (this.inFlight) this.close(); else { this.ng.mode = c.id === 'modes' ? 'drill' : this.ng.mode; this.quickFly(); } return; }
      this.openSettings({ bf: 'bf', controller: 'controller', builder: 'builder', sim: 'sim' }[a]);
    };
    art.append(
      el('div', { class: 'gm-tagline', style: { margin: '0 0 6px' } }, `Chapter ${this.chapter + 1} of ${CHAPTERS.length} · ${c.minutes} min read`),
      el('h2', { id: 'gm-ch-title' }, c.title),
      body,
      c.figure ? c.figure() : el('span'),
      c.actions?.length ? el('div', { class: 'gm-actions', style: { marginTop: '18px' } }, ...c.actions.map((x) => el('button', { class: 'gm-btn primary', onclick: () => act(x.go) }, icon(x.go === 'fly' ? 'play' : x.go === 'controller' ? 'gamepad' : 'cpu'), x.label))) : el('span'),
      el('div', { class: 'gm-steps-nav' },
        el('button', { class: 'gm-btn ghost', 'data-key': 'ch-prev', disabled: this.chapter === 0, onclick: () => goCh(this.chapter - 1) }, icon('chevronLeft'), 'Previous'),
        this.chapter < CHAPTERS.length - 1
          ? el('button', { class: 'gm-btn primary', 'data-key': 'ch-next', 'data-autofocus': true, onclick: () => goCh(this.chapter + 1) }, `Next: ${CHAPTERS[this.chapter + 1].title}`, icon('chevron'))
          : el('button', { class: 'gm-btn cta', 'data-autofocus': true, onclick: () => act('fly') }, icon('play'), 'FLY')));
    return el('div', {},
      this.backBar(), el('h1', { class: 'gm-h1' }, 'Betaflight quick start'),
      el('p', { class: 'gm-lead' }, 'Everything a new pilot needs to know about the firmware on their quad, using the real Betaflight that runs in this sim.'),
      el('div', { class: 'gm-guide' },
        el('nav', { class: 'gm-chapters', 'aria-label': 'Chapters' }, ...CHAPTERS.map((x, i) =>
          el('button', { class: `gm-chapter${done.has(x.id) && i !== this.chapter ? ' done' : ''}`, 'data-key': `ch-${i}`, 'aria-current': i === this.chapter ? 'step' : undefined, onclick: () => goCh(i) },
            el('span', { class: 'n' }, done.has(x.id) && i !== this.chapter ? icon('check') : String(i + 1)), x.title))),
        art));
  }
}

// ---------------------------------------------------------------------------------------------
function shortPad(id: string): string {
  const s = id.replace(/\(.*?\)/g, '').replace(/STANDARD GAMEPAD/i, '').replace(/Vendor:.*$/i, '').trim();
  return (s || 'Controller').slice(0, 24);
}

function mapBadges(id: string): HTMLElement[] {
  const m = MAP_LIST[id];
  const b = (t: string, c = '') => el('span', { class: `gm-badge ${c}` }, t);
  if (id === 'field') return [b('Race gates', 'rose'), b('Outdoor')];
  if (id === 'bando') return [b('Freestyle'), b('Indoor + outdoor')];
  if (id.startsWith('quake')) return [b('Indoor'), b('Classic', 'green')];
  if (id.startsWith('freedoom')) return [b('Indoor'), b('Classic', 'green')];
  return [b(m?.community?.local ? 'From disk' : 'Community', 'green')];
}

/** Small generated illustrations for map tiles (no image assets needed). */
function mapArt(id: string): SVGSVGElement {
  const t = document.createElement('template');
  const sky = id === 'field' ? ['#4c1d95', '#0f0f23'] : id === 'bando' ? ['#334155', '#0f172a'] : id.startsWith('quake') ? ['#7c2d12', '#1c0f0a'] : id.startsWith('freedoom') ? ['#14532d', '#0a1a10'] : ['#1e3a8a', '#0f0f23'];
  let scene: string;
  if (id === 'field') scene = `<ellipse cx="160" cy="98" rx="150" ry="34" fill="#1e1c35" stroke="#a78bfa" stroke-opacity=".5"/><ellipse cx="160" cy="98" rx="110" ry="22" fill="#166534" opacity=".7"/>
    ${[70, 130, 190, 250].map((x, i) => `<rect x="${x}" y="${62 - i * 2}" width="26" height="22" rx="3" fill="none" stroke="${i === 1 ? '#f43f5e' : '#c4b5fd'}" stroke-width="3"/>`).join('')}
    <path d="M0 60 L30 30 L290 30 L320 60" fill="none" stroke="#a78bfa" stroke-opacity=".35" stroke-width="6"/>`;
  else if (id === 'bando') scene = `<rect x="40" y="30" width="120" height="70" fill="#475569"/><rect x="170" y="45" width="90" height="55" fill="#334155"/>
    ${[0, 1, 2, 3].map((i) => `<rect x="${52 + i * 27}" y="44" width="16" height="16" fill="#0f172a"/><rect x="${52 + i * 27}" y="70" width="16" height="16" fill="#0f172a"/>`).join('')}
    <rect x="186" y="60" width="22" height="40" fill="#0f172a"/><path d="M0 100 H320" stroke="#64748b" stroke-width="4"/>`;
  else if (id.startsWith('quake') || id.startsWith('freedoom')) {
    const c = id.startsWith('quake') ? '#b45309' : '#16a34a';
    scene = `<path d="M20 100 L20 40 L90 26 L90 100 Z M110 100 L110 20 L210 20 L210 100 Z M230 100 L230 26 L300 40 L300 100 Z" fill="${c}" opacity=".45"/>
      <path d="M110 100 L140 60 L180 60 L210 100" fill="#000" opacity=".45"/><path d="M0 100 H320" stroke="${c}" stroke-width="4"/>`;
  } else scene = `<path d="M0 100 Q80 50 160 80 T320 60 V120 H0Z" fill="#1d4ed8" opacity=".4"/><circle cx="250" cy="34" r="14" fill="#fbbf24" opacity=".8"/>`;
  t.innerHTML = `<svg viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="sk-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs><rect width="320" height="120" fill="url(#sk-${id})"/>${scene}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
