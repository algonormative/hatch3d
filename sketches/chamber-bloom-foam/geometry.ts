import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { collect } from '../chamber-bloom/geometry.ts';

const TAU = Math.PI * 2;
/** TALL_ART in page millimetres: abstract mode maps it with the identity. */
export const FOAM_ART = { left: 18, right: 261.4, top: 18, bottom: 413.8 } as const;
/** Physical floor for parallel 0.25 mm pen lines. */
export const MIN_SPACING = 0.5;
/** Point-sampled clearance; leaves room for sampling and simplification error above MIN_SPACING. */
const GUARD = 0.54;
/** Wall compression may never tighten a lamella pitch below this, before the guard pass. */
const DESIGN_FLOOR = 0.64;
const GRID = 0.25;
const RESTS = new Set([5, 6, 16, 17, 18, 29, 38, 39, 48, 49, 50, 51, 60]);

export type Chamber = {
  cx: number; cy: number; rho: number; kappa: number; lobes: number; phase: number; chirality: number;
  cos: number; sin: number; sx: number; sy: number; warp: number; warpPhase: number;
  pitch: number; press: number; lambda: number; rhythm: number; dominant: boolean;
};
type Slab = { left: Point[]; right: Point[]; polygon: Point[]; major: boolean };
type Grid = { nx: number; ny: number; x0: number; y0: number; gx: number; gy: number };

const n = (ctx: SketchContext, id: string): number => ctx.params[id] as number;
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const mod = (v: number, m: number): number => ((v % m) + m) % m;

function length(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}
const insideArt = (p: Point): boolean => p.x >= FOAM_ART.left && p.x <= FOAM_ART.right && p.y >= FOAM_ART.top && p.y <= FOAM_ART.bottom;

export function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- chamber shell

/** Lobed outer radius at normalized depth u (0 centre, 1 free rim); lobes sharpen outward as in the original shell. */
function rhoAt(ch: Chamber, theta: number, u: number): number {
  const t = clamp(u, 0, 1.25);
  const N = ch.lobes;
  const scallop = 0.066 * Math.sin(N * theta + ch.phase + ch.chirality * t * 1.3) + 0.019 * Math.sin(2 * N * theta - ch.phase * 0.6 - t * 2);
  const slow = (0.02 + 0.03 * t) * Math.sin(Math.max(1, N - 2) * theta - 0.4 + 0.8 * t + ch.phase * 0.3);
  const bend = ch.warp * (0.25 + t) * 0.045 * Math.sin(3 * theta + 4.2 * t + ch.warpPhase);
  return ch.rho * (1 + scallop * (0.3 + 0.9 * t) + slow + bend);
}

function local(ch: Chamber, x: number, y: number): { r: number; theta: number } {
  const dx = x - ch.cx, dy = y - ch.cy;
  const lx = (dx * ch.cos + dy * ch.sin) / ch.sx, ly = (-dx * ch.sin + dy * ch.cos) / ch.sy;
  return { r: Math.hypot(lx, ly), theta: Math.atan2(ly, lx) };
}

/** Lobed normalized depth: fixed-point inversion of r = u·rho(theta, u). */
function lobedU(ch: Chamber, r: number, theta: number): number {
  let u = r / ch.rho;
  for (let k = 0; k < 4; k++) u = r / rhoAt(ch, theta, u);
  return u;
}

export function shellPoint(ch: Chamber, theta: number, u: number): Point {
  const r = u * rhoAt(ch, theta, u);
  const lx = r * Math.cos(theta) * ch.sx, ly = r * Math.sin(theta) * ch.sy;
  return { x: ch.cx + lx * ch.cos - ly * ch.sin, y: ch.cy + lx * ch.sin + ly * ch.cos };
}

/** Compression map: unit slope far from a wall, (1 + P) at it, so contour pitch tightens toward contact. */
const squeeze = (d: number, P: number, lambda: number): number => {
  const D = Math.max(0, d);
  return D + P * lambda * (1 - Math.exp(-D / lambda));
};
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---------------------------------------------------------------- layout

