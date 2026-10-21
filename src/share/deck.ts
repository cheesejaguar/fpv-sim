// The set of share cards for one lap, as the share sheet (menu) and the phone page use it: draws
// each available card style, redraws when a picture or the board arrives or the colours change,
// and keeps each card's PNG ready, so a Share button can hand it to navigator.share within the
// click that asked for it.
import { fileName } from './actions';
import { fmtLap } from './layout';
import { cardFile, cardFonts, renderCard } from './paint';
import { available, CardStyle, Palette, Picture, ShareAssets, ShareLap } from './types';

export class CardDeck {
  assets: ShareAssets = {};
  private canvases = new Map<CardStyle, HTMLCanvasElement>();
  private files = new Map<CardStyle, { at: number; file: File | null; p: Promise<File> }>();
  private version = 0;
  private fonts: Promise<void> | null = null;
  /** a card was (re)drawn: its preview should follow */
  onDraw: ((style: CardStyle) => void) | null = null;
  /** a card's PNG is ready (share / copy can use it now) */
  onFile: ((style: CardStyle) => void) | null = null;

  /** droneFor: the studio shot in a palette's colours (redone when the palette changes), null if none */
  constructor(public lap: ShareLap, public palette: Palette, private droneFor: ((p: Palette) => (Picture & { name: string; chips: string[] }) | null) | null = null) {}

  available(): CardStyle[] { return available(this.lap, this.assets); }

  /** Fonts first: a card drawn before its fonts load would keep the fallback font. */
  ready(): Promise<void> { return (this.fonts ??= cardFonts()); }

  /** New or changed assets: redraw the cards that use them (all, to keep it simple: a card is ~10 ms). */
  async set(patch: Partial<ShareAssets>) {
    Object.assign(this.assets, patch);
    await this.redraw();
  }

  async setLap(patch: Partial<ShareLap>) {
    Object.assign(this.lap, patch);
    await this.redraw();
  }

  async setPalette(p: Palette) {
    this.palette = p;
    if (this.droneFor && this.assets.drone) this.assets.drone = this.droneFor(p) ?? this.assets.drone;
    await this.redraw();
  }

  /** Draw the drone shot now (it takes a moment, so the sheet calls this after the first cards are up). */
  async shootDrone() {
    if (!this.droneFor) return;
    const d = this.droneFor(this.palette);
    if (d) await this.set({ drone: d });
  }

  private async redraw() {
    await this.ready();
    this.version++;
    this.files.clear();
    for (const s of this.available()) {
      const c = this.canvases.get(s) ?? document.createElement('canvas');
      renderCard(s, this.lap, this.assets, this.palette, c);
      this.canvases.set(s, c);
      this.onDraw?.(s);
    }
  }

  canvas(style: CardStyle): HTMLCanvasElement | null { return this.canvases.get(style) ?? null; }

  /** The card's PNG, encoded once per drawing. */
  file(style: CardStyle): Promise<File> {
    const c = this.canvases.get(style);
    if (!c) return Promise.reject(new Error('That card is not available.'));
    let f = this.files.get(style);
    if (!f || f.at !== this.version) {
      const at = this.version;
      const p = cardFile(c, fileName(this.lap.track, fmtLap(this.lap.lapMs), style));
      const entry: { at: number; file: File | null; p: Promise<File> } = { at, file: null, p };
      p.then((file) => { if (this.files.get(style) === entry) { entry.file = file; this.onFile?.(style); } }, () => {});
      this.files.set(style, (f = entry));
    }
    return f.p;
  }

  /** The PNG if it is encoded already (what a click handler can share synchronously). */
  fileNow(style: CardStyle): File | null { const f = this.files.get(style); return f && f.at === this.version ? f.file : null; }
}
