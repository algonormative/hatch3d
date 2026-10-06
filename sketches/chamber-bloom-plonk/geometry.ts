import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { collect } from '../chamber-bloom/geometry.ts';

const TAU = Math.PI * 2;
/** TALL_ART in page millimetres: abstract mode maps it with the identity. */
export const PLONK_ART = { left: 18, right: 261.4, top: 18, bottom: 413.8 } as const;
/** Physical floor for parallel 0.25 mm pen lines. */
export const MIN_SPACING = 0.5;
/** Point-sampled clearance; leaves room for sampling and simplification error above MIN_SPACING. */
const GUARD = 0.54;
/** Radial pitch floor for the squash bunching, before the guard pass. */
const DESIGN_FLOOR = 0.68;
/** Rest semi-axes of the upright cell (mm). Squash never changes them, so the cell keeps its size. */
const RX = 80, RY = 94;
const R0 = Math.sqrt(RX * RY);
/** Angular samples around the cell. */
const M = 2880;
const RESTS = new Set([5, 6, 16, 17, 18, 29, 38, 39, 48, 49, 50, 51, 60]);

const n = (ctx: SketchContext, id: string): number => ctx.params[id] as number;
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const mod = (v: number, m: number): number => ((v % m) + m) % m;
const smooth = (e0: number, e1: number, v: number): number => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

function length(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}
const insideArt = (p: Point): boolean => p.x >= PLONK_ART.left && p.x <= PLONK_ART.right && p.y >= PLONK_ART.top && p.y <= PLONK_ART.bottom;

export function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function nearPolygon(p: Point, polygon: Point[], reach: number): boolean {
  if (inPolygon(p, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) if (segmentDistance(p, polygon[j], polygon[i]) < reach) return true;
  return false;
}
function smin(a: number, b: number, k: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---------------------------------------------------------------- plank

export type Plank = {
  /** Underside midpoint, unit long axis, unit "up" normal (screen-upward), length, thickness. */
  base: Point; along: Point; up: Point; length: number; thick: number; tilt: number;
  /** Local (u along, v up) top profile: stations and heights as fractions of thickness. */
  stations: number[]; heights: number[];
  polygon: Point[];
  /** +1 when the u > 0 end bites deeper (lower on the page). */
  deep: number;
};

const plankPoint = (pl: Plank, u: number, v: number): Point =>
  ({ x: pl.base.x + pl.along.x * u + pl.up.x * v, y: pl.base.y + pl.along.y * u + pl.up.y * v });

function makePlank(base: Point, length: number, thick: number, tilt: number, r: () => number): Plank {
  const along = { x: Math.cos(tilt), y: Math.sin(tilt) };
  const up = { x: Math.sin(tilt), y: -Math.cos(tilt) };
  // Stepped top: square setbacks on one straight axis, as on the original terraces.
  const bays = 4 + Math.floor(r() * 2);
  const weights = Array.from({ length: bays }, () => 0.7 + r() * 0.6);
  const sum = weights.reduce((a, b) => a + b, 0);
  const levels = [0.9, 1.0, 0.94, 1.07, 0.97, 1.04, 0.92];
  const shift = Math.floor(r() * levels.length);
  const stations = [0];
  for (let k = 0; k < bays; k++) stations.push(stations[k] + weights[k] / sum);
  stations[bays] = 1;
  const heights = weights.map((_, k) => levels[(k + shift) % levels.length]);
  const pl: Plank = { base, along, up, length, thick, tilt, stations, heights, polygon: [], deep: Math.sign(along.y) || 1 };
  const L = length / 2;
  const poly: Point[] = [plankPoint(pl, -L, 0), plankPoint(pl, L, 0)];
  for (let k = bays - 1; k >= 0; k--) {
    const v = heights[k] * thick;
    poly.push(plankPoint(pl, -L + stations[k + 1] * length, v), plankPoint(pl, -L + stations[k] * length, v));
  }
  pl.polygon = poly;
  return pl;
}

// ---------------------------------------------------------------- cell

export type Cell = {
  O: Point; lobes: number; phase: number; chirality: number; warp: number; warpPhase: number;
  a: number; bUp: number; bDown: number; ear: number; earL: number; earR: number;
  /** Per angle: membrane radius, natural (unclamped) radius, crater radius, contact 0..1, and radial gap per ring. */
  B: Float64Array; nat: Float64Array; Cr: Float64Array; contact: Float64Array; gapPerRing: Float64Array;
  N: number; restArea: number; area: number; floorY: number; squash: number;
};

function lobe(c: Pick<Cell, 'lobes' | 'phase' | 'warp' | 'warpPhase'>, theta: number, amp = 1, shift = 0): number {
  const N = c.lobes, p = c.phase + shift;
  return 1 + amp * (0.062 * Math.sin(N * theta + p) + 0.018 * Math.sin(2 * N * theta - p * 0.6)
    + 0.028 * Math.sin(Math.max(1, N - 2) * theta - 0.4 + p * 0.3))
    + c.warp * 0.05 * Math.sin(3 * theta + c.warpPhase);
}
function superRadius(theta: number, a: number, b: number, p: number): number {
  return 1 / Math.pow(Math.pow(Math.abs(Math.cos(theta) / a), p) + Math.pow(Math.abs(Math.sin(theta) / b), p), 1 / p);
}
/** The cell before anything lands on it: an upright lobed oval. */
export function restRadius(c: Pick<Cell, 'lobes' | 'phase' | 'warp' | 'warpPhase'>, theta: number): number {
  return superRadius(theta, RX, RY, 2) * lobe(c, theta);
}
function polygonArea(r: ArrayLike<number>): number {
  let area = 0;
  for (let i = 0; i < r.length; i++) area += 0.5 * r[i] * r[i] * (TAU / r.length);
  return area;
}

/** Clamp surface: the plank underside, with a fillet that curls up past each end so the dough wraps the corner behind the slab. */
function clampY(pl: Plank, x: number): number {
  const u = (x - pl.base.x) / pl.along.x;
  const y = pl.base.y + pl.along.y * u;
  const over = Math.abs(u) - (pl.length / 2 - 9);
  return over > 0 ? y - (over * over) / 14 : y;
}

function rayToPlank(pl: Plank, O: Point, theta: number, tmax: number): number {
  const c = Math.cos(theta), s = Math.sin(theta);
  if (s >= -1e-6) return Infinity;
  const g = (t: number) => O.y + t * s - clampY(pl, O.x + t * c);
  let prev = 0;
  for (let t = 0.8; t <= tmax; t += 0.8) {
    if (g(t) <= 0) {
      let lo = prev, hi = t;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (g(m) <= 0) hi = m; else lo = m; }
      return (lo + hi) / 2;
    }
    prev = t;
  }
  return Infinity;
}

type Shape = { O: Point; a: number; bUp: number; bDown: number; ear: number; earL: number; earR: number };
function naturalRadius(c: Cell | (Shape & Pick<Cell, 'lobes' | 'phase' | 'warp' | 'warpPhase'>), theta: number): number {
  const b = Math.sin(theta) < 0 ? c.bUp : c.bDown;
  let r = superRadius(theta, c.a, b, 2.2) * lobe(c, theta);
  // Muffin ears: the dough rises around both ends of the slab.
  const bump = (centre: number) => Math.exp(-(((mod(theta - centre + Math.PI, TAU) - Math.PI) / 0.34) ** 2));
  r *= 1 + c.ear * (bump(c.earL) + bump(c.earR));
  return r;
}

function membrane(shape: Shape & Pick<Cell, 'lobes' | 'phase' | 'warp' | 'warpPhase'>, pl: Plank, floorY: number, count: number) {
  const B = new Float64Array(count), nat = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * TAU;
    const natural = naturalRadius(shape, theta);
    nat[i] = natural;
    const s = Math.sin(theta);
    const toFloor = s > 1e-6 ? (floorY - shape.O.y) / s : Infinity;
    const toPlank = rayToPlank(pl, shape.O, theta, natural + 20);
    B[i] = smin(smin(natural, toPlank, 14), toFloor, 6);
    // smin may undercut the floor slightly; never let it overshoot.
    if (B[i] > toFloor) B[i] = toFloor;
  }
  return { B, nat };
}