function makeChambers(ctx: SketchContext): Chamber[] {
  const W = FOAM_ART.right - FOAM_ART.left, H = FOAM_ART.bottom - FOAM_ART.top;
  const place = ctx.random('foam-placement');
  const count = clamp(Math.round(n(ctx, 'chamberCount')), 2, 4);
  const pitch = n(ctx, 'lamellaPitch');
  const pressure = n(ctx, 'pressure');
  const lobeBase = n(ctx, 'lobeCount');
  const warp = n(ctx, 'shellWarp');
  const make = (cx: number, cy: number, rho: number, dominant: boolean, id: number): Chamber => {
    const a = ctx.random(`foam-anatomy-${id}`);
    const tilt = mix(-0.4, 0.4, a());
    const p = dominant ? pitch : pitch * 1.3;
    const pMax = Math.max(0, p / DESIGN_FLOOR - 1);
    return {
      cx, cy, rho, dominant,
      kappa: dominant ? 0.29 + a() * 0.05 : 0.27 + a() * 0.07,
      lobes: clamp(Math.round(lobeBase + (a() - 0.5) * (dominant ? 2.1 : 4.2)), 3, 12),
      phase: a() * TAU, chirality: a() < 0.5 ? -1 : 1,
      cos: Math.cos(tilt), sin: Math.sin(tilt),
      sx: 0.93 + a() * 0.08, sy: 1.0 + a() * 0.1,
      warp, warpPhase: a() * TAU,
      pitch: p, press: pressure * pMax, lambda: 4 + 18 * pressure,
      rhythm: Math.floor(a() * 64),
    };
  };
  const rho0 = 116 * n(ctx, 'dominantSize') * (0.95 + 0.1 * place());
  const chambers = [make(
    FOAM_ART.left + W * clamp(n(ctx, 'craterX') + (place() - 0.5) * 0.08, 0.08, 0.92),
    FOAM_ART.top + H * clamp(n(ctx, 'craterY') + (place() - 0.5) * 0.06, 0.06, 0.94),
    rho0, true, 0)];
  // Coarse coverage lattice: subordinate chambers go where the sheet is still empty paper.
  const samples: Point[] = [];
  for (let j = 0; j < 40; j++) for (let i = 0; i < 24; i++) samples.push({ x: FOAM_ART.left + (i + 0.5) * W / 24, y: FOAM_ART.top + (j + 0.5) * H / 40 });
  const covered = (p: Point, c: { cx: number; cy: number; rho: number }) => Math.hypot(p.x - c.cx, p.y - c.cy) < c.rho * 0.9;
  for (let k = 1; k < count; k++) {
    const rho = rho0 * mix(0.8, 0.52, (k - 1) / 2) * (0.9 + 0.2 * place());
    let best: { cx: number; cy: number; score: number } | undefined;
    for (let c = 0; c < 90; c++) {
      const inset = rho * 0.42;
      const cand = { cx: mix(FOAM_ART.left + inset, FOAM_ART.right - inset, place()), cy: mix(FOAM_ART.top + inset, FOAM_ART.bottom - inset, place()), rho };
      let ok = true, touching = false;
      // Centre spacing over summed radii: < 0.62 would let a wall reach a crater, > 0.82 barely presses.
      for (const other of chambers) {
        const d = Math.hypot(cand.cx - other.cx, cand.cy - other.cy) / (other.rho + rho);
        if (d < 0.62) ok = false;
        if (d < 0.82) touching = true;
      }
      if (!ok || !touching) continue;
      let score = 0;
      for (const s of samples) if (covered(s, cand) && !chambers.some(o => covered(s, o)) && insideArt(s)) score++;
      score += place() * 0.5;
      if (!best || score > best.score) best = { ...cand, score };
    }
    if (!best) break;
    chambers.push(make(best.cx, best.cy, rho, false, k));
  }
  return chambers;
}

