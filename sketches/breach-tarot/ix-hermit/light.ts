import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { n, smooth } from '../../kit/params.ts';

/**
 * The lantern's light, the only light on the card. A lantern held up spills its light down: the lit
 * shape is a small clear core round the flame (a disc, `core` mm, where no night ruling may lie),
 * and, out from it, a pool that leans along `axis` (toward the summit stones it falls on), reaches
 * `pool` times as far that way, only part as far the other, and has an uneven edge. `dark(p)` is
 * how much of the night's ruling survives at a page point: 0 in the clear, rising to 1 across a
 * falloff `glow` mm wide.
 */
export interface Light {
  core: number;
  /** 0 (clear) to 1 (full night) at a page point. */
  dark: (p: Point) => number;
}

export function lantern(ctx: SketchContext, lamp: Point, toward: Point): Light {
  const core = n(ctx, 'lit', 10, 0, 40);
  const glow = n(ctx, 'glow', 12, 4, 40);
  const pool = n(ctx, 'pool', 1.9, 1, 3.5), up = n(ctx, 'poolUp', 0.8, 0.2, 1);
  const rag = n(ctx, 'ragged', 0.34, 0, 0.6);
  // Its own stream: nothing else on the card moves with the edge.
  const r = ctx.random('hermit-light');
  const phase = [r() * Math.PI * 2, r() * Math.PI * 2, r() * Math.PI * 2];
  const along = Math.hypot(toward.x - lamp.x, toward.y - lamp.y) || 1;
  const axis = { x: (toward.x - lamp.x) / along, y: (toward.y - lamp.y) / along };
  const shape = (dx: number, dy: number): { lo: number; hi: number } => {
    const d = Math.hypot(dx, dy) || 1e-9;
    const s = (dx * axis.x + dy * axis.y) / d;
    const g = 1 + (pool - 1) * Math.max(0, s) ** 1.4 - (1 - up) * Math.max(0, -s);
    const th = Math.atan2(dy, dx);
    const m = 1 + rag * (0.55 * Math.sin(2 * th + phase[0]) + 0.3 * Math.sin(5 * th + phase[1]) + 0.15 * Math.sin(9 * th + phase[2]));
    // The disc is the floor: the clear never shrinks below the core.
    const lo = Math.max(core, core * g * m);
    return { lo, hi: lo + glow * Math.max(0.5, g) * m };
  };
  return {
    core,
    dark: p => {
      const dx = p.x - lamp.x, dy = p.y - lamp.y, d = Math.hypot(dx, dy);
      if (d <= core) return 0;
      const { lo, hi } = shape(dx, dy);
      return smooth(lo, hi, d);
    },
  };
}
