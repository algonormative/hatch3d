import type { Point } from '../../src/sketch/types.ts';
import { circlePath, hatchedDisc } from './fills.ts';

/**
 * The first Breach Tarot set's flat marks, small, as emblems another card can quote: Death's hatched
 * disc, the Tower's bolt, the Star's eight points and the Sun's ringed disc. Each is drawn flat in page
 * millimetres round a centre, fitting a circle of radius `r`. These are quotations, not the cards' own
 * marks: those keep their own code, so nothing printed moves.
 */

/** XIII: the event horizon, a disc hatched solid in two crossing families, its halo ring, and the horizon rule broken at it. */
export function discEmblem(c: Point, r: number): Point[][] {
  const core = 0.58 * r;
  return [
    ...hatchedDisc(c, core, [[Math.PI / 4, 0.55], [-Math.PI / 4, 0.8]]),
    circlePath(c, 0.82 * r),
    [{ x: c.x - 1.35 * r, y: c.y }, { x: c.x - r, y: c.y }],
    [{ x: c.x + r, y: c.y }, { x: c.x + 1.35 * r, y: c.y }],
  ];
}

/** XVI: the bolt, a stepped lightning shape hatched across, with a thin branch off its elbow. */
export function boltEmblem(c: Point, r: number): Point[][] {
  const at = (x: number, y: number): Point => ({ x: c.x + x * r, y: c.y + y * r });
  const shape = [at(0.22, -1), at(-0.38, 0.12), at(-0.02, 0.12), at(-0.3, 1), at(0.4, -0.18), at(0.04, -0.18), at(0.22, -1)];
  return [shape, ...polygonHatch(shape, Math.PI / 4, 0.55, 0.2), [at(-0.2, 0.12), at(-0.48, 0.42), at(-0.58, 0.7)]];
}

/**
 * Even-odd hatch of a closed polygon: lines at `angle`, `pitch` apart, stopped `inset` short of the
 * edge along each line.
 */
export function polygonHatch(poly: Point[], angle: number, pitch: number, inset = 0): Point[][] {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Into a frame where the hatch runs along x.
  const into = (p: Point) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });
  const back = (p: Point): Point => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const q = poly.map(into);
  const ys = q.map(p => p.y);
  const out: Point[][] = [];
  for (let y = Math.min(...ys) + pitch / 2; y < Math.max(...ys); y += pitch) {
    const xs: number[] = [];
    for (let i = 1; i < q.length; i++) {
      const a = q[i - 1], b = q[i];
      if ((a.y - y) * (b.y - y) < 0) xs.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i] + inset, x1 = xs[i + 1] - inset;
      if (x1 > x0) out.push([back({ x: x0, y }), back({ x: x1, y })]);
    }
  }
  return out;
}

/** XVII: the star, eight points long and short in turn round a small hub, each drawn as a faceted spike. */
export function starEmblem(c: Point, r: number): Point[][] {
  const out: Point[][] = [circlePath(c, 0.1 * r, 36)];
  for (let k = 0; k < 8; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 4;
    const reach = k % 2 === 0 ? r : 0.55 * r;
    const w = (k % 2 === 0 ? 0.13 : 0.1) * r;
    const along = (d: number, side: number): Point => ({ x: c.x + d * Math.cos(a) - side * w * Math.sin(a), y: c.y + d * Math.sin(a) + side * w * Math.cos(a) });
    const base = 0.14 * r;
    out.push([along(base, -1), along(reach, 0), along(base, 1)], [along(base, 0), along(reach, 0)]);
  }
  return out;
}

/** XIX: the sun, a disc of rims with rays that alternate straight and twisting, as on the old cards. */
export function sunEmblem(c: Point, r: number): Point[][] {
  const disc = 0.46 * r;
  const out: Point[][] = [circlePath(c, disc), circlePath(c, disc - 0.6), circlePath(c, disc - 1.2)];
  const count = 12;
  for (let k = 0; k < count; k++) {
    const a = k * Math.PI * 2 / count;
    const r0 = disc + 0.12 * r, r1 = k % 2 === 0 ? r : 0.86 * r;
    const nx = -Math.sin(a), ny = Math.cos(a);
    const side = (d: number, w: number): Point => ({ x: c.x + d * Math.cos(a) + nx * w, y: c.y + d * Math.sin(a) + ny * w });
    if (k % 2 === 0) {
      const w0 = 0.07 * r, w1 = 0.025 * r;
      out.push([side(r0, -w0), side(r1, -w1), side(r1, w1), side(r0, w0), side(r0, -w0)]);
    } else {
      for (const sgn of [-1, 1]) out.push(Array.from({ length: 40 }, (_, i) => {
        const f = i / 39, d = r0 + (r1 - r0) * f;
        return side(d, sgn * 0.08 * r * (1 - 0.6 * f) * Math.sin(f * Math.PI * 2 * 1.6 + k));
      }));
    }
  }
  return out;
}
