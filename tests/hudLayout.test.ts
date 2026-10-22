// The HUD layout pass against a tiny fake DOM (no browser in the test run): it places what is shown,
// keeps clear of the OSD, measures only what changed, and does nothing at all while nothing changed.
import { beforeAll, expect, test } from 'vitest';

let reads = 0, styleWrites = 0;
/** Size of a HUD wrapper by its widget name and the classes of the card inside (px). */
const sizeOf = (e: FakeEl): { w: number; h: number } => {
  const name = e.attrs['data-hud'], card = e.children[0] as FakeEl | undefined;
  const cls = card?.className ?? '';
  if (name === 'keys') return cls.includes('vert') ? { w: 160, h: 420 } : cls.includes('dim') ? { w: 90, h: 36 } : { w: 900, h: 40 };
  if (name === 'notices' || name === 'coach') return e.className.includes('narrow') ? { w: 220, h: 160 } : { w: 420, h: 110 };
  if (name === 'tel') return { w: 9 * ((card?.textContent ?? '').split('\n')[0]?.length ?? 0), h: 200 };
  return { w: 200, h: 120 };
};

class FakeEl {
  children: (FakeEl | string)[] = [];
  attrs: Record<string, string> = {};
  className = '';
  private text = '';
  style: Record<string, string>;
  constructor(public tagName: string) {
    const st: Record<string, string> = {};
    this.style = new Proxy(st, { set: (o, k, v) => { styleWrites++; o[k as string] = v; return true; } });
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      toggle(c: string, on?: boolean) { const l = list(), has = l.includes(c), want = on ?? !has; if (want !== has) self.className = (want ? [...l, c] : l.filter((x) => x !== c)).join(' '); return want; },
      add(c: string) { this.toggle(c, true); }, remove(c: string) { this.toggle(c, false); }, contains: (c: string) => list().includes(c),
    };
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener() {}
  append(...k: (FakeEl | string)[]) { this.children.push(...k); }
  replaceChildren(...k: (FakeEl | string)[]) { this.children = k; }
  get textContent(): string { return this.children.length ? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('') : this.text; }
  set textContent(t: string) { this.children = []; this.text = t; }
  get offsetWidth() { reads++; return sizeOf(this).w; }
  get offsetHeight() { reads++; return sizeOf(this).h; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
}

let Hud: typeof import('../src/ui/hud/hud').Hud;
beforeAll(async () => {
  Object.assign(globalThis as any, { document: { createElement: (t: string) => new FakeEl(t) }, innerWidth: 1920, innerHeight: 1080 });
  ({ Hud } = await import('../src/ui/hud/hud'));
});

const keys = [{ glyph: 'Esc', cls: 'key', label: 'Menu' }, { glyph: 'Space', cls: 'key', label: 'Arm' }];
const wrap = (h: InstanceType<typeof Hud>, name: string) => (h.root as unknown as FakeEl).children.find((c) => typeof c !== 'string' && c.attrs['data-hud'] === name) as FakeEl;

test('places the shown widgets once, then does nothing while nothing changes', () => {
  const hud = new Hud(new FakeEl('canvas') as any, new FakeEl('canvas') as any);
  hud.keys(keys, false);
  hud.race({ lap: 1, last: 31.2, best: 30.9, gate: 2, gates: 6 }, null, 0);
  hud.layout([], { x: 240, y: 0, w: 1440, h: 1080 }, 0); // 4:3 video: 240 px letterbox bars
  const names = hud.lastLayout.map((l) => l.name).sort();
  expect(names).toEqual(['keys', 'race']);
  // keys: the vertical list fits the left bar
  expect(wrap(hud, 'keys').children[0]).toMatchObject({ className: 'card keys vert' });
  expect(hud.lastLayout.find((l) => l.name === 'keys')!.rect.x).toBeLessThan(240);
  // nothing changed: no layout reads, no style writes
  reads = 0; styleWrites = 0;
  hud.keys(keys, false);
  hud.race({ lap: 1, last: 31.2, best: 30.9, gate: 2, gates: 6 }, null, 50);
  hud.layout([], { x: 240, y: 0, w: 1440, h: 1080 }, 120);
  expect(reads).toBe(0);
  expect(styleWrites).toBe(0);
});

test('measures only the widget that changed; positions are written only when they move', () => {
  const hud = new Hud(new FakeEl('canvas') as any, new FakeEl('canvas') as any);
  hud.keys(keys, false);
  hud.tel(['abc', 'def']);
  hud.layout([], null, 0);
  reads = 0; styleWrites = 0;
  hud.tel(['abd', 'def']); // same shape: no new measurement, no move
  hud.layout([], null, 100);
  expect(reads).toBe(0);
  hud.tel(['a much longer first line', 'def']); // wider: measured again
  hud.layout([], null, 200);
  expect(reads).toBe(2); // that one widget, width + height
  const telRect = hud.lastLayout.find((l) => l.name === 'tel')!.rect;
  expect(telRect.w).toBe(9 * 24);
});

test('keeps clear of the OSD and falls back to the narrow card and the key row', () => {
  const hud = new Hud(new FakeEl('canvas') as any, new FakeEl('canvas') as any);
  const fakeNotice = new FakeEl('div') as any;
  hud.notices([fakeNotice]);
  hud.keys(keys, false);
  // OSD everywhere except a 300 px column in the middle and a strip at the bottom-left
  const osd = [{ x: 0, y: 0, w: 800, h: 1000 }, { x: 1100, y: 0, w: 820, h: 1080 }, { x: 800, y: 0, w: 300, h: 300 }];
  hud.layout(osd, null, 0);
  const n = hud.lastLayout.find((l) => l.name === 'notices')!;
  expect(n.overlapsOsd).toBe(false);
  expect(n.rect.w).toBe(220); // only the narrow card fits the gap
  expect(wrap(hud, 'notices').className).toContain('narrow');
  // the vertical list fits nowhere; the row fits the free strip along the bottom
  const k = hud.lastLayout.find((l) => l.name === 'keys')!;
  expect(k.overlapsOsd).toBe(false);
  expect(k.rect.w).toBe(900);
  expect(wrap(hud, 'keys').children[0]).toMatchObject({ className: 'card keys' });
  // stable: the same inputs give the same result without flipping the narrow class back and forth
  reads = 0;
  hud.layout(osd, null, 300);
  expect(reads).toBe(0);
  expect(wrap(hud, 'notices').className).toContain('narrow');
});

test('the drill card is built once and then updated in place', () => {
  const hud = new Hud(new FakeEl('canvas') as any, new FakeEl('canvas') as any);
  const race = (wrap(hud, 'race').children[0]) as FakeEl;
  hud.race(null, { inBox: false, offBy: 1.23, elapsed: 3.4, score: 50, best: 0 }, 0);
  const kids = race.children.slice();
  hud.race(null, { inBox: false, offBy: 1.31, elapsed: 3.5, score: 51, best: 0 }, 16);
  hud.race(null, { inBox: true, offBy: 0, elapsed: 3.6, score: 52, best: 0 }, 32);
  expect(race.children).toEqual(kids); // same elements
  expect(race.textContent).toContain('IN');
  expect(race.textContent).toContain('3.6 / 30 s');
  // back to a race: the race card replaces it
  hud.race({ lap: 0, last: 0, best: Infinity, gate: 1, gates: 4 }, null, 48);
  expect(race.textContent).toContain('Gate 1 / 4');
});
