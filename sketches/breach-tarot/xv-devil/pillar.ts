import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { param } from './params.ts';

/** One block of the pillar: its slab, the course it belongs to and where in the height it sits (0 foot, 1 top). */
export interface Piece { sl: Slab; course: number; height: number }

export interface Pillar {
  pieces: Piece[];
  /** Height where the leashes leave, and the pillar's half width there. */
  attach: { y: number; half: number; z: number };
  /** The front face's z. */
  front: number;
}

/**
 * The pedestal: a stepped base of three slabs, a shaft of whole-width courses and a heavy
 * overhanging cap of two slabs: the traditional half-cube altar, squat and dark. It stands square to
 * the eye, dead centre, every course centred on x = 0, so the card is symmetric about it; the seed
 * moves only the course heights and how far each course steps in or out.
 */
export function buildPillar(ctx: SketchContext): Pillar {
  const rng = ctx.random('devil-pillar');
  const v = param(ctx, 'variety');
  const W = param(ctx, 'pillarW'), H = param(ctx, 'pillarH'), D = param(ctx, 'pillarD'), dist = param(ctx, 'pillarDist');
  // Two whole-width shaft courses; now and then, by the seed, three.
  const shaft = Math.round(param(ctx, 'shaft')) + (rng() < 0.4 * Math.min(1, v) ? 1 : 0);
  const gap = 0.07;
  // Course heights as shares of H: the base, the shaft (jittered) and the cap.
  const base = [0.07, 0.06, 0.055], cap = [0.1, 0.075];
  const shaftShare = 1 - base.reduce((a, b) => a + b, 0) - cap.reduce((a, b) => a + b, 0);
  const raw = Array.from({ length: shaft }, () => 1 + (rng() - 0.5) * 0.5 * v);
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const shares = [...base, ...raw.map(r => shaftShare * r / rawSum), ...cap];
  const widths = [1.2, 1.1, 1.01, ...Array.from({ length: shaft }, () => 0.84 + 0.07 * rng() * v), 1.06, 0.96].map(k => k * W);
  const depths = [1.16, 1.09, 1.01, ...Array.from({ length: shaft }, () => 0.94 + 0.06 * rng() * v), 1.05, 0.97].map(k => k * D);
  const pieces: Piece[] = [];
  let y = 0;
  const z = -dist;
  shares.forEach((share, i) => {
    const h = share * H;
    const sl = solid(0, y + h / 2, z, widths[i], h - gap, depths[i], i, 'stack');
    pieces.push({ sl, course: i, height: (y + h / 2) / H });
    y += h;
  });
  // The leashes leave through the shaft's side, at the share of the pillar's height chosen: the course there sets how far out.
  const ay = param(ctx, 'leashAt') * H;
  const here = pieces.filter(p => Math.abs(p.sl.y - ay) <= p.sl.h / 2);
  const reach = here.length ? here : pieces;
  const half = Math.max(...reach.map(p => p.sl.w / 2));
  const front = z + Math.max(...reach.map(p => p.sl.d)) / 2;
  return { pieces, attach: { y: ay, half, z }, front };
}