function makeCell(ctx: SketchContext, pl: Plank, O: Point, H: number, squash: number, floorY: number): Cell {
  const anatomy = ctx.random('plonk-anatomy');
  const lobes = clamp(Math.round(n(ctx, 'lobeCount') + (anatomy() - 0.5) * 2.1), 3, 12);
  const phase = anatomy() * TAU;
  const chirality = anatomy() < 0.5 ? -1 : 1;
  const warpPhase = anatomy() * TAU;
  const warp = n(ctx, 'shellWarp');
  const genes = { lobes, phase, warp, warpPhase };
  // Rest area: the same lobed cell as a circle, before anything lands on it.
  const rest = new Float64Array(720);
  for (let i = 0; i < rest.length; i++) rest[i] = restRadius(genes, (i / rest.length) * TAU);
  const restArea = polygonArea(rest);
  // The natural shape overshoots both clamps, so contact flats grow with squash: a broad bite under the slab,
  // a small footprint on the floor, and a round belly between them.
  const bUp = (H / 2) * (1 + 0.04 + 0.5 * squash), bDown = (H / 2) * (1 + 0.03 + 0.14 * squash);
  const end = (sign: number) => {
    const p = plankPoint(pl, sign * pl.length / 2, 0);
    const theta = Math.atan2(p.y - O.y, p.x - O.x);
    // Push the ear just outside the slab end, toward the horizontal.
    return theta + (sign > 0 ? 0.22 : -0.22);
  };
  const shape = { O, bUp, bDown, ear: 0.6 * squash, earL: end(-1), earR: end(1), ...genes };
  // Area conservation: solve the half-width so the clamped cell keeps its rest area.
  let lo = 0.5 * R0, hi = 3.5 * R0;
  for (let k = 0; k < 32; k++) {
    const a = (lo + hi) / 2;
    if (polygonArea(membrane({ ...shape, a }, pl, floorY, 720).B) < restArea) lo = a; else hi = a;
  }
  const a = (lo + hi) / 2;
  const { B, nat } = membrane({ ...shape, a }, pl, floorY, M);

  // Crater: a squashed, slightly grinning oval that always stays open.
  const q = H / (2 * RY);
  const bc = Math.max(10, Math.min(0.3 * RY * Math.pow(q, 1.2), 0.4 * H / 2));
  const ac = Math.min(0.32 * RX / Math.pow(q, 0.85), 0.5 * a);
  const Cr = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const theta = (i / M) * TAU;
    const up = Math.sin(theta) < 0;
    // The grin leans with the slab: the deep end presses its corner of the mouth down.
    const lean = theta - pl.tilt * 0.9;
    const b = up ? bc * (1 - 0.3 * squash) : bc * (1 + 0.22 * squash);
    let r = superRadius(lean, ac, b, 2.3) * lobe(genes, theta, 0.35, chirality * 0.8);
    if (up) r *= 1 - 0.32 * squash * Math.exp(-(((mod(lean, TAU) - 1.5 * Math.PI) / 0.5) ** 2));
    Cr[i] = Math.min(r, 0.55 * B[i]);
  }

  // Contact: how hard each ray is pressed by the slab or the floor, spread smoothly around the cell.
  const pitch = n(ctx, 'lamellaPitch');
  const N = Math.max(6, Math.round((R0 * 0.7) / pitch));
  const raw = new Float64Array(M);
  for (let i = 0; i < M; i++) raw[i] = smooth(0, 0.14 * R0, nat[i] - B[i]);
  const contact = blur(raw, Math.round(M / 90));
  // Bunching limit per ray: the outermost gap may not close below the design floor (radial gap, corrected for obliquity).
  const lim = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const dB = (B[(i + 1) % M] - B[(i + M - 1) % M]) / (2 * TAU / M);
    const gap = (B[i] - Cr[i]) * B[i] / Math.hypot(B[i], dB) / N;
    lim[i] = gap;
  }
  const gapPerRing = blur(lim, Math.round(M / 120));
  const area = polygonArea(B);
  return { O, a, bUp, bDown, ear: shape.ear, earL: shape.earL, earR: shape.earR, ...genes, chirality, B, nat, Cr, contact, gapPerRing, N, restArea, area, floorY, squash };
}

