// Pieces shared by the menu's share screen (sheet.ts) and the phone page (page.ts): the extra icons,
// the styles of the card carousel and the action row, and the action buttons themselves.
import { el } from '../ui/dom';
import { copyImage, downloadFile, shareFile, ShareUi } from './actions';
import type { CardDeck } from './deck';
import type { CardStyle } from './types';

// Lucide icons (ISC, see THIRD_PARTY_NOTICES), like ui/menu/icons.ts
const P = {
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4M12 2v13"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};
export function shareIcon(name: keyof typeof P): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

export const SHARE_CSS = `
.sh-wrap { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: clamp(18px, 3vw, 40px); align-items: start; }
.sh-stage { position: sticky; top: 0; }
.sh-stage canvas, .sh-stage .sh-ph { display: block; height: min(68vh, 760px); aspect-ratio: 9 / 16; width: auto; border-radius: 18px;
  border: 1px solid var(--gm-border-soft, rgba(167,139,250,.22)); box-shadow: 0 24px 60px rgba(0,0,0,.55); background: var(--gm-bg, #0f0f23); }
.sh-ph { display: grid !important; place-items: center; color: var(--gm-fg-muted, #94a3b8); font-size: 15px; }
.sh-strip { display: flex; gap: 12px; flex-wrap: wrap; }
.sh-thumb { display: grid; justify-items: center; gap: 6px; width: 118px; padding: 8px 8px 10px; border-radius: 14px; cursor: pointer; color: var(--gm-fg, #e2e8f0);
  background: rgba(30, 28, 53, .8); border: 1px solid var(--gm-border-soft, rgba(167,139,250,.22)); font: inherit; font-size: 13px; line-height: 1.25; text-align: center;
  transition: transform 150ms, border-color 150ms, box-shadow 150ms; }
.sh-thumb canvas, .sh-thumb .sh-thph { width: 100px; height: 178px; border-radius: 8px; background: #0f0f23; display: block; }
.sh-thumb .sh-thph { display: grid; place-items: center; color: var(--gm-fg-muted, #94a3b8); font-size: 12px; padding: 8px; }
.sh-thumb:hover, .sh-thumb:focus-visible, .sh-thumb.is-focus { transform: translateY(-2px); border-color: var(--gm-secondary, #a78bfa); }
.sh-thumb[aria-checked=true] { border-color: var(--gm-accent, #f43f5e); box-shadow: 0 0 0 2px var(--gm-accent, #f43f5e) inset; }
.sh-thumb[aria-disabled=true] { opacity: .5; cursor: not-allowed; transform: none; }
.sh-thumb small { color: var(--gm-fg-muted, #94a3b8); font-size: 11.5px; }
.sh-swatches { display: flex; gap: 10px; flex-wrap: wrap; }
.sh-swatch { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 14px;
  color: var(--gm-fg, #e2e8f0); background: rgba(30, 28, 53, .8); border: 1px solid var(--gm-border-soft, rgba(167,139,250,.22)); }
.sh-swatch i { width: 16px; height: 16px; border-radius: 50%; }
.sh-swatch[aria-checked=true] { border-color: var(--gm-accent, #f43f5e); box-shadow: 0 0 0 2px var(--gm-accent, #f43f5e) inset; }
.sh-actions { margin-top: 18px; }
.sh-hint { color: var(--gm-fg-muted, #94a3b8); font-size: 14px; margin: 10px 0 0; max-width: 60ch; }
.sh-status { min-height: 24px; margin: 10px 0 0; font-size: 15px; }
.sh-status.err { color: #fda4af; }
.sh-qr { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px; align-items: start; margin-top: 18px; max-width: 760px; }
.sh-qr canvas { width: 212px; height: 212px; image-rendering: pixelated; border-radius: 10px; background: #fff; }
.sh-qr h3 { margin: 0 0 6px; font-family: var(--gm-font-display, inherit); font-weight: 400; letter-spacing: .04em; }
.sh-qr p { margin: 0 0 10px; color: var(--gm-fg-muted, #94a3b8); font-size: 14px; }
.sh-qr .row { display: flex; gap: 10px; }
.sh-qr .row .gm-input { font-size: 13px; min-width: 0; }
.sh-qr .row .gm-btn { flex: none; white-space: nowrap; }
@media (max-width: 820px) {
  .sh-wrap { grid-template-columns: 1fr; }
  .sh-stage { position: static; justify-self: center; }
  .sh-stage canvas, .sh-stage .sh-ph { height: min(62vh, 640px); }
  .sh-qr { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { .sh-thumb { transition: none; } }`;

export function injectShareCss() {
  if (document.getElementById('sh-css')) return;
  document.head.append(el('style', { id: 'sh-css' }, SHARE_CSS));
}

/** Copy a card's preview into a small canvas (the carousel's live thumbnails). */
export function thumb(src: HTMLCanvasElement, dst: HTMLCanvasElement, w = 200) {
  dst.width = w; dst.height = Math.round((w * src.height) / src.width);
  const c = dst.getContext('2d')!;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, dst.width, dst.height);
}