function slab(origin: Point, along: Point, total: number, width: number, bays: number, r: () => number, major: boolean): Slab {
  const across = { x: -along.y, y: along.x };
  const weights = Array.from({ length: bays }, () => 0.7 + r() * 0.6);
  const sum = weights.reduce((a, b) => a + b, 0);
  const profiles = [0.78, 1.17, 0.91, 1.29, 0.94, 1.08, 0.84, 1.21, 1.0, 0.88];
  const shift = Math.floor(r() * profiles.length);
  const left: Point[] = [], right: Point[] = [];
  let s = 0;
  for (let k = 0; k < bays; k++) {
    const half = width * profiles[(k + shift) % profiles.length] * 0.5;
    const offset = (r() - 0.5) * width * 0.16;
    const end = s + weights[k] / sum * total;
    for (const station of [k === 0 ? s : s + 0.9, end]) {
      const m = { x: origin.x + along.x * station + across.x * offset, y: origin.y + along.y * station + across.y * offset };
      left.push({ x: m.x - across.x * half, y: m.y - across.y * half });
      right.push({ x: m.x + across.x * half, y: m.y + across.y * half });
    }
    s = end;
  }
  return { left, right, polygon: [...left, ...[...right].reverse()], major };
}

function makeSlabs(ctx: SketchContext, dom: Chamber): Slab[] {
  const r = ctx.random('foam-buttress');
  const mirror = r() < 0.5 ? -1 : 1;
  const side = r() < 0.5 ? -1 : 1;
  const angle = mirror * (n(ctx, 'buttressAngle') + (r() - 0.5) * 24) * Math.PI / 180;
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -along.y, y: along.x };
  const offset = side * (n(ctx, 'buttressPosition') - 0.5) * 260;
  const anchor = { x: dom.cx + normal.x * offset, y: dom.cy + normal.y * offset };
  const corners = [[FOAM_ART.left, FOAM_ART.top], [FOAM_ART.right, FOAM_ART.top], [FOAM_ART.left, FOAM_ART.bottom], [FOAM_ART.right, FOAM_ART.bottom]];
  const reach = Math.max(...corners.map(([x, y]) => Math.abs((x - anchor.x) * along.x + (y - anchor.y) * along.y))) + 20;
  const width = n(ctx, 'buttressWidth');
  const slabs = [slab({ x: anchor.x - along.x * reach, y: anchor.y - along.y * reach }, along, reach * 2, width, 8 + Math.floor(r() * 3), r, true)];
  const minor = Math.round(n(ctx, 'minorTerraces'));
  const taken = [angle, angle + Math.PI];
  for (let i = 0; i < minor; i++) {
    const m = ctx.random(`foam-terrace-${i}`);
    // Minor terraces radiate from the dominant crater on straight local axes, away from the main buttress.
    const axis = (theta: number) => {
      const lt = local(dom, dom.cx + Math.cos(theta) * 50, dom.cy + Math.sin(theta) * 50).theta;
      return [shellPoint(dom, lt, dom.kappa + 0.05), shellPoint(dom, lt, 0.98)];
    };
    let bestTheta = 0, bestScore = -Infinity;
    for (let c = 0; c < 24; c++) {
      const theta = m() * TAU;
      const [o, f] = axis(theta);
      const crosses = Array.from({ length: 12 }, (_, k) => ({ x: mix(o.x, f.x, k / 11), y: mix(o.y, f.y, k / 11) }))
        .some(p => inPolygon(p, slabs[0].polygon) || !insideArt(p));
      const score = Math.min(...taken.map(t => Math.abs(mod(theta - t + Math.PI, TAU) - Math.PI))) - (crosses ? 4 : 0);
      if (score > bestScore) { bestScore = score; bestTheta = theta; }
    }
    taken.push(bestTheta);
    const [o, f] = axis(bestTheta);
    const d = Math.hypot(f.x - o.x, f.y - o.y);
    slabs.push(slab(o, { x: (f.x - o.x) / d, y: (f.y - o.y) / d }, d + 10, width * (0.3 + m() * 0.12), 4 + Math.floor(m() * 2), m, false));
  }
  return slabs;
}

// ---------------------------------------------------------------- marching squares

/** Multi-level marching squares with chained polylines; corners strictly above a level count as inside. */
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
    // levels are sorted; binary search the first level >= lo
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

// ---------------------------------------------------------------- spacing guard

