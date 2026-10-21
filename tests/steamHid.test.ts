import { expect, test } from 'vitest';
import { SteamHidController } from '../src/input/steamHid';

function report(opts: { buttons?: number; lx?: number; ly?: number; rx?: number; ry?: number; tl?: number; tr?: number }, withTs = false) {
  const v = new DataView(new ArrayBuffer(64));
  v.setUint8(0, 7); // seq
  v.setUint32(1, opts.buttons ?? 0, true);
  v.setInt16(5, opts.tl ?? 0, true); v.setInt16(7, opts.tr ?? 0, true);
  v.setInt16(9, opts.lx ?? 0, true); v.setInt16(11, opts.ly ?? 0, true);
  v.setInt16(13, opts.rx ?? 0, true); v.setInt16(15, opts.ry ?? 0, true);
  if (withTs) v.setUint16(17, 1234, true);
  return v;
}

test('decodes Triton state reports into the standard gamepad layout', () => {
  const c = new SteamHidController() as any;
  const dev = { productId: 0x1304, productName: 'Puck' };
  c.onReport(dev, 0x42, report({ buttons: 0x200 | 0x1, lx: 16384, ly: 32767, rx: -16384, ry: -32768, tr: 32767 }));
  const p = c.current();
  expect(p).not.toBeNull();
  expect(p.axes[0]).toBeCloseTo(0.5, 3);   // left X
  expect(p.axes[1]).toBeCloseTo(-1, 3);    // left stick pushed up -> standard -1
  expect(p.axes[2]).toBeCloseTo(-0.5, 3);  // right X
  expect(p.axes[3]).toBeCloseTo(1, 3);     // right stick pulled down -> +1
  expect(p.buttons[0].pressed).toBe(true); // A
  expect(p.buttons[5].pressed).toBe(true); // RB
  expect(p.buttons[4].pressed).toBe(false);
  expect(p.buttons[7].value).toBeCloseTo(1, 3); // right trigger
  // timestamped variant keeps the same stick offsets
  c.onReport(dev, 0x47, report({ lx: -32768 }, true));
  expect(c.current().axes[0]).toBeCloseTo(-1, 3);
  // unrelated reports are ignored
  c.onReport(dev, 0x43, report({ lx: 32767 }));
  expect(c.current().axes[0]).toBeCloseTo(-1, 3);
});