const ray = (c: Cell, i: number, r: number): Point => {
  const theta = (i / M) * TAU;
  return { x: c.O.x + r * Math.cos(theta), y: c.O.y + r * Math.sin(theta) };
};
/** Polar lookup of a page point about the cell origin: fractional sample index and radius. */
function polarOf(c: Cell, x: number, y: number): { i: number; r: number } {
  const theta = mod(Math.atan2(y - c.O.y, x - c.O.x), TAU);
  return { i: (theta / TAU) * M, r: Math.hypot(x - c.O.x, y - c.O.y) };
}
function sample(arr: Float64Array, fi: number): number {
  const i0 = Math.floor(fi), f = fi - i0;
  return mix(arr[mod(i0, M)], arr[mod(i0 + 1, M)], f);
}
/** Circular box blur, applied twice (a triangle kernel). */
function blur(src: Float64Array, half: number): Float64Array {
  if (half < 1) return src;
  let cur = src;
  for (let pass = 0; pass < 2; pass++) {
    const prefix = new Float64Array(M + 1);
    for (let i = 0; i < M; i++) prefix[i + 1] = prefix[i] + cur[i];
    const out = new Float64Array(M);
    const w = 2 * half + 1;
    for (let i = 0; i < M; i++) {
      let lo = i - half, hi = i + half + 1, sum = 0;
      if (lo < 0) { sum += prefix[M] - prefix[M + lo]; lo = 0; }
      if (hi > M) { sum += prefix[hi - M]; hi = M; }
      sum += prefix[hi] - prefix[lo];
      out[i] = sum / w;
    }
    cur = out;
  }
  return cur;
}

// ---------------------------------------------------------------- squash field

type Grid = { nx: number; ny: number; x0: number; y0: number; gx: number; gy: number };

/**
 * Squash field: the radial fraction t = (r - crater) / (membrane - crater), uniform at rest, so lamellae keep their count
 * and crowd wherever the cell is pressed thin. Seen from one centre, a flat slab's corners would crease every ring
 * all the way to the crater, so the field is diffused coarse to fine (about 17 mm of smoothing) with both boundaries
 * held: the corners round off on the way in. Fixed nodes carry the radial ramp past each boundary, so the zero and
 * unit levels sit on the true curves.
 */
function squashField(c: Cell, box: { x0: number; y0: number; x1: number; y1: number }, finest: number): { F: Float32Array; g: Grid } {
  let prev: { F: Float32Array; T: Float32Array; g: Grid } | undefined;
  const steps = [finest * 8, finest * 4, finest * 2, finest];
  const iterations = [55, 40, 30, 30];
  for (let level = 0; level < steps.length; level++) {
    const h = steps[level];
    const nx = Math.ceil((box.x1 - box.x0) / h) + 1, ny = Math.ceil((box.y1 - box.y0) / h) + 1;
    const g: Grid = { nx, ny, x0: box.x0, y0: box.y0, gx: h, gy: h };
    const F = new Float32Array(nx * ny), T = new Float32Array(nx * ny), fixed = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const idx = j * nx + i, x = box.x0 + i * h, y = box.y0 + j * h;
      const { i: fi, r } = polarOf(c, x, y);
      const Bm = sample(c.B, fi), Cm = sample(c.Cr, fi);
      const span = Math.max(1, Bm - Cm);
      // Beside a thin ear the ramp of a neighbouring ray runs far past 1; hold fixed values near their boundary level.
      const ramp = clamp((r - Cm) / span, -2 * h / span, 1 + 2 * h / span);
      T[idx] = ramp;
      if (r >= Bm || r <= Cm || i === 0 || j === 0 || i === nx - 1 || j === ny - 1) { fixed[idx] = 1; F[idx] = ramp; continue; }
      F[idx] = ramp;
      if (prev) {
        // Carry the coarse level's accumulated smoothing as a correction to the exact ramp.
        const pg = prev.g, px = (x - pg.x0) / pg.gx, py = (y - pg.y0) / pg.gy;
        const ix = clamp(Math.floor(px), 0, pg.nx - 2), iy = clamp(Math.floor(py), 0, pg.ny - 2), fx = px - ix, fy = py - iy;
        const k = iy * pg.nx + ix;
        const corr = (A: Float32Array) => mix(mix(A[k], A[k + 1], fx), mix(A[k + pg.nx], A[k + pg.nx + 1], fx), fy);
        F[idx] += corr(prev.F) - corr(prev.T);
      }
    }
    let src = F, dst = new Float32Array(F);
    for (let it = 0; it < iterations[level]; it++) {
      for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const idx = j * nx + i;
        dst[idx] = fixed[idx] ? src[idx] : 0.25 * (src[idx - 1] + src[idx + 1] + src[idx - nx] + src[idx + nx]);
      }
      [src, dst] = [dst, src];
    }
    prev = { F: src, T, g };
  }
  // Near the membrane keep the raw fraction: the creases live inside, and diffusion would empty the thin ears.
  const { F, T, g } = prev!;
  for (let k = 0; k < F.length; k++) F[k] = mix(F[k], T[k], smooth(0.5, 0.92, T[k]));
  return { F, g };
}