/** Spatial hash of accepted shell lines. New lines are cut wherever they would run closer than GUARD to another line. */
class Clearance {
  private cells = new Map<number, number[]>();
  private readonly size = GUARD;
  private key(ix: number, iy: number): number { return ix * 100003 + iy; }
  /** A point of line `id` at arclength `s` is blocked by any other line, or by a distant stretch of its own line. */
  blocked(x: number, y: number, id: number, s: number): boolean {
    const ix = Math.floor(x / this.size), iy = Math.floor(y / this.size);
    for (let a = ix - 1; a <= ix + 1; a++) for (let b = iy - 1; b <= iy + 1; b++) {
      const cell = this.cells.get(this.key(a, b));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 4) {
        if (cell[k + 2] === id && Math.abs(cell[k + 3] - s) < 2) continue;
        if ((cell[k] - x) ** 2 + (cell[k + 1] - y) ** 2 < GUARD * GUARD) return true;
      }
    }
    return false;
  }
  add(p: Point, id: number, s: number): void {
    const key = this.key(Math.floor(p.x / this.size), Math.floor(p.y / this.size));
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
      // A closed run starts and ends on one point: measure from that point instead of a degenerate chord.
      const d = len < 1e-9 ? Math.hypot(path[i].x - a.x, path[i].y - a.y) : Math.abs((path[i].x - a.x) * dy - (path[i].y - a.y) * dx) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([s, at], [at, e]); }
  }
  return path.filter((_, i) => keep[i]);
}

type Tagged = { path: Point[]; id: number; pen: string; s0?: number };
/**
 * Cut each line where it crowds an accepted line, then simplify. Earlier entries have priority.
 * Points enter the hash as they are accepted; a line is exempt only from its own nearby stretch (2 mm of arclength),
 * so a contour folding back on itself is cut too. Rejected short runs stay in the hash, which only errs toward more paper.
 */
