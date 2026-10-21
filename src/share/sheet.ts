// Game menu screen: share a lap as a 9:16 card for Instagram Stories. A carousel of card styles with
// live previews (stats, drone, FPV moment, track map, leaderboard), three colour themes, and the
// ways out: the system share sheet where there is one (Instagram on phones), Download PNG, Copy
// image, and "Send to my phone" (a QR code: the phone draws the same cards and shares them).
// Loaded lazily by GameMenu (gameMenu.ts); controller and keyboard navigable through MenuNav.
import { CUSTOM } from '../../server/src/leaderboardCore';
import { defaultInitials, LapBoard, onBoard, pbKey } from '../app/leaderboard';
import type { DroneBuild, DroneSpec } from '../builder/derive';
import { droneClass } from '../builder/droneClass';
import { type BoardEntry, fetchReplay } from '../net/leaderboard';
import { el } from '../ui/dom';
import { icon } from '../ui/menu/icons';
import { trackLabelOf } from '../ui/menu/leaderboard';
import { detectEnv, PhoneLink, shareUi } from './actions';
import type { PbShots } from './capture';
import { CardDeck } from './deck';
import { buildOffThread, DroneData, droneChips, droneName, droneShot, fromBuild, specForClass } from './droneShot';
import { classLabel, fmtLap, SITE } from './layout';
import { shareUrl } from './link';
import { drawQr, encodeQr } from './qr';
import { trackInfo } from './trackInfo';
import { trailFromReplay } from './trail';
import { CARD_STYLES, CardStyle, Palette, paletteOf, PALETTES, ShareLap } from './types';
import { actionButtons, injectShareCss, shareIcon, thumb } from './ui';

/** What to share: a track + class (the pilot's personal best there), or one of their board entries. */
export interface ShareTarget { map: string; course: string; cls: string; entry?: BoardEntry }

/** The flown line of the lap being shared, from its replay (the posted entry's, else the pilot's own
 *  best on that board), thinned to about 400 points for the track-map card; null without a replay. */
async function flownLine(board: LapBoard, t: ShareTarget): Promise<{ x: number; y: number }[] | null> {
  let bytes: Uint8Array | null = null;
  if (t.entry?.replay) { const r = await fetchReplay(t.entry.id); bytes = 'bytes' in r ? r.bytes : null; }
  bytes ??= await board.localReplay(t.map, t.course, t.cls);
  return bytes ? trailFromReplay(bytes) : null;
}

export interface ShareScreenHost {
  board: LapBoard;
  target: ShareTarget;
  /** the build flown now, and the pilot's saved custom build (for the drone card) */
  build(): DroneBuild;
  mine(): DroneSpec | null;
  shots: PbShots;
  callsign(): string;
  usingPad(): boolean;
  backBar(): HTMLElement;
  setTabs(t: { count: number; go: (d: -1 | 1) => void }): void;
  /** post this personal best first (opens the initials entry) */
  post(map: string, course: string, cls: string): void;
}

const THEME_KEY = 'fpv-share-theme'; // the colours picked last (a convenience, this browser only)
const savedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
const saveTheme = (id: string) => { try { localStorage.setItem(THEME_KEY, id); } catch { /* not kept */ } };
/** A relay set in the Multiplayer tab: a phone opening the link would ask the public one instead. */
const customRelay = () => { try { return !!localStorage.getItem('fpv-mp-url'); } catch { return false; } };

/** The lap for a target: the board entry if one was picked, else the personal best on that track and class. */
export function lapFor(board: LapBoard, t: ShareTarget, callsign: string): ShareLap | null {
  const pb = board.pb(t.map, t.course, t.cls), e = t.entry;
  const lapMs = e?.lapMs ?? pb?.lapMs;
  if (!lapMs) return null;
  const same = !!pb && pb.lapMs === lapMs, p = board.pending;
  return {
    map: t.map, course: t.course, cls: t.cls, track: trackLabelOf(t.map, t.course), className: classLabel(t.cls),
    summary: e?.summary || pb?.summary || classLabel(t.cls),
    initials: e?.initials ?? defaultInitials(board.initials, callsign),
    lapMs, splitsMs: same ? pb!.splitsMs.slice() : [], at: e?.at ?? pb?.at ?? Date.now(),
    prevMs: p && p.key === pbKey(t.map, t.course, t.cls) && p.lapMs === lapMs ? p.prevMs : null,
    entryId: e?.id ?? (same ? pb!.submitted?.id : undefined),
  };
}