/** Multi-level marching squares with chained polylines (after Pressure Foam). */
function contour(F: Float32Array, g: Grid, levels: number[]): Point[][][] {
  const { nx, ny, x0, y0, gx, gy } = g;
  const E = nx * ny;
  const keyA: number[] = [], keyB: number[] = [], ax: number[] = [], ay: number[] = [], bx: number[] = [], by: number[] = [], lev: number[] = [];
  const pt = (i: number, j: number, edge: number, l: number, a: number, b: number, c: number, d: number): [number, number, number] => {
    switch (edge) {
      case 0: { const t = (l - a) / (b - a); return [x0 + (i + t) * gx, y0 + j * gy, j * nx + i]; }
      case 1: { const t = (l - b) / (c - b); return [x0 + (i + 1) * gx, y0 + (j + t) * gy, E + j * nx + i + 1]; }
      case 2: { const t = (l - d) / (c - d); return [x0 + (i + t) * gx, y0 + (j + 1) * gy, (j + 1) * nx + i]; }
      default: { const t = (l - a) / (d - a); return [x0 + i * gx, y0 + (j + t) * gy, E + j * nx + i]; }
    }
  };
  const T = 0, R = 1, B = 2, L = 3;
  const table: number[][] = [[], [L, B], [B, R], [L, R], [T, R], [], [T, B], [T, L], [T, L], [T, B], [], [T, R], [L, R], [B, R], [L, B], []];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = F[j * nx + i], b = F[j * nx + i + 1], c = F[(j + 1) * nx + i + 1], d = F[(j + 1) * nx + i];
    const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
    let s = 0, e = levels.length;
    while (s < e) { const m = (s + e) >> 1; if (levels[m] < lo) s = m + 1; else e = m; }
    for (let k = s; k < levels.length && levels[k] < hi; k++) {
      const l = levels[k];
      const idx = (a > l ? 8 : 0) | (b > l ? 4 : 0) | (c > l ? 2 : 0) | (d > l ? 1 : 0);
      let pairs: number[];
      if (idx === 5 || idx === 10) {
        const centre = (a + b + c + d) / 4 > l;
        pairs = (idx === 5) === centre ? [T, L, B, R] : [T, R, L, B];
      } else pairs = table[idx];
      for (let p = 0; p < pairs.length; p += 2) {
        const P = pt(i, j, pairs[p], l, a, b, c, d), Q = pt(i, j, pairs[p + 1], l, a, b, c, d);
        keyA.push(k * 2 * E + P[2]); keyB.push(k * 2 * E + Q[2]);
        ax.push(P[0]); ay.push(P[1]); bx.push(Q[0]); by.push(Q[1]); lev.push(k);
      }
    }
  }
  const first = new Map<number, number>(), second = new Map<number, number>();
  for (let s = 0; s < keyA.length; s++) for (const key of [keyA[s], keyB[s]]) {
    if (first.has(key)) second.set(key, s); else first.set(key, s);
  }
  const other = (key: number, s: number): number | undefined => first.get(key) === s ? second.get(key) : first.get(key);
  const visited = new Uint8Array(keyA.length);
  const out: Point[][][] = levels.map(() => []);
  const walk = (start: number, key: number, sink: Point[], close: boolean) => {
    let cur = start;
    for (;;) {
      const next = other(key, cur);
      if (next === undefined) return;
      if (visited[next]) { if (close && next === start && next !== cur) sink.push({ x: ax[start], y: ay[start] }); return; }
      visited[next] = 1;
      if (keyA[next] === key) { sink.push({ x: bx[next], y: by[next] }); key = keyB[next]; }
      else { sink.push({ x: ax[next], y: ay[next] }); key = keyA[next]; }
      cur = next;
    }
  };
  for (let s = 0; s < keyA.length; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const forward: Point[] = [{ x: ax[s], y: ay[s] }, { x: bx[s], y: by[s] }];
    walk(s, keyB[s], forward, true);
    const backward: Point[] = [];
    walk(s, keyA[s], backward, false);
    out[lev[s]].push([...backward.reverse(), ...forward]);
  }
  return out;
}

// ---------------------------------------------------------------- spacing guard (after Pressure Foam)

