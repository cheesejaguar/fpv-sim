// The phone page behind "Send to my phone" (share.html): reads the share link (link.ts), fetches
// the lap's public leaderboard entry, draws the same 9:16 cards here on the phone and hands the
// chosen one to the phone's share sheet (Instagram Stories). It never starts the simulator: no
// firmware, worker or physics, and three.js only once the drone card is drawn.
import '../ui/menu/theme.css';
import { TRACKS, trackKey } from '../../server/src/leaderboardCore';
import { replayUrl } from '../app/replayLink';
import { fetchEntry, fetchReplay, formatLap } from '../net/leaderboard';
import { el } from '../ui/dom';
import { icon, logo } from '../ui/menu/icons';
import { detectEnv, shareUi } from './actions';
import { CardDeck } from './deck';
import { classLabel, fmtDate, rankText, SITE } from './layout';
import { parseShareUrl, splitsFor } from './link';
import { trailFromReplay } from './trail';
import { CARD_STYLES, CardStyle, paletteOf, ShareLap } from './types';
import { actionButtons, injectShareCss } from './ui';

const PAGE_CSS = `
html, body { margin: 0; min-height: 100%; background: #0f0f23; }
.gm.gm-page { position: relative; inset: auto; z-index: auto; display: block; min-height: 100dvh; padding: 0 0 40px; overflow-x: hidden; }
.sp-top { display: flex; align-items: center; gap: 12px; padding: max(16px, env(safe-area-inset-top)) 16px 8px; }
.sp-top a { display: flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; }
.sp-main { padding: 0 16px; max-width: 720px; margin: 0 auto; }
.sp-title { font-family: var(--gm-font-display); font-size: clamp(30px, 9vw, 48px); line-height: 1.05; margin: 4px 0 6px; font-variant-numeric: tabular-nums; }
.sp-main .gm-tagline { margin: 12px 0 0; }
.sp-main .gm-lead { margin: 0 0 14px; }
.sp-carousel { display: flex; gap: 14px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 6px 16px 10px; margin: 0 -16px; scrollbar-width: none; }
.sp-carousel::-webkit-scrollbar { display: none; }
.sp-card { flex: none; scroll-snap-align: center; width: min(76vw, 360px); padding: 0; border: 0; background: none; border-radius: 16px; cursor: pointer; }
.sp-card canvas, .sp-card .sh-ph { display: block; width: 100%; height: auto; aspect-ratio: 9 / 16; border-radius: 16px; border: 1px solid var(--gm-border-soft); box-shadow: 0 16px 40px rgba(0,0,0,.5); background: #0f0f23; }
.sp-card[aria-checked=true] canvas { border-color: var(--gm-accent); box-shadow: 0 0 0 2px var(--gm-accent), 0 16px 40px rgba(0,0,0,.5); }
.sp-dots { display: flex; justify-content: center; gap: 6px; margin: 4px 0 2px; }
.sp-dots button { height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--gm-border-soft); background: rgba(30,28,53,.8); color: var(--gm-fg-muted); font: inherit; font-size: 12px; }
.sp-dots button[aria-current=true] { color: var(--gm-fg); border-color: var(--gm-accent); }
.sp-actions { display: grid; gap: 10px; margin-top: 14px; }
.sp-actions .gm-btn { width: 100%; }
.sp-about { margin-top: 22px; }
.sp-about h3 { margin: 0 0 6px; font-family: var(--gm-font-display); font-weight: 400; letter-spacing: .04em; }
.sp-about p { margin: 0 0 10px; color: var(--gm-fg-muted); }
.sp-small { color: var(--gm-fg-muted); font-size: 13px; margin: 18px 0 0; }
.sp-small a { color: var(--gm-secondary); }`;

function shell(...kids: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'gm gm-page' },
    el('header', { class: 'sp-top' }, el('a', { href: '/' }, logo(), el('div', { class: 'gm-wordmark' }, 'FPV SIM', el('small', {}, 'Betaflight in the loop')))),
    el('main', { class: 'sp-main' }, ...kids));
}

const about = () => el('div', { class: 'gm-card sp-about' },
  el('h3', {}, 'Fly it yourself'),
  el('p', {}, 'FPV Sim is a free FPV drone trainer in your browser that runs the real Betaflight firmware against a physics model of your quad. Fly it on a desktop or laptop with a game controller or an RC radio.'),
  el('a', { class: 'gm-btn primary', href: '/' }, icon('play'), 'Open FPV Sim'));
const privacy = () => el('p', { class: 'sp-small' }, 'This card is drawn on your phone from the lap’s public leaderboard entry. Nothing is uploaded unless you share it. ', el('a', { href: '/privacy.html' }, 'Privacy notice'));

function fail(root: HTMLElement, title: string, body: string) {
  root.replaceChildren(shell(el('div', { class: 'gm-empty', style: { marginTop: '40px' } }, icon('alert'), el('h4', {}, title), el('p', {}, body)), about()));
}

