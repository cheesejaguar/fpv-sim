// Tunnelling detector: did any collider sphere centre cross a vertical post / horizontal bar while
// inside its footprint (i.e. pass through the solid rather than around it)?
import { rotate, v3 } from '../../src/sim/math';
import { QuadSim } from '../../src/sim/quad';

/** Obstacle: slab |x - x0| < hx, and |lat - c| < h in the other axis ('y' for a post, 'z' for a bar). */
export function tunnelWatch(q: QuadSim, x0: number, hx: number, lat: 'y' | 'z', c: number, h: number) {
  const n = q.p.colliders.length;
  const side = new Int8Array(n);
  let through = 0;
  const t = v3();
  const check = () => {
    for (let i = 0; i < n; i++) {
      const col = q.p.colliders[i];
      const w = rotate(t, q.s.q, col.pos);
      const px = q.s.pos.x + w.x, pl = q.s.pos[lat] + w[lat];
      const inside = Math.abs(pl - c) < h;
      const sd = px < x0 - hx ? -1 : px > x0 + hx ? 1 : 0;
      if (sd !== 0) {
        if (side[i] === -1 && sd === 1 && inside) through++;
        side[i] = sd;
      } else if (!inside) side[i] = 0; // entered the slab beside the obstacle: not a pass-through
    }
  };
  return { check, get through() { return through; } };
}