export function shareScreen(h: ShareScreenHost): HTMLElement {
  injectShareCss();
  const t = h.target, lap = lapFor(h.board, t, h.callsign());
  if (!lap) {
    return el('div', {}, h.backBar(), el('h1', { class: 'gm-h1' }, 'Share your lap'),
      el('div', { class: 'gm-empty' }, icon('timer'), el('h4', {}, 'No lap to share yet'), el('p', {}, 'Fly Race mode and finish a lap through every gate: your personal best can then be shared as a card.')));
  }
  let palette = paletteOf(savedTheme());
  // the drone: the build flown now if it is this class, else the saved custom build or the preset
  let drone: DroneData | null = null;
  const droneData = (): Promise<DroneData> => {
    const cur = h.build(), mine = h.mine();
    if (droneClass(cur.spec) === t.cls) return Promise.resolve(fromBuild(cur));
    return buildOffThread(t.cls === CUSTOM && mine ? mine : specForClass(t.cls, lap.summary));
  };
  const deck = new CardDeck(lap, palette, (p) => {
    const pic = drone && droneShot(drone, p);
    return pic ? { ...pic, name: droneName(drone!.spec), chips: droneChips(drone!) } : null;
  });
  const shot = h.shots.shot(pbKey(t.map, t.course, t.cls), lap.lapMs);
  if (shot) deck.assets.frame = { image: shot.canvas, w: shot.canvas.width, h: shot.canvas.height, view: shot.view };

  // what each card is waiting for, or why it can't be made
  const why: Partial<Record<CardStyle, string>> = {
    drone: 'Rendering…', map: 'Loading the course…',
    fpv: shot ? undefined : 'Only for a best flown this session',
    board: lap.entryId === undefined ? (onBoard(t.map, t.course) ? 'Post your lap first' : 'No leaderboard here') : 'Loading the board…',
  };
  let sel: CardStyle = 'stats';

  // ---- preview + carousel
  const big = el('canvas', { role: 'img' }) as HTMLCanvasElement;
  const stage = el('div', { class: 'sh-stage' }, el('div', { class: 'sh-ph' }, 'Drawing your card…'));
  const thumbs = new Map<CardStyle, { btn: HTMLButtonElement; art: HTMLElement; sub: HTMLElement }>();
  const strip = el('div', { class: 'sh-strip', role: 'radiogroup', 'aria-label': 'Card style' }, ...CARD_STYLES.map((s) => {
    const art = el('div', { class: 'sh-thph' }, '…'), sub = el('small');
    const btn = el('button', { class: 'sh-thumb', role: 'radio', 'data-key': `card-${s.id}`, 'aria-checked': String(s.id === sel), 'data-autofocus': s.id === sel || undefined, title: s.blurb,
      onclick: () => pick(s.id) }, art, el('span', {}, s.name), sub) as HTMLButtonElement;
    thumbs.set(s.id, { btn, art, sub });
    return btn;
  }));
  const drawThumbs = () => {
    const ok = deck.available();
    for (const s of CARD_STYLES) {
      const th = thumbs.get(s.id)!, c = deck.canvas(s.id), can = ok.includes(s.id);
      th.btn.setAttribute('aria-disabled', String(!can));
      th.btn.setAttribute('aria-checked', String(s.id === sel));
      th.sub.textContent = can ? '' : why[s.id] ?? '';
      if (can && c) {
        const tc = th.art instanceof HTMLCanvasElement ? th.art : el('canvas') as HTMLCanvasElement;
        thumb(c, tc);
        if (tc !== th.art) { th.art.replaceWith(tc); th.art = tc; }
      }
    }
  };
  const drawBig = () => {
    const c = deck.canvas(sel);
    if (!c) return;
    big.width = c.width; big.height = c.height;
    big.getContext('2d')!.drawImage(c, 0, 0);
    big.setAttribute('aria-label', `${CARD_STYLES.find((x) => x.id === sel)!.name} card: ${lap.track}, ${fmtLap(lap.lapMs)}, ${lap.initials}`);
    if (!big.isConnected) stage.replaceChildren(big);
  };
  const pick = (s: CardStyle) => {
    if (!deck.available().includes(s)) { status(why[s] ? `${CARD_STYLES.find((x) => x.id === s)!.name}: ${why[s]}.` : ''); return; }
    sel = s;
    drawThumbs(); drawBig();
    void deck.file(sel); // encode now: Share needs the PNG within its click
    acts.update();
    if (qrOpen) drawPhone();
  };
  h.setTabs({ count: CARD_STYLES.length, go: (d) => {
    const ok = deck.available(), i = ok.indexOf(sel);
    pick(ok[(i + d + ok.length) % ok.length]);
    thumbs.get(sel)?.btn.focus({ preventScroll: true });
  } });

  // ---- colours
  const swatches = el('div', { class: 'sh-swatches', role: 'radiogroup', 'aria-label': 'Colours' }, ...PALETTES.map((p) =>
    el('button', { class: 'sh-swatch', role: 'radio', 'data-key': `theme-${p.id}`, 'aria-checked': String(p.id === palette.id), onclick: () => void setPalette(p) },
      el('i', { style: { background: `linear-gradient(135deg, ${p.secondary}, ${p.accent})` } }), p.name)));
  const setPalette = async (p: Palette) => {
    palette = p; saveTheme(p.id);
    swatches.querySelectorAll('.sh-swatch').forEach((b) => b.setAttribute('aria-checked', String((b as HTMLElement).dataset.key === `theme-${p.id}`)));
    await deck.setPalette(p);
  };

  // ---- actions
  const statusEl = el('p', { class: 'sh-status', role: 'status', 'aria-live': 'polite' });
  const status = (msg: string, err = false) => { statusEl.textContent = msg; statusEl.classList.toggle('err', err); };
  const phone = (): PhoneLink => (customRelay() ? 'custom-relay' : lap.entryId !== undefined ? 'ok' : onBoard(t.map, t.course) ? 'post' : 'no-board');
  // canShare can only be asked with a file: a tiny stand-in PNG has the same answer
  const env = detectEnv(new File([new Uint8Array([137, 80, 78, 71])], 'card.png', { type: 'image/png' }));
  const ui = shareUi(env, phone());
  const acts = actionButtons({
    deck, ui, style: () => sel, status, usingPad: () => h.usingPad(),
    shareText: () => `${fmtLap(lap.lapMs)} on ${lap.track} with the ${lap.className} in FPV Sim: real Betaflight, real physics. ${SITE}`,
  });
  let qrOpen = false;
  const qrBox = el('div');
  const phoneBtn = el('button', { class: 'gm-btn', 'data-key': 'sh-phone', 'aria-expanded': 'false', onclick: () => { qrOpen = !qrOpen; phoneBtn.setAttribute('aria-expanded', String(qrOpen)); drawPhone(); } }, shareIcon('phone'), 'Send to my phone') as HTMLButtonElement;
  const drawPhone = () => {
    if (!qrOpen) { qrBox.replaceChildren(); return; }
    const st = phone();
    const callout = (title: string, body: string, ...kids: HTMLElement[]) => qrBox.replaceChildren(el('div', { class: 'gm-callout', style: { maxWidth: '760px' } }, icon('info'), el('div', {}, el('p', {}, el('b', {}, title), ' ', body), ...kids)));
    if (st === 'post') {
      callout('Post your lap first.', 'The link opens your lap’s public leaderboard entry on the phone, so it has to be on the board.',
        el('div', { class: 'gm-actions', style: { marginTop: '10px' } }, el('button', { class: 'gm-btn primary', 'data-key': 'sh-post', onclick: () => h.post(t.map, t.course, t.cls) }, icon('trophy'), 'Post to leaderboard')));
      return;
    }
    if (st === 'no-board') { callout('No phone link for this track.', 'It has no global leaderboard, which the phone reads the lap from. Download the PNG or copy it instead.'); return; }
    if (st === 'custom-relay') { callout('No phone link with your own server.', 'You set a multiplayer server in Settings → Multiplayer; the phone page reads the public leaderboard. Download the PNG or copy it instead.'); return; }
    const url = shareUrl(location.origin, { entry: lap.entryId!, card: sel, theme: palette.id, splitsMs: lap.splitsMs.length ? lap.splitsMs : null });
    const q = encodeQr(url, 'M'), px = 4, c = el('canvas', { role: 'img', 'aria-label': 'QR code of the link for your phone' }) as HTMLCanvasElement;
    c.width = c.height = (q.size + 8) * px;
    drawQr(c.getContext('2d')!, q, 0, 0, px);
    const field = el('input', { class: 'gm-input', readonly: true, value: url, 'aria-label': 'Link for your phone', 'data-key': 'sh-url' }) as HTMLInputElement;
    const copy = el('button', { class: 'gm-btn', 'data-key': 'sh-copylink', onclick: () => {
      void navigator.clipboard?.writeText(url).then(() => status('Link copied.'), () => { field.select(); status('Select the link and copy it (Ctrl+C).'); });
    } }, shareIcon('link'), 'Copy link');
    qrBox.replaceChildren(el('div', { class: 'gm-card sh-qr' }, c, el('div', {},
      el('h3', {}, 'Scan with your phone'),
      el('p', {}, 'Point your phone’s camera at the code. It opens this card on your phone, drawn there from your public leaderboard entry, with a button for Instagram Stories. No app or sign-in needed.'),
      el('div', { class: 'row' }, field, copy),
      el('p', { style: { marginTop: '10px' } }, 'The link shows your lap’s public entry: initials, lap time, drone, date and rank. Your gate splits ride along after the “#”, which browsers never send to a server.'))));
  };
  const hint = el('p', { class: 'sh-hint' });
  const drawHint = () => {
    const pad = h.usingPad() && ui.primary ? ' With a controller, A saves and copies; for the share sheet press Enter or click (browsers open it only then).' : '';
    hint.textContent = (ui.primary?.hint ?? 'Instagram Stories needs the phone app: Send to my phone, or download the PNG and post it from your phone.') + pad;
  };
  drawHint();

  // ---- the cards: stats at once, then the board, the course and the drone as they arrive
  deck.onDraw = (s) => { if (s === sel) { drawBig(); void deck.file(sel); } drawThumbs(); };
  deck.onFile = (s) => { if (s === sel) acts.update(); };
  void (async () => {
    await deck.set({});
    pick('stats');
    const jobs: Promise<void>[] = [];
    if (lap.entryId !== undefined) jobs.push(h.board.board(t.map, t.course, t.cls).then(async (r) => {
      if (r.error) { why.board = 'Leaderboard offline'; status('The leaderboard is offline: rank and record are left out.'); drawThumbs(); return; }
      const i = r.entries.findIndex((x) => x.id === lap.entryId);
      if (i < 0) { why.board = 'Not on the board now'; await deck.setLap({ entryId: undefined }); }
      await deck.set({ board: { rank: i < 0 ? null : i + 1, total: r.entries.length, top: r.entries } });
      if (qrOpen) drawPhone();
    }));
    else if (onBoard(t.map, t.course)) jobs.push(h.board.board(t.map, t.course, t.cls).then((r) => (r.error ? undefined : deck.set({ board: { rank: null, total: r.entries.length, top: r.entries } }))));
    jobs.push(new Promise<void>((done) => setTimeout(done, 30)).then(() => trackInfo(t.map, t.course)).then(async (ti) => {
      await deck.set({ course: { gates: ti.gates } });
      // then the line actually flown, when the lap has a replay (the map card is complete without it)
      const trail = await flownLine(h.board, t).catch(() => null);
      if (trail) await deck.set({ course: { gates: ti.gates, trail } });
    }, () => { why.map = 'Course unavailable'; drawThumbs(); }));
    // the drone last: a WebGL render (~0.1-0.3 s) after the 2D cards are up
    jobs.push(droneData().then(async (d) => {
      drone = d;
      await new Promise<void>((done) => setTimeout(done, 60));
      await deck.shootDrone();
      if (!deck.assets.drone) { why.drone = 'Needs WebGL'; drawThumbs(); }
    }).catch(() => { why.drone = 'Couldn’t render'; drawThumbs(); }));
    await Promise.all(jobs);
  })();

  return el('div', {},
    h.backBar(), el('h1', { class: 'gm-h1' }, 'Share your lap'),
    el('p', { class: 'gm-lead' }, `${fmtLap(lap.lapMs)} · ${lap.track} · ${lap.summary}. Pick a card for your Instagram Story. Cards are drawn on this computer: nothing is uploaded unless you share it.`),
    el('div', { class: 'sh-wrap' }, stage,
      el('div', {},
        el('h2', { class: 'gm-section-title' }, 'Card'), strip,
        el('h2', { class: 'gm-section-title' }, 'Colours'), swatches,
        el('div', { class: 'gm-actions sh-actions' }, ...acts.els, ...(ui.phone ? [phoneBtn] : [])),
        hint, statusEl, qrBox)));
}