export interface ActionHooks {
  deck: CardDeck;
  style(): CardStyle;
  ui: ShareUi;
  shareText(): string;
  status(msg: string, err?: boolean): void;
  /** a controller drives the menu: navigator.share needs a click / key press, say so up front */
  usingPad?(): boolean;
}

/** Share / Share to Instagram, Download PNG, Copy image. update(): enable them once the card's PNG is ready. */
export function actionButtons(h: ActionHooks): { els: HTMLElement[]; update(): void } {
  const els: HTMLButtonElement[] = [];
  const pr = h.ui.primary;
  let share: HTMLButtonElement | null = null;
  if (pr) {
    share = el('button', { class: 'gm-btn cta', 'data-key': 'sh-share', onclick: () => {
      const f = h.deck.fileNow(h.style());
      if (!f) { h.status('Preparing the image… try again in a moment.'); return; }
      // straight from the click: the share sheet needs the click's user activation
      void shareFile(f, pr.kind === 'instagram' ? '' : h.shareText()).then((o) => {
        if (o === 'shared') h.status('Shared.');
        else if (o === 'blocked') h.status('Your browser opens its share sheet only for a click, tap or key press: click Share, or press Enter on it.', true);
        else if (o === 'failed') h.status('Sharing didn’t work here. Download the PNG instead.', true);
        else h.status('');
      });
    } }, shareIcon('share'), pr.label) as HTMLButtonElement;
    els.push(share);
  }
  const dl = el('button', { class: `gm-btn${pr ? '' : ' primary'}`, 'data-key': 'sh-download', onclick: () => {
    void h.deck.file(h.style()).then((f) => { downloadFile(f); h.status(`Saved ${f.name}.`); }, (e) => h.status((e as Error).message, true));
  } }, shareIcon('download'), 'Download PNG') as HTMLButtonElement;
  els.push(dl);
  let copy: HTMLButtonElement | null = null;
  if (h.ui.copy) {
    copy = el('button', { class: 'gm-btn', 'data-key': 'sh-copy', onclick: () => {
      const ready = h.deck.fileNow(h.style());
      // the ClipboardItem is made within the click (Safari), the PNG may still be encoding
      void copyImage(ready ?? h.deck.file(h.style())).then((ok) => h.status(ok ? 'Image copied: paste it into a post or a chat.' : 'Copying didn’t work here (the browser refused). Download the PNG instead.', !ok));
    } }, shareIcon('copy'), 'Copy image') as HTMLButtonElement;
    els.push(copy);
  }
  const update = () => {
    const ready = !!h.deck.fileNow(h.style());
    if (share) { share.disabled = !ready; share.setAttribute('aria-busy', String(!ready)); }
  };
  update();
  return { els, update };
}