class Clearance {
  private cells = new Map<number, number[]>();
  /** Total arclength of closed loops: their start and end are neighbours, not a fold-back. */
  readonly loops = new Map<number, number>();
  private key(ix: number, iy: number): number { return ix * 100003 + iy; }
  blocked(x: number, y: number, id: number, s: number): boolean {
    const ix = Math.floor(x / GUARD), iy = Math.floor(y / GUARD);
    for (let a = ix - 1; a <= ix + 1; a++) for (let b = iy - 1; b <= iy + 1; b++) {
      const cell = this.cells.get(this.key(a, b));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 4) {
        if (cell[k + 2] === id) {
          const loop = this.loops.get(id);
          const ds = Math.abs(cell[k + 3] - s);
          if (ds < 2 || (loop !== undefined && loop - ds < 2)) continue;
        }
        if ((cell[k] - x) ** 2 + (cell[k + 1] - y) ** 2 < GUARD * GUARD) return true;
      }
    }
    return false;
  }
  add(p: Point, id: number, s: number): void {
    const key = this.key(Math.floor(p.x / GUARD), Math.floor(p.y / GUARD));
    const cell = this.cells.get(key);
    if (cell) cell.push(p.x, p.y, id, s); else this.cells.set(key, [p.x, p.y, id, s]);
  }
}
function densify(path: Point[], step: number): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: mix(a.x, b.x, j / k), y: mix(a.y, b.y, j / k) });
  }
  return out;
}
function simplify(path: Point[], tol: number): Point[] {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = path[s], b = path[e];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    let worst = -1, at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = len < 1e-9 ? Math.hypot(path[i].x - a.x, path[i].y - a.y) : Math.abs((path[i].x - a.x) * dy - (path[i].y - a.y) * dx) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([s, at], [at, e]); }
  }
  return path.filter((_, i) => keep[i]);
}
type Tagged = { path: Point[]; pen: string };
const closed = (path: Point[]): boolean => path.length > 2 && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) < 1e-6;
/** Cut every line where it would run closer than GUARD to an accepted one. Earlier lines have priority. */
function guard(lines: Tagged[], clearance: Clearance, minLength: number): Tagged[] {
  const out: Tagged[] = [];
  lines.forEach((line, id) => {
    const dense = densify(line.path, 0.2);
    const loop = closed(line.path);
    if (loop) clearance.loops.set(id, length(dense));
    const runs: { points: Point[]; first: boolean; last: boolean }[] = [];
    let run: Point[] = [], start = 0, s = 0;
    let lastEnd: Point | undefined;
    const flush = (end: number) => {
      if (run.length > 1) runs.push({ points: run, first: start === 0, last: end === dense.length - 1 });
      if (run.length) lastEnd = run[run.length - 1];
      run = [];
    };
    for (let i = 0; i < dense.length; i++) {
      const p = dense[i];
      if (i > 0) s += Math.hypot(p.x - dense[i - 1].x, p.y - dense[i - 1].y);
      // After a cut, the same line resumes only a clear gap later (no crumbs of near-touching ends).
      if (clearance.blocked(p.x, p.y, id, s) || (!run.length && lastEnd && Math.hypot(p.x - lastEnd.x, p.y - lastEnd.y) < 0.6)) flush(i - 1);
      else { if (!run.length) start = i; run.push(p); clearance.add(p, id, s); }
    }
    flush(dense.length - 1);
    if (loop && runs.length > 1 && runs[0].first && runs[runs.length - 1].last) {
      // A closed ring cut elsewhere still runs straight through its seam: rejoin the two pieces that meet there.
      const tail = runs.pop()!;
      runs[0] = { points: [...tail.points, ...runs[0].points.slice(1)], first: false, last: false };
    }
    if (loop && runs.length > 0) {
      // Across the seam the gap counts too: trim the final piece back from the first piece's start.
      const head = runs[0].points[0], tail = runs[runs.length - 1].points;
      if (runs.length > 1 || tail[0] !== head) while (tail.length > 1 && Math.hypot(tail[tail.length - 1].x - head.x, tail[tail.length - 1].y - head.y) < 0.6) tail.pop();
    }
    for (const r of runs) if (length(r.points) >= minLength) out.push({ path: simplify(r.points, 0.01), pen: line.pen });
  });
  return out;
}

// ---------------------------------------------------------------- drawing