async function main() {
  injectShareCss();
  const style = document.createElement('style');
  style.textContent = PAGE_CSS;
  document.head.append(style);
  const root = document.getElementById('share')!;
  const link = parseShareUrl(location.href);
  if (!link) { fail(root, 'This link is incomplete', 'Ask for a new link: in FPV Sim, open Share your lap, then Send to my phone.'); return; }
  root.replaceChildren(shell(el('p', { class: 'gm-tagline', role: 'status' }, 'Loading the lap…')));
  // the map module (track names, gates) loads while the entry is fetched
  const maps = import('./trackInfo');
  const r = await fetchEntry(link.entry);
  if (!r.entry) { fail(root, 'Couldn’t load this lap', r.error ?? 'Try again in a moment.'); return; }
  const e = r.entry, info = await maps.then((m) => m.trackInfo(e.map, e.course)).catch(() => null);
  const gates = TRACKS[trackKey(e.map, e.course)]?.gates ?? null;
  const lap: ShareLap = {
    map: e.map, course: e.course, cls: e.cls, track: info?.label ?? e.map, className: classLabel(e.cls), summary: e.summary,
    initials: e.initials, lapMs: e.lapMs, splitsMs: splitsFor(link, e.lapMs, gates), at: e.at, entryId: e.id,
  };
  const palette = paletteOf(link.theme);
  const deck = new CardDeck(lap, palette, null);
  deck.assets.board = r.rank ? { rank: r.rank, total: r.total, top: r.top } : null;
  if (info?.gates.length) deck.assets.course = { gates: info.gates };

  let sel: CardStyle = 'stats';
  const cards = new Map<CardStyle, HTMLButtonElement>();
  const carousel = el('div', { class: 'sp-carousel', role: 'radiogroup', 'aria-label': 'Card style' });
  const dots = el('div', { class: 'sp-dots' });
  const statusEl = el('p', { class: 'sh-status', role: 'status', 'aria-live': 'polite' });
  const status = (msg: string, err = false) => { statusEl.textContent = msg; statusEl.classList.toggle('err', err); };
  const env = detectEnv(new File([new Uint8Array([137, 80, 78, 71])], 'card.png', { type: 'image/png' }), true);
  const ui = shareUi(env, 'ok');
  const acts = actionButtons({ deck, ui, style: () => sel, status, shareText: () => `${formatLap(lap.lapMs)} on ${lap.track} in FPV Sim. ${SITE}` });
  const select = (s: CardStyle, scroll: boolean) => {
    sel = s;
    for (const [id, b] of cards) b.setAttribute('aria-checked', String(id === s));
    dots.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String((b as HTMLElement).dataset.card === s)));
    if (scroll) cards.get(s)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    void deck.file(s);
    acts.update();
  };
  const layout = () => {
    const ok = deck.available();
    for (const s of ok) if (!cards.has(s)) {
      const c = deck.canvas(s);
      if (!c) continue;
      const name = CARD_STYLES.find((x) => x.id === s)!.name;
      c.setAttribute('role', 'img'); c.setAttribute('aria-label', `${name} card`);
      cards.set(s, el('button', { class: 'sp-card', role: 'radio', 'aria-checked': String(s === sel), 'aria-label': name, onclick: () => select(s, true) }, c) as HTMLButtonElement);
    }
    // in the menu's order
    carousel.replaceChildren(...CARD_STYLES.filter((x) => cards.has(x.id)).map((x) => cards.get(x.id)!));
    dots.replaceChildren(...CARD_STYLES.filter((x) => cards.has(x.id)).map((x) => el('button', { 'data-card': x.id, 'aria-current': String(x.id === sel), onclick: () => select(x.id, true) }, x.name)));
  };
  // the card in the middle of the carousel is the one shared
  carousel.addEventListener('scroll', () => {
    const mid = carousel.getBoundingClientRect().left + carousel.clientWidth / 2;
    let best: CardStyle = sel, bd = Infinity;
    for (const [s, b] of cards) { const rr = b.getBoundingClientRect(), d = Math.abs(rr.left + rr.width / 2 - mid); if (d < bd) { bd = d; best = s; } }
    if (best !== sel) select(best, false);
  }, { passive: true });
  deck.onDraw = (s) => { if (s === sel) void deck.file(sel); };
  deck.onFile = (s) => { if (s === sel) acts.update(); };

  root.replaceChildren(shell(
    el('p', { class: 'gm-tagline' }, r.rank === 1 ? 'Board record' : 'Leaderboard lap'),
    el('h1', { class: 'sp-title' }, `${lap.initials} · ${formatLap(lap.lapMs)}`),
    el('p', { class: 'gm-lead' }, [lap.track, lap.summary, r.rank ? rankText(r.rank, r.total) : '', fmtDate(lap.at)].filter(Boolean).join(' · ')),
    carousel, dots,
    el('div', { class: 'sp-actions' }, ...acts.els,
      // the replay plays in the simulator itself (a bigger download than this page)
      e.replay ? el('a', { class: 'gm-btn', href: replayUrl(location.origin, e.id) }, icon('play'), 'Watch the replay in FPV Sim') : null),
    el('p', { class: 'sh-hint' }, ui.primary?.hint ?? 'This browser can’t hand images to other apps: download the PNG, then post it from Instagram.'),
    statusEl, about(), privacy()));
  await deck.set({});
  layout();
  // the map card's flown line, from the lap's replay (the card is complete without it)
  if (e.replay && info?.gates.length) void fetchReplay(e.id).then((x) => ('bytes' in x ? trailFromReplay(x.bytes) : null)).then((trail) => (trail ? deck.set({ course: { gates: info.gates, trail } }) : undefined)).catch(() => {});
  const first = link.card && deck.available().includes(link.card) ? link.card : 'stats';
  select(first, false);
  requestAnimationFrame(() => cards.get(first)?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  // the drone last: three.js loads only now, and the build is derived in a worker
  try {
    const d = await import('./droneShot');
    const build = await d.buildOffThread(d.specForClass(e.cls, e.summary));
    const pic = d.droneShot(build, palette);
    if (pic) {
      // a preset's own name; a custom build shows its summary (the phone doesn't know the build itself)
      await deck.set({ drone: { ...pic, name: e.cls === 'custom' ? e.summary.replace(/^Custom · /, 'Custom ') : d.droneName(build.spec), chips: e.cls === 'custom' ? [] : d.droneChips(build) } });
      layout();
      if (link.card === 'drone') select('drone', true);
    }
  } catch { /* no drone card */ }
}

void main();
