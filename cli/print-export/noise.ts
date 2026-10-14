/** Seeded, stateless value noise: the same inputs give the same numbers, in any order, on any run. */

/** A hash of a seed and two integers, in [0, 1). */
export function hash01(seed: number, a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth 2D value noise in [-1, 1] on a lattice `cell` apart (same units as x and y). */
export function noise2(seed: number, x: number, y: number, cell: number): number {
  const fx = x / cell, fy = y / cell;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smooth(fx - ix), ty = smooth(fy - iy);
  const v = (i: number, j: number) => hash01(seed, i, j) * 2 - 1;
  const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * tx;
  const bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * tx;
  return top + (bottom - top) * ty;
}

/** Smooth 1D value noise in [-1, 1] with knots `cell` apart; `key` picks an independent stream under one seed. */
export function noise1(seed: number, key: number, s: number, cell: number): number {
  const f = s / cell, i = Math.floor(f);
  const t = smooth(f - i);
  const v = (k: number) => hash01(seed, key, k) * 2 - 1;
  return v(i) + (v(i + 1) - v(i)) * t;
}