export function drawPlonk(ctx: SketchContext): Part[] {
  const place = ctx.random('plonk-placement');
  const plankRand = ctx.random('plonk-plank');
  const squash = clamp(n(ctx, 'squash'), 0, 1);
  const floorY = PLONK_ART.bottom - 0.6;
  const cx = (PLONK_ART.left + PLONK_ART.right) / 2 + (place() - 0.5) * 8;
  const H = 2 * RY * (1 - 0.62 * squash);
  const O = { x: cx, y: floorY - H / 2 };
  const tiltSign = plankRand() < 0.5 ? -1 : 1;
  const tilt = tiltSign * (n(ctx, 'plankTilt') + (plankRand() - 0.5) * 1.6) * Math.PI / 180;
  const shift = (plankRand() - 0.5) * 18;
  const plank = makePlank({ x: cx + shift, y: floorY - H + Math.tan(tilt) * shift }, n(ctx, 'plankWidth'), n(ctx, 'plankWeight'), tilt, plankRand);
  const cell = makeCell(ctx, plank, O, H, squash, floorY);
  const hidden = (p: Point) => nearPolygon(p, plank.polygon, 0.62);
  const keep = (p: Point) => insideArt(p) && !hidden(p);

  // ---- cell lines, in guard priority order: membrane, crater lips, droplets, then rings from the outside in.
  const tagged: Tagged[] = [];
  const pushCollected = (source: Point[], pen: string) => {
    const paths: Point[][] = [];
    collect(source, keep, paths);
    for (const path of paths) tagged.push({ path, pen });
  };
  const outline = Array.from({ length: M + 1 }, (_, i) => ray(cell, i % M, cell.B[i % M]));
  pushCollected(outline, 'membrane');
  const crater = Array.from({ length: M + 1 }, (_, i) => ray(cell, i % M, cell.Cr[i % M]));
  pushCollected(crater, 'crater');
  // Paired lip: a true normal offset, so the pair stays 0.95 mm apart even where the lip runs oblique to the rays.
  pushCollected(Array.from({ length: M + 1 }, (_, i) => {
    const a = crater[(i + M - 1) % M], b = crater[(i + 1) % M], p = crater[i % M];
    const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
    let nx = ty / tl, ny = -tx / tl;
    if (nx * (p.x - cell.O.x) + ny * (p.y - cell.O.y) < 0) { nx = -nx; ny = -ny; }
    return { x: p.x + nx * 0.95, y: p.y + ny * 0.95 };
  }), 'crater');

  // Squeezed-out droplets: tiny cells beside the bulge, sitting on the floor.
  const dropRand = ctx.random('plonk-droplets');
  const dropCount = Math.round(n(ctx, 'droplets'));
  const droplets: { c: Point; r: number }[] = [];
  const sizes = [0, 1, 2].map(() => 4.5 + dropRand() * 5);
  const jitter = [0, 1, 2].map(() => dropRand());
  for (let k = 0; k < dropCount; k++) {
    const side = (k % 2 === 0 ? plank.deep : -plank.deep);
    const r = sizes[k] * (k === 2 ? 0.6 : 1);
    // Farthest membrane point on this side at droplet height, then a small gap.
    let edge = side > 0 ? -Infinity : Infinity;
    for (let i = 0; i < M; i++) {
      const p = ray(cell, i, cell.B[i]);
      if (p.y < floorY - 2.6 * r - (k === 2 ? 12 : 0)) continue;
      edge = side > 0 ? Math.max(edge, p.x) : Math.min(edge, p.x);
    }
    const prior = droplets.filter((_, j) => (j % 2 === 0 ? plank.deep : -plank.deep) === side);
    const outward = prior.reduce((acc, d) => side > 0 ? Math.max(acc, d.c.x + d.r) : Math.min(acc, d.c.x - d.r), edge);
    const centre = { x: outward + side * (r + 2.5 + jitter[k] * 4), y: floorY - r * 0.82 - (k === 2 ? 3 + jitter[k] * 6 : 0) };
    if (!Number.isFinite(centre.x) || centre.x - r < PLONK_ART.left + 1 || centre.x + r > PLONK_ART.right - 1) continue;
    droplets.push({ c: centre, r });
  }
  for (const d of droplets) {
    const ring = (rr: number) => Array.from({ length: 241 }, (_, j) => {
      const theta = (j / 240) * TAU;
      const rad = rr * (1 + 0.06 * Math.sin(3 * theta + d.r));
      return { x: d.c.x + rad * Math.cos(theta) * 1.12, y: Math.min(floorY, d.c.y + rad * Math.sin(theta) * 0.84) };
    });
    pushCollected(ring(d.r), 'membrane');
    pushCollected(ring(d.r * 0.32), 'crater');
    for (let k = 1; k < Math.max(2, Math.floor(d.r / 1.6)); k++) pushCollected(ring(d.r * (0.32 + 0.68 * k / Math.max(2, Math.floor(d.r / 1.6)))), 'ultramarine');
  }

  const rhythm = Math.floor(ctx.random('plonk-rhythm')() * 64);
  // Lamellae: level sets of the harmonic squash field, bunched further toward the membrane where pressed.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < M; i++) {
    const p = ray(cell, i, cell.B[i]);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const box = { x0: Math.max(PLONK_ART.left, x0) - 2, y0: Math.max(PLONK_ART.top, y0) - 2, x1: Math.min(PLONK_ART.right, x1) + 2, y1: Math.min(PLONK_ART.bottom, y1) + 2 };
  const { F: phi, g } = squashField(cell, box, 0.4);
  const psi = new Float32Array(phi.length);
  const strength = 0.6 + 2.4 * squash;
  const lnN = Math.log(cell.N);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const idx = j * g.nx + i, f = phi[idx];
    if (f <= 0 || f >= 1 || i === 0 || j === 0 || i === g.nx - 1 || j === g.ny - 1) { psi[idx] = f; continue; }
    const x = g.x0 + i * g.gx, y = g.y0 + j * g.gy;
    const { i: fi } = polarOf(cell, x, y);
    const c = sample(cell.contact, fi) * smooth(0.25, 0.9, f);
    // Clamp the bunching so the outermost gap, (1/N)^gamma of the span, never closes below the design floor.
    const span = sample(cell.gapPerRing, fi) * cell.N;
    const limit = Math.max(1, Math.log(span / DESIGN_FLOOR) / lnN);
    const gamma = Math.min(1 + strength * c, limit);
    let v = 1 - Math.pow(1 - f, 1 / gamma);
    const theta = (fi / M) * TAU;
    v += cell.warp * 0.06 * Math.sin(Math.PI * v) * Math.sin(2 * theta + cell.warpPhase + 1.7 * v) * (1 - c);
    psi[idx] = v;
  }
  const levels = Array.from({ length: cell.N - 1 }, (_, k) => (k + 1) / cell.N);
  const lamellae = contour(psi, g, levels);
  for (let k = levels.length - 1; k >= 0; k--) {
    const t = levels[k], lane = k + 1;
    for (const path of lamellae[k]) {
      let run: Point[] = [], pen = '';
      const flush = () => { if (run.length > 1) pushCollected(run, pen); run = []; };
      for (const p of path) {
        const { i: fi } = polarOf(cell, p.x, p.y);
        const theta = (fi / M) * TAU, contact = sample(cell.contact, fi);
        const group = mod(Math.floor((theta / TAU) * 64) + rhythm + Math.floor(lane / 4) * 3, 64);
        if (lane % 4 === 2 && contact < 0.2 && RESTS.has(group)) { flush(); pen = ''; continue; }
        // Pinch: the outer rings under the deeper end of the slab go hot, with a ragged edge.
        const u = (p.x - plank.base.x) * plank.along.x + (p.y - plank.base.y) * plank.along.y;
        const hot = contact > 0.7 && t > 0.72 && Math.sin(theta) < 0 && u * plank.deep > (0.1 + 0.035 * ((lane * 7) % 5)) * plank.length;
        const want = hot ? 'vermilion' : 'ultramarine';
        if (want !== pen) { flush(); pen = want; }
        run.push(p);
      }
      flush();
    }
  }
  const guarded = guard(tagged, new Clearance(), 0.8);
  const byPen = (pen: string) => guarded.filter(t => t.pen === pen).map(t => t.path);

  // ---- plank: outline, setbacks, engraved carbon face, grain.
  const edges: Point[][] = [], face: Point[][] = [];
  const stroke = (a: Point, b: Point, output: Point[][], keepFn: (p: Point) => boolean = insideArt) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.6));
    collect(Array.from({ length: steps + 1 }, (_, j) => ({ x: mix(a.x, b.x, j / steps), y: mix(a.y, b.y, j / steps) })), keepFn, output);
  };
  const ring = [...plank.polygon, plank.polygon[0]];
  for (let i = 1; i < ring.length; i++) stroke(ring[i - 1], ring[i], edges);
  const L = plank.length / 2, T = plank.thick;
  const faceTop = 0.5 * T;
  // Transverse setback lines down to the face, and the long arris that bounds the face.
  stroke(plankPoint(plank, -L, faceTop), plankPoint(plank, L, faceTop), edges);
  for (let k = 1; k < plank.stations.length - 1; k++) {
    const u = -L + plank.stations[k] * plank.length;
    stroke(plankPoint(plank, u, faceTop + 0.7), plankPoint(plank, u, Math.min(plank.heights[k - 1], plank.heights[k]) * T - 0.7), edges);
  }
  const hatch = 0.95;
  const slant = faceTop * 0.42;
  const count = Math.floor((plank.length + slant) / hatch);
  for (let h = 1; h < count; h++) {
    if (h % 13 === 8 || h % 13 === 9) continue;
    const u0 = -L - slant + h * hatch;
    // Clip each slanted engraving line to the face band.
    let a = { u: u0, v: 0.9 }, b = { u: u0 + slant, v: faceTop - 0.9 };
    const lerp = (uu: number) => ({ u: uu, v: mix(0.9, faceTop - 0.9, (uu - u0) / slant) });
    if (a.u < -L + 0.7) a = lerp(-L + 0.7);
    if (b.u > L - 0.7) b = lerp(L - 0.7);
    if (b.u - a.u < 0.6) continue;
    stroke(plankPoint(plank, a.u, a.v), plankPoint(plank, b.u, b.v), face);
  }
  // Upper face: long wavering wood grain that parts around one knot, so the slab reads as a plank.
  let longest = 0;
  for (let k = 1; k < plank.heights.length; k++) if (plank.stations[k + 1] - plank.stations[k] > plank.stations[longest + 1] - plank.stations[longest]) longest = k;
  const grain = ctx.random('plonk-grain');
  const grainPhase = grain() * TAU;
  const knotBay = { u0: -L + plank.stations[longest] * plank.length, u1: -L + plank.stations[longest + 1] * plank.length, top: plank.heights[longest] * T };
  const knot = { u: mix(knotBay.u0, knotBay.u1, 0.3 + 0.4 * grain()), v: mix(faceTop, knotBay.top, 0.45 + 0.15 * grain()), K: Math.min(5, (knotBay.top - faceTop) * 0.16) };
  const knotW = knot.K * 3.2;
  // Still monotone in v (K <= 5), so grain lines part around the knot without crossing, and settle within ~10 mm.
  const parted = (k: number, u: number, v: number) => k === longest
    ? v + knot.K * Math.exp(-(((u - knot.u) / knotW) ** 2)) * Math.tanh((v - knot.v) / 3) * Math.exp(-Math.abs(v - knot.v) / 8) : v;
  let nearest = Infinity;
  for (let k = 0; k < plank.heights.length; k++) {
    const u0 = -L + plank.stations[k] * plank.length + 1.2, u1 = -L + plank.stations[k + 1] * plank.length - 1.2;
    const top = plank.heights[k] * T - 1.8;
    const bayPhase = grain() * TAU;
    for (let v = faceTop + 2.8, line = 0; v < top; v += 2.8, line++) {
      if (k === longest) nearest = Math.min(nearest, Math.abs(parted(k, knot.u, v) - knot.v));
      const cut = grain() < 0.15 ? mix(u0, u1, grain()) : NaN;
      // Neighbouring lines differ in amplitude by at most ~0.3 mm, so the grain breathes without closing up.
      const amp = 0.55 + 0.6 * Math.sin(line * 0.5 + bayPhase);
      const path: Point[] = [];
      for (let u = u0; u <= u1 + 1e-9; u += 1) {
        const vv = parted(k, u, v) + amp * Math.sin(u / 21 + grainPhase + bayPhase + 0.22 * line);
        const out = Math.abs(u - cut) < 1.2 || vv < faceTop + 1.2 || vv > top + 0.6;
        path.push(out ? { x: NaN, y: NaN } : plankPoint(plank, Math.min(u, u1), vv));
      }
      collect(path, insideArt, face);
    }
  }
  const knotLines: Point[][] = [];
  const vr = Math.max(0.8, nearest - 1.2);
  for (const f of [1, 0.45]) {
    const ellipse = Array.from({ length: 73 }, (_, j) => {
      const a = (j / 72) * TAU;
      return plankPoint(plank, knot.u + Math.cos(a) * vr * 2.4 * f, knot.v + Math.sin(a) * vr * f);
    });
    collect(ellipse, insideArt, knotLines);
  }

  // ---- comic timing: impact ticks at the contacts, fall lines above the slab.
  const impact = n(ctx, 'impactMarks');
  const ticks: Point[][] = [], falls: Point[][] = [];
  const outsideAll = (p: Point) => {
    if (!insideArt(p) || nearPolygon(p, plank.polygon, 1.2)) return false;
    const theta = mod(Math.atan2(p.y - cell.O.y, p.x - cell.O.x), TAU);
    const i = Math.round((theta / TAU) * M) % M;
    if (Math.hypot(p.x - cell.O.x, p.y - cell.O.y) < cell.B[i] + 1.5) return false;
    return droplets.every(d => Math.hypot(p.x - d.c.x, p.y - d.c.y) > d.r * 1.3 + 1.5);
  };
  if (impact > 0) {
    const tickCount = Math.round(2 + impact * 3);
    for (const sign of [-1, 1]) {
      // The corner where the slab's end meets the dough.
      const corner = plankPoint(plank, sign * L, Math.min(T * 0.25, 10));
      const outward = { x: plank.along.x * sign, y: plank.along.y * sign };
      const deeper = sign === plank.deep;
      for (let k = 0; k < tickCount; k++) {
        const f = tickCount === 1 ? 0.5 : k / (tickCount - 1);
        // Fan from straight up (along the slab normal) to outward, above the ear.
        const ang = mix(0.15, 1.25, f);
        const dir = { x: plank.up.x * Math.cos(ang) + outward.x * Math.sin(ang), y: plank.up.y * Math.cos(ang) + outward.y * Math.sin(ang) };
        const r0 = 5 + (k % 2) * 3, len = (8 + 12 * impact) * (deeper ? 1.25 : 0.9) * (k % 2 ? 0.75 : 1);
        stroke({ x: corner.x + dir.x * r0, y: corner.y + dir.y * r0 }, { x: corner.x + dir.x * (r0 + len), y: corner.y + dir.y * (r0 + len) }, ticks, outsideAll);
      }
    }
    // Floor contact: little puffs where the flattened base lifts off the floor.
    let left = Infinity, right = -Infinity;
    for (let i = 0; i < M; i++) {
      const p = ray(cell, i, cell.B[i]);
      if (p.y > floorY - 0.8) { left = Math.min(left, p.x); right = Math.max(right, p.x); }
    }
    if (Number.isFinite(left) && right - left > 8) {
      for (const [x, sign] of [[left, -1], [right, 1]] as const) {
        for (let k = 0; k < 2; k++) {
          const y = floorY - 1.4 - k * 3.2;
          stroke({ x: x + sign * (4 + k * 2), y }, { x: x + sign * (4 + k * 2 + 4 + 4 * impact), y: y - k * 1.5 }, ticks, outsideAll);
        }
      }
    }
    // Fall lines: the slab has only just arrived.
    const lines = Math.round(1 + impact * 3);
    const topV = Math.max(...plank.heights) * T;
    for (const sign of [-1, 1]) for (let k = 0; k < lines; k++) {
      const u = sign * L * mix(0.92, 0.5, k / Math.max(1, lines - 1)) + sign * 2;
      const base = plankPoint(plank, u, topV + 7 + k * 3);
      // Reach most of the way to the top margin; dashes thin out upward, the way the slab came down.
      const room = base.y - (PLONK_ART.top + 34);
      const len = Math.max(0, room * (0.45 + 0.45 * impact) * (1 - 0.14 * k));
      let y = base.y;
      for (const [frac, gap] of [[0.5, 4], [0.28, 5], [0.12, 0]] as const) {
        const seg = len * frac;
        if (seg >= 2) stroke({ x: base.x, y }, { x: base.x, y: y - seg }, falls, outsideAll);
        y -= seg + gap;
      }
    }
  }

  const membraneOutline = Array.from({ length: M }, (_, i) => ray(cell, i, cell.B[i]));
  const craterOutline = Array.from({ length: M }, (_, i) => ray(cell, i, cell.Cr[i]));
  return [
    { id: 'cell-membrane', pen: 'carbon', paths: byPen('membrane') },
    { id: 'crater-lips', pen: 'carbon', paths: byPen('crater') },
    { id: 'blue-lamellae', pen: 'ultramarine', paths: byPen('ultramarine') },
    { id: 'hot-pinch', pen: 'vermilion', paths: byPen('vermilion') },
    { id: 'plank-outline', pen: 'carbon', paths: edges },
    { id: 'plank-engraving', pen: 'carbon', paths: face },
    { id: 'plank-knot', pen: 'carbon', paths: knotLines },
    { id: 'impact-ticks', pen: 'acid', paths: ticks },
    { id: 'fall-lines', pen: 'violet', paths: falls },
    // Inspection only.
    { id: 'plonk-plank-mask', pen: 'carbon', paths: [], boundary: [plank.polygon], diagnostic: true },
    { id: 'plonk-membrane', pen: 'carbon', paths: [], boundary: [membraneOutline], diagnostic: true },
    { id: 'plonk-crater', pen: 'carbon', paths: [], boundary: [craterOutline], diagnostic: true },
    { id: 'plonk-rest', pen: 'carbon', paths: [], boundary: [Array.from({ length: 720 }, (_, i) => {
      const theta = (i / 720) * TAU;
      const r = restRadius(cell, theta);
      return { x: cell.O.x + r * Math.cos(theta), y: cell.O.y + r * Math.sin(theta) };
    })], diagnostic: true },
  ];
}
