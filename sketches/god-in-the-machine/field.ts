import type { Point } from '../../src/sketch/types.ts';

/** A scalar field on a page-millimetre grid, its level sets, and the oriented stripes the body is made of. */

export interface Grid { w: number; h: number; x0: number; y0: number; cell: number; data: Float32Array }

export function grid(x0: number, y0: number, x1: number, y1: number, cell: number): Grid {
  const w = Math.ceil((x1 - x0) / cell) + 1, h = Math.ceil((y1 - y0) / cell) + 1;
  return { w, h, x0, y0, cell, data: new Float32Array(w * h) };
}

/** Marching squares, chained: each level set as polylines, closed loops repeating their first point. */
export function contours(g: Grid, level = 0): Point[][] {
  const { w, h, x0, y0, cell, data } = g;
  const edgePoint = (id: number): Point => {
    const k = id >> 1, i = k % w, j = (k - i) / w;
    const a = data[k] - level;
    if (id & 1) {
      const b = data[k + w] - level, t = a / (a - b);
      return { x: x0 + i * cell, y: y0 + (j + t) * cell };
    }
    const b = data[k + 1] - level, t = a / (a - b);
    return { x: x0 + (i + t) * cell, y: y0 + j * cell };
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const k = j * w + i;
    const c = (data[k] > level ? 1 : 0) | (data[k + 1] > level ? 2 : 0) | (data[k + w + 1] > level ? 4 : 0) | (data[k + w] > level ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const top = 2 * k, left = 2 * k + 1, bottom = 2 * (k + w), right = 2 * (k + 1) + 1;
    switch (c) {
      case 1: case 14: link(left, top); break;
      case 2: case 13: link(top, right); break;
      case 3: case 12: link(left, right); break;
      case 4: case 11: link(right, bottom); break;
      case 6: case 9: link(top, bottom); break;
      case 7: case 8: link(left, bottom); break;
      case 5: link(left, top); link(right, bottom); break;
      case 10: link(top, right); link(left, bottom); break;
    }
  }
  const out: Point[][] = [];
  const walk = (start: number) => {
    const line = [start];
    let prev = -1, at = start;
    for (;;) {
      const next = links.get(at);
      if (!next || !next.length) break;
      let n = next.findIndex(v => v !== prev);
      if (n < 0) n = 0;
      const to = next.splice(n, 1)[0];
      const back = links.get(to)!;
      back.splice(back.indexOf(at), 1);
      line.push(to); prev = at; at = to;
    }
    if (line.length > 1) out.push(line.map(edgePoint));
  };
  for (const [id, next] of links) if (next.length === 1) walk(id);
  for (const [id, next] of links) if (next.length) walk(id);
  return out;
}

/** Douglas-Peucker. */
export function reduce(points: Point[], eps: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = points[a], B = points[b], dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy);
    let far = -1, most = eps;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const d = l < 1e-6 ? Math.hypot(p.x - A.x, p.y - A.y) : Math.abs(dx * (p.y - A.y) - dy * (p.x - A.x)) / l;
      if (d > most) { most = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

export function lengthOf(line: Point[]): number {
  let l = 0;
  for (let i = 1; i < line.length; i++) l += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  return l;
}

export interface StripeOptions {
  wavelength: number;
  /** The direction the stripes run at a page point, in radians (a line direction: θ and θ+π are the same). */
  direction: (x: number, y: number) => number;
  /** Where stripes may be. Outside, the field is held low, so every ridge closes before the edge. */
  inside: (x: number, y: number) => boolean;
  /** How strongly a stripe keeps its direction, by place: below 0.5 it wanders into a labyrinth. */
  order?: (x: number, y: number) => number;
  /** Where the ridges coarsen, 0 to 1, up to `wavelength * taper`. */
  coarsen?: (x: number, y: number) => number;
  taper?: number;
  iterations?: number;
  random: () => number;
}

const ANGLES = 32, SIZES = 4;

/** Oriented offsets and weights of a zero-mean Gabor kernel. */
function kernel(g: Grid, theta: number, wavelength: number, along: number, across: number): { dk: Int32Array; wt: Float32Array } {
  const r = Math.ceil(Math.max(along, across) * 2.2 / g.cell);
  const c = Math.cos(theta), s = Math.sin(theta);
  const off: number[] = [], wts: number[] = [];
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const x = i * g.cell, y = j * g.cell;
    const a = x * c + y * s, t = -x * s + y * c;
    const e = Math.exp(-(a * a) / (2 * along * along) - (t * t) / (2 * across * across));
    if (e < 0.02) continue;
    off.push(j * g.w + i); wts.push(e * Math.cos(2 * Math.PI * t / wavelength));
  }
  const mean = wts.reduce((p, v) => p + v, 0) / wts.length;
  let pos = 0;
  for (let n = 0; n < wts.length; n++) { wts[n] -= mean; if (wts[n] > 0) pos += wts[n]; }
  return { dk: Int32Array.from(off), wt: Float32Array.from(wts.map(v => v / pos)) };
}

/**
 * A stripe field by iterating an oriented filter from noise: stripes lock to the direction field, and where they
 * must diverge or disagree they meet in dislocations, the trace-like forks and dead ends. Its zero set never crosses
 * itself, stays near half a wavelength apart and is made only of closed loops: a plottable line by construction.
 */
export function stripes(g: Grid, o: StripeOptions): void {
  const { w, h, x0, y0, cell, data } = g;
  const held = new Uint8Array(w * h), which = new Uint16Array(w * h);
  const taper = o.taper ?? 1;
  const longest = o.wavelength * Math.max(1, taper);
  const kernels = new Map<number, ReturnType<typeof kernel>>();
  const kernelOf = (s: number) => {
    let k = kernels.get(s);
    if (!k) {
      const lambda = o.wavelength * Math.pow(taper, (s >> 9) / (SIZES - 1));
      k = kernel(g, (s & 0xff) / ANGLES * Math.PI, lambda, lambda * (s & 0x100 ? 0.5 : 1.05), lambda * 0.62);
      kernels.set(s, k);
    }
    return k;
  };
  const margin = Math.ceil(longest * 2.4 / cell) + 1;
  const cells: number[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = x0 + i * cell, y = y0 + j * cell;
    const edge = i < margin || j < margin || i >= w - margin || j >= h - margin;
    if (edge || !o.inside(x, y)) { held[k] = 1; data[k] = -1; continue; }
    data[k] = o.random() * 2 - 1;
    let t = o.direction(x, y) % Math.PI;
    if (t < 0) t += Math.PI;
    const ord = o.order ? o.order(x, y) : 1;
    const size = o.coarsen ? Math.round(Math.min(1, Math.max(0, o.coarsen(x, y))) * (SIZES - 1)) : 0;
    which[k] = (Math.round(t / Math.PI * ANGLES) % ANGLES) | (ord < 0.5 ? 0x100 : 0) | (size << 9);
    cells.push(k);
  }
  const next = new Float32Array(data.length);
  const iterations = o.iterations ?? 26;
  for (let n = 0; n < iterations; n++) {
    for (let c = 0; c < cells.length; c++) {
      const k = cells[c];
      const { dk, wt } = kernelOf(which[k]);
      let sum = 0;
      for (let m = 0; m < dk.length; m++) sum += wt[m] * data[k + dk[m]];
      next[k] = 0.35 * data[k] + 0.65 * Math.tanh(4 * sum);
    }
    for (let c = 0; c < cells.length; c++) data[cells[c]] = next[cells[c]];
  }
  // A light blur so the level set runs smooth between grid points.
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      next[k] = (4 * data[k] + 2 * (data[k - 1] + data[k + 1] + data[k - w] + data[k + w]) + data[k - w - 1] + data[k - w + 1] + data[k + w - 1] + data[k + w + 1]) / 16;
    }
    for (let k = 0; k < data.length; k++) data[k] = next[k];
  }
}

/** Smooth value noise in [0, 1]. */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const hash = (i: number, j: number) => {
    let v = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
  };
}