function guard(lines: Tagged[], clearance: Clearance, minLength: number): Tagged[] {
  const out: Tagged[] = [];
  const lastEnd = new Map<number, Point>();
  for (const line of lines) {
    const dense = densify(line.path, 0.2);
    let run: Point[] = [];
    const flush = () => {
      if (run.length > 1 && length(run) >= minLength) {
        out.push({ path: simplify(run, 0.01), id: line.id, pen: line.pen });
        lastEnd.set(line.id, run[run.length - 1]);
      }
      run = [];
    };
    let s = line.s0 ?? 0;
    for (let i = 0; i < dense.length; i++) {
      const p = dense[i];
      if (i > 0) s += Math.hypot(p.x - dense[i - 1].x, p.y - dense[i - 1].y);
      // A piece of the same line restarts either exactly where the last ended (colour change) or a clear gap later.
      const end = run.length ? undefined : lastEnd.get(line.id);
      const gap = end ? Math.hypot(p.x - end.x, p.y - end.y) : Infinity;
      if (clearance.blocked(p.x, p.y, line.id, s) || (gap > 1e-9 && gap < 0.6)) flush();
      else { run.push(p); clearance.add(p, line.id, s); }
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------- drawing

export function drawFoam(ctx: SketchContext): Part[] {
  const chambers = makeChambers(ctx);
  const dom = chambers[0];
  const slabs = makeSlabs(ctx, dom);
  const masked = (p: Point) => slabs.some(s => inPolygon(p, s.polygon));

  const nx = Math.round((FOAM_ART.right - FOAM_ART.left) / GRID) + 1, ny = Math.round((FOAM_ART.bottom - FOAM_ART.top) / GRID) + 1;
  const grid: Grid = { nx, ny, x0: FOAM_ART.left, y0: FOAM_ART.top, gx: (FOAM_ART.right - FOAM_ART.left) / (nx - 1), gy: (FOAM_ART.bottom - FOAM_ART.top) / (ny - 1) };
  const N = nx * ny, K = chambers.length;
  // Smooth (elliptic) depth decides ownership, so shared walls are calm membranes; lobed depth draws the shells.
  const U0 = chambers.map(() => new Float32Array(N));
  const owner = new Uint8Array(N);
  const Ulob = new Float32Array(N), Rf = new Float32Array(N), Wf = new Float32Array(N), Lf = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const idx = j * nx + i, x = grid.x0 + i * grid.gx, y = grid.y0 + j * grid.gy;
    let best = 0;
    for (let k = 0; k < K; k++) {
      const { r } = local(chambers[k], x, y);
      U0[k][idx] = r / chambers[k].rho;
      if (U0[k][idx] < U0[best][idx]) best = k;
    }
    owner[idx] = best;
    const { r, theta } = local(chambers[best], x, y);
    Ulob[idx] = lobedU(chambers[best], r, theta);
  }
  const grad = (F: Float32Array, i: number, j: number): [number, number] => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    return [(F[j * nx + i1] - F[j * nx + i0]) / ((i1 - i0) * grid.gx), (F[j1 * nx + i] - F[j0 * nx + i]) / ((j1 - j0) * grid.gy)];
  };
  let maxL = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const idx = j * nx + i, o = owner[idx], ch = chambers[o];
    const x = grid.x0 + i * grid.gx, y = grid.y0 + j * grid.gy;
    const R = (1 - Ulob[idx]) * ch.rho;
    let W = Infinity;
    for (let k = 0; k < K; k++) {
      if (k === o) continue;
      const [ax, ay] = grad(U0[k], i, j), [bx, by] = grad(U0[o], i, j);
      const D = (U0[k][idx] - U0[o][idx]) / Math.max(1e-6, Math.hypot(ax - bx, ay - by));
      W = Math.min(W, squeeze(D, ch.press, ch.lambda));
    }
    const frame = Math.min(x - FOAM_ART.left, FOAM_ART.right - x, y - FOAM_ART.top, FOAM_ART.bottom - y);
    // The aperture presses too, but only half way: frame-bound rings soften toward it instead of turning into nested boxes.
    const framed = squeeze(frame, ch.press * 0.25, ch.lambda * 0.5);
    W = Math.min(W, framed < R ? mix(framed, R, 0.45) : framed);
    Rf[idx] = R; Wf[idx] = W;
    Lf[idx] = smin(R, W, ch.pitch * 1.5) / ch.pitch;
    if (Lf[idx] > maxL) maxL = Lf[idx];
  }
  const node = (p: Point): number => {
    const i = clamp(Math.round((p.x - grid.x0) / grid.gx), 0, nx - 1), j = clamp(Math.round((p.y - grid.y0) / grid.gy), 0, ny - 1);
    return j * nx + i;
  };
  const craterCut = (ch: Chamber) => (1 - ch.kappa) * ch.rho - 1.4;

  // Shared walls: the zero set of each pair's ownership difference, drawn where either chamber is present.
  const walls: Point[][] = [];
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
    const F = new Float32Array(N);
    for (let idx = 0; idx < N; idx++) F[idx] = U0[a][idx] - U0[b][idx];
    for (const path of contour(F, grid, [0])[0]) {
      collect(path, p => {
        if (!insideArt(p) || masked(p)) return false;
        const o = owner[node(p)];
        if (o !== a && o !== b) return false;
        const la = local(chambers[a], p.x, p.y), lb = local(chambers[b], p.x, p.y);
        return lobedU(chambers[a], la.r, la.theta) < 1 || lobedU(chambers[b], lb.r, lb.theta) < 1;
      }, walls);
    }
  }
  const rims: Point[][] = [];
  for (const path of contour(Ulob, grid, [1])[0]) collect(path, p => insideArt(p) && !masked(p), rims);

  // Crater lips: parametric, paired carbon on the dominant chamber.
  const craters: Point[][] = [];
  const craterOutlines: Point[][] = [];
  for (const [k, ch] of chambers.entries()) {
    const us = ch.dominant ? [ch.kappa, ch.kappa + 0.75 / ch.rho] : [ch.kappa + 0.75 / ch.rho];
    for (const u of us) {
      const ring = Array.from({ length: 1201 }, (_, s) => shellPoint(ch, s / 1200 * TAU, u));
      if (u === us[0]) craterOutlines.push(ring.slice(0, -1));
      collect(ring, p => insideArt(p) && !masked(p) && owner[node(p)] === k, craters);
    }
  }

  // Lamellae: positive levels of the pressure field, recoloured in sparse sectors.
  const levels = Array.from({ length: Math.max(0, Math.floor(maxL)) }, (_, k) => k + 1);
  const contours = contour(Lf, grid, levels);
  const accent = ctx.random('foam-accents');
  const hotPhase = accent() * TAU, violetPhase = accent() * TAU;
  const tagged: Tagged[] = [];
  let id = 0;
  for (const p of walls) tagged.push({ path: p, id: id++, pen: 'walls' });
  for (const p of rims) tagged.push({ path: p, id: id++, pen: 'rims' });
  for (const p of craters) tagged.push({ path: p, id: id++, pen: 'craters' });
  const sector = (theta: number, phase: number, count: number, span: number) => {
    const step = TAU / count;
    return Math.abs(mod(theta - phase + step / 2, step) - step / 2) < span / 2;
  };
  const HARD = 'mask', REST = 'rest';
  for (const [k, paths] of contours.entries()) {
    const level = levels[k];
    for (const path of paths) {
      const lineId = id++;
      // Classify every point, then debounce: soft classes (rests, accent colours) shorter than 1.5 mm
      // join their predecessor, so no line is chopped into crumbs or sub-0.5 mm gaps. Masks are never overridden.
      const along: number[] = [0];
      for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
      const cls = path.map(p => {
        const idx = node(p), ch = chambers[owner[idx]];
        const R = Rf[idx], interior = R < Wf[idx] - ch.pitch;
        if (!insideArt(p) || R > craterCut(ch) || masked(p)) return HARD;
        const { theta } = local(ch, p.x, p.y);
        if (interior && level % 4 === 2 && RESTS.has(mod(Math.floor(mod(theta, TAU) / TAU * 64) + ch.rhythm + Math.floor(level / 4) * 3, 64))) return REST;
        if (interior && ch.dominant && R > craterCut(ch) - 4.2 * ch.pitch && sector(theta, hotPhase, 5, 0.42 + 0.12 * (level % 3))) return 'vermilion';
        if (interior && (ch.dominant ? (R > 3 * ch.pitch && R < 9 * ch.pitch) : level % 6 === 3) && sector(theta, violetPhase, 4, 0.38)) return 'violet';
        return 'ultramarine';
      });
      for (let i = 0; i < cls.length;) {
        let j = i;
        while (j + 1 < cls.length && cls[j + 1] === cls[i]) j++;
        const short = along[j] - along[i] < 1.5;
        if (short && cls[i] !== HARD) {
          const fill = i > 0 && cls[i - 1] !== HARD ? cls[i - 1] : j + 1 < cls.length && cls[j + 1] !== HARD ? cls[j + 1] : HARD;
          for (let q = i; q <= j; q++) cls[q] = fill;
        }
        i = j + 1;
      }
      let run: Point[] = [], pen = '', s0 = 0;
      const flush = () => { if (run.length > 1 && length(run) >= 1.5) tagged.push({ path: run, id: lineId, pen, s0 }); run = []; };
      for (let i = 0; i < path.length; i++) {
        const c = cls[i];
        if (c === HARD || c === REST) { flush(); pen = ''; continue; }
        // A colour change shares its boundary point so the line stays continuous.
        if (c !== pen && run.length) { flush(); run = [path[i - 1]]; s0 = along[i - 1]; }
        if (!run.length) s0 = along[i];
        pen = c;
        run.push(path[i]);
      }
      flush();
    }
  }
  const guarded = guard(tagged, new Clearance(), 1);
  const byPen = (pen: string) => guarded.filter(t => t.pen === pen).map(t => t.path);

  // Acid ribs: measured radial ticks across the dominant interior, with grouped rests.
  const ribs: Point[][] = [];
  for (let step = 0; step < 64; step++) {
    const beat = mod(step + dom.rhythm, 64);
    if (RESTS.has(beat) || step % 4 === 3) continue;
    const theta = (step + 0.5) / 64 * TAU + 0.05 * Math.sin(step * 0.7 + dom.phase);
    for (let band = 0; band < 5; band++) {
      if ((band + Math.floor(step / 8)) % 4 === 3) continue;
      const u = dom.kappa + 0.06 + band * 0.12;
      collect([shellPoint(dom, theta, u), shellPoint(dom, theta + dom.chirality * 0.012, u + 0.065)], p => {
        if (!insideArt(p) || masked(p)) return false;
        const idx = node(p);
        return owner[idx] === 0 && Rf[idx] < Wf[idx] - dom.pitch && Rf[idx] <= craterCut(dom);
      }, ribs);
    }
  }

  // Masonry: stepped slab outlines, transverse setback lines, engraved faces, slits.
  const edges: Point[][] = [], faces: Point[][] = [], slits: Point[][] = [], registration: Point[][] = [];
  for (const s of slabs) {
    // The main buttress sits on top: minor terraces disappear behind it.
    const visible = s.major ? insideArt : (p: Point) => insideArt(p) && !inPolygon(p, slabs[0].polygon);
    const stroke = (a: Point, b: Point, output: Point[][]) => {
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.6));
      collect(Array.from({ length: steps + 1 }, (_, j) => ({ x: mix(a.x, b.x, j / steps), y: mix(a.y, b.y, j / steps) })), visible, output);
    };
    const ring = [...s.polygon, s.polygon[0]];
    for (let i = 1; i < ring.length; i++) stroke(ring[i - 1], ring[i], edges);
    const section = (bay: number, along: number, cross: number): Point => {
      const l = { x: mix(s.left[bay].x, s.left[bay + 1].x, along), y: mix(s.left[bay].y, s.left[bay + 1].y, along) };
      const r = { x: mix(s.right[bay].x, s.right[bay + 1].x, along), y: mix(s.right[bay].y, s.right[bay + 1].y, along) };
      return { x: mix(l.x, r.x, cross), y: mix(l.y, r.y, cross) };
    };
    let longBay = 0;
    for (let bay = 0; bay < s.left.length - 1; bay++) {
      if (bay > 0) stroke(s.left[bay], s.right[bay], edges);
      const run = Math.hypot(s.left[bay + 1].x - s.left[bay].x, s.left[bay + 1].y - s.left[bay].y);
      if (run < 2) continue;
      const pitch = s.major ? 0.95 : 1.5;
      const count = Math.floor(run / pitch);
      for (let h = 1; h < count; h++) {
        if (h % 11 === 7 || h % 11 === 8) continue;
        const v = h / count;
        stroke(section(bay, v, 0.045), section(bay, Math.min(0.995, v + (s.major ? 5 : 2) / run), s.major ? 0.66 : 0.55), faces);
      }
      if (longBay % 3 === 1 || (!s.major && longBay === 1)) {
        const a0 = s.major ? 0.24 : 0.2, a1 = s.major ? 0.73 : 0.7;
        const slit = [section(bay, a0, 0.73), section(bay, a1, 0.73), section(bay, a1, 0.86), section(bay, a0, 0.86)];
        for (let k = 0; k < slit.length; k++) stroke(slit[k], slit[(k + 1) % slit.length], slits);
        stroke(section(bay, a0 - 0.05, 0.9), section(bay, a1 + 0.05, 0.9), registration);
      }
      longBay++;
    }
  }

  return [
    { id: 'shared-walls', pen: 'carbon', paths: byPen('walls') },
    { id: 'outer-rims', pen: 'carbon', paths: byPen('rims') },
    { id: 'crater-lips', pen: 'carbon', paths: byPen('craters') },
    { id: 'blue-lamellae', pen: 'ultramarine', paths: byPen('ultramarine') },
    { id: 'hot-inner-lip', pen: 'vermilion', paths: byPen('vermilion') },
    { id: 'violet-murmurs', pen: 'violet', paths: byPen('violet') },
    { id: 'acid-ribs', pen: 'acid', paths: ribs },
    { id: 'stepped-buttress', pen: 'carbon', paths: edges },
    { id: 'buttress-engraving', pen: 'carbon', paths: faces },
    { id: 'buttress-slits', pen: 'carbon', paths: slits },
    { id: 'registration-offsets', pen: 'vermilion', paths: registration },
    // Inspection only: the main buttress mask first, then minor terraces; crater outlines, one per chamber.
    { id: 'foam-buttress-masks', pen: 'carbon', paths: [], boundary: slabs.map(s => s.polygon), diagnostic: true },
    { id: 'foam-craters', pen: 'carbon', paths: [], boundary: craterOutlines, diagnostic: true },
  ];
}
