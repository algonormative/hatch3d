import type { Point } from '../../src/sketch/types.ts';
import type { Rect } from './page.ts';

/**
 * The outline of a region given only as an inside test: sampled on a grid of `cell` mm over `box`, traced by marching
 * squares into closed rings (the grid's outer edge counts as outside, so a region running off the box is closed along
 * it), then relaxed and simplified. For a window to cut by hand round a shape that has no analytic outline (a mesh
 * seen through a camera, a union of shapes): with `minRadius` the region is first closed and opened by a disc of about
 * that radius, so no corner, notch or spike is tighter than the knife can follow; loops smaller than `minArea` mm² are
 * dropped. With `square` the closing and opening are by a square set square to the grid instead (half its side
 * `minRadius`): a region of shapes square to the grid keeps its corners sharp while the notches, spikes and gaps
 * narrower than the square still go.
 */
export function traceMask(inside: (p: Point) => boolean, box: Rect, cell = 0.25, options: { simplify?: number; minRadius?: number; minArea?: number; square?: boolean } = {}): Point[][] {
  const nx = Math.ceil((box.x1 - box.x0) / cell) + 3, ny = Math.ceil((box.y1 - box.y0) / cell) + 3;
  const X = (i: number) => box.x0 + (i - 1) * cell, Y = (j: number) => box.y0 + (j - 1) * cell;
  let grid = new Uint8Array(nx * ny);
  const inBox = new Uint8Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const p = { x: X(i), y: Y(j) };
    if (p.x > box.x1 + 1e-9 || p.y > box.y1 + 1e-9) continue;
    inBox[j * nx + i] = 1;
    if (inside(p)) grid[j * nx + i] = 1;
  }
  // The chamfer transform overestimates distance by up to 8%: the disc is taken that much larger to keep the radius.
  // The square's distance is exact.
  const square = options.square ?? false;
  const r = (options.minRadius ?? 0) * (square ? 1 : 1.08) / cell;
  if (r > 0) {
    // Closing (grow, then shrink) fills notches and inner corners; opening (shrink, then grow) rounds spikes and outer
    // corners. Cells off the box are outside again afterwards, so a region running off the box keeps its edge there.
    // Grown cells stay inside the box, so the shrink after a grow still erodes from the box's side.
    const grow = (g: Uint8Array) => { const d = distanceTo(g, nx, ny, 1, square), out = new Uint8Array(d.length); for (let k = 0; k < d.length; k++) out[k] = d[k] <= r && inBox[k] ? 1 : 0; return out; };
    const shrink = (g: Uint8Array) => { const d = distanceTo(g, nx, ny, 0, square), out = new Uint8Array(d.length); for (let k = 0; k < d.length; k++) out[k] = d[k] > r ? 1 : 0; return out; };
    grid = shrink(grow(grid));
    grid = grow(shrink(grid));
    for (let k = 0; k < grid.length; k++) if (!inBox[k]) grid[k] = 0;
  }
  const g = (i: number, j: number) => grid[j * nx + i];
  // Edge midpoints keyed by their grid edge; each cell links two (or four, at a saddle) of them.
  const key = (i: number, j: number, horizontal: boolean) => (j * nx + i) * 2 + (horizontal ? 0 : 1);
  const mid = (k: number): Point => {
    const h = k % 2 === 0, c = Math.floor(k / 2), i = c % nx, j = Math.floor(c / nx);
    return h ? { x: X(i) + cell / 2, y: Y(j) } : { x: X(i), y: Y(j) + cell / 2 };
  };
  const next = new Map<number, number>();
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = g(i, j), b = g(i + 1, j), c = g(i + 1, j + 1), d = g(i, j + 1);
    const code = a | (b << 1) | (c << 2) | (d << 3);
    if (code === 0 || code === 15) continue;
    const top = key(i, j, true), right = key(i + 1, j, false), bottom = key(i, j + 1, true), left = key(i, j, false);
    const link = (from: number, to: number) => next.set(from, to);
    switch (code) {
      case 1: link(top, left); break;
      case 2: link(right, top); break;
      case 3: link(right, left); break;
      case 4: link(bottom, right); break;
      case 5: link(top, left); link(bottom, right); break;
      case 6: link(bottom, top); break;
      case 7: link(bottom, left); break;
      case 8: link(left, bottom); break;
      case 9: link(top, bottom); break;
      case 10: link(left, top); link(right, bottom); break;
      case 11: link(right, bottom); break;
      case 12: link(left, right); break;
      case 13: link(top, right); break;
      case 14: link(left, top); break;
    }
  }
  const rings: Point[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Point[] = [];
    let k: number | undefined = start;
    while (k !== undefined && !seen.has(k)) { seen.add(k); ring.push(mid(k)); k = next.get(k); }
    if (ring.length >= 4) rings.push(ring);
  }
  const minArea = options.minArea ?? 4;
  return rings.filter(ring => Math.abs(area(ring)) >= minArea).map(ring => simplifyRing(relax(ring, 3), options.simplify ?? cell * 0.4));
}

/**
 * Distance in cells from every cell to the nearest cell whose value is `to` (a 3-4 chamfer transform, within about 8%
 * of the true distance), or with `square` the chessboard distance (the larger of the two axes').
 */
function distanceTo(grid: Uint8Array, nx: number, ny: number, to: number, square = false): Float32Array {
  const d = new Float32Array(nx * ny);
  for (let i = 0; i < d.length; i++) d[i] = grid[i] === to ? 0 : 1e9;
  const A = 1, B = square ? 1 : Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + A);
    if (j > 0) {
      v = Math.min(v, d[k - nx] + A);
      if (i > 0) v = Math.min(v, d[k - nx - 1] + B);
      if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + B);
    }
    d[k] = v;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    let v = d[k];
    if (i < nx - 1) v = Math.min(v, d[k + 1] + A);
    if (j < ny - 1) {
      v = Math.min(v, d[k + nx] + A);
      if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + B);
      if (i > 0) v = Math.min(v, d[k + nx - 1] + B);
    }
    d[k] = v;
  }
  return d;
}

/** The ring with each point moved halfway to its neighbours' mean, `times` over: it irons out the grid's staircase. */
export function relax(ring: Point[], times: number): Point[] {
  let r = ring;
  for (let t = 0; t < times; t++) r = r.map((p, i) => {
    const a = r[(i + r.length - 1) % r.length], b = r[(i + 1) % r.length];
    return { x: p.x / 2 + (a.x + b.x) / 4, y: p.y / 2 + (a.y + b.y) / 4 };
  });
  return r;
}

/** Signed area (positive clockwise on the page, y down). */
export function area(ring: Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

/** Douglas–Peucker on a closed ring. */
export function simplifyRing(ring: Point[], eps: number): Point[] {
  if (ring.length < 8) return ring;
  // Split at the point farthest from the first and simplify each half as an open line.
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y); if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), eps), b = dp([...ring.slice(far), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(line: Point[], eps: number): Point[] {
  if (line.length < 3) return line;
  const a = line[0], b = line[line.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  let idx = 0, best = -1;
  for (let i = 1; i < line.length - 1; i++) {
    const d = Math.abs((line[i].x - a.x) * dy - (line[i].y - a.y) * dx) / l;
    if (d > best) { best = d; idx = i; }
  }
  if (best <= eps) return [a, b];
  return [...dp(line.slice(0, idx + 1), eps).slice(0, -1), ...dp(line.slice(idx), eps)];
}

/**
 * The ring with its rounded corners made sharp again, for windows cut with straight strokes of the knife: where two
 * straight edges at least `edge` mm long meet through a run of shorter ones no longer than `run` mm in all (a corner
 * that `traceMask`'s radius or its relaxing rounded), turning by at least `turn` degrees (a gentler corner is rounded by
 * less than a tenth of a millimetre at a knife's radius), the run is replaced by the point where the two edges' lines
 * cross, or (when that point lies more than `reach` mm from the run, at a corner too acute) by the run's two ends, a
 * straight bevel. Where the edges turn back on each other (the end of a narrow strip, or of a narrow notch, rounded
 * through), the run is squared off across its farthest point instead; where they run on parallel but stepped (a step
 * rounded into an S), the step is put back square across the middle of the run. Each stands in only where the run keeps within
 * `reach` of it, so a feature between two edges (a bump, a notch) is kept, as are curves (runs of short edges with no
 * long edge either side); and only where `keep`, given the new line through the corner and the run it replaces,
 * allows, or failing that a straight bevel across the run where `keep` allows that.
 */
export function sharpenCorners(ring: Point[], options: { edge?: number; run?: number; reach?: number; turn?: number; keep?: (line: Point[], run: Point[]) => boolean } = {}): Point[] {
  const { edge = 2, run = 6, reach = 2, turn = 40 } = options;
  const n = ring.length;
  if (n < 4) return ring;
  const at = (i: number) => ring[((i % n) + n) % n];
  const len = (i: number) => Math.hypot(at(i + 1).x - at(i).x, at(i + 1).y - at(i).y);
  const long: number[] = [];
  for (let i = 0; i < n; i++) if (len(i) >= edge) long.push(i);
  if (long.length < 2) return ring;
  const cosTurn = Math.cos((turn * Math.PI) / 180), cosBack = Math.cos((150 * Math.PI) / 180), cosOn = Math.cos((5 * Math.PI) / 180);
  // Each replaced run: its vertices (between the two long edges) and what stands in for them.
  const removed = new Set<number>(), placed = new Map<number, Point[]>();
  for (let k = 0; k < long.length; k++) {
    const a = long[k], b = long[(k + 1) % long.length], gap = (b - a + n) % n;
    if (gap < 2) continue;
    let total = 0;
    for (let i = a + 1; i < a + gap; i++) total += len(i);
    if (total > run) continue;
    const p0 = at(a), p1 = at(a + 1), q0 = at(b), q1 = at(b + 1);
    const l1 = len(a), l2 = len(b);
    const e1 = { x: (p1.x - p0.x) / l1, y: (p1.y - p0.y) / l1 }, e2 = { x: (q1.x - q0.x) / l2, y: (q1.y - q0.y) / l2 };
    const dot = e1.x * e2.x + e1.y * e2.y;
    const runPoints = Array.from({ length: gap }, (_, i) => at(a + 1 + i));
    const along = runPoints.map(p => (p.x - p0.x) * e1.x + (p.y - p0.y) * e1.y);
    // A point on the second edge's line at `t` along the first.
    const onSecond = (t: number): Point => { const s2 = (t - ((q0.x - p0.x) * e1.x + (q0.y - p0.y) * e1.y)) / dot; return { x: q0.x + e2.x * s2, y: q0.y + e2.y * s2 }; };
    const step = Math.abs((q0.x - p0.x) * e1.y - (q0.y - p0.y) * e1.x);
    let stand: Point[];
    if (dot > cosOn && step >= 0.3) {
      // A step: square across the middle of the run.
      const t = (Math.min(...along) + Math.max(...along)) / 2;
      stand = [{ x: p0.x + e1.x * t, y: p0.y + e1.y * t }, onSecond(t)];
    } else if (dot > cosTurn) continue;
    else if (dot < cosBack) {
      // Squared off: both edges carried on to the run's farthest reach along the first.
      const t = Math.max(...along);
      stand = [{ x: p0.x + e1.x * t, y: p0.y + e1.y * t }, onSecond(t)];
    } else {
      const cross = e1.x * e2.y - e1.y * e2.x;
      const t = ((q0.x - p0.x) * e2.y - (q0.y - p0.y) * e2.x) / cross;
      const x = { x: p0.x + e1.x * t, y: p0.y + e1.y * t };
      const near = Math.min(...runPoints.map(p => Math.hypot(p.x - x.x, p.y - x.y)));
      stand = Number.isFinite(near) && near <= reach ? [x] : [runPoints[0], runPoints[runPoints.length - 1]];
    }
    const line = [p1, ...stand, q0];
    if (stand.some(q => !Number.isFinite(q.x) || !Number.isFinite(q.y)) || runPoints.some(p => distanceToLine(p, line) > reach)) continue;
    if (options.keep && !options.keep(line, runPoints)) {
      if (!options.keep([p1, q0], runPoints)) continue;
      stand = [p1, q0];
    }
    for (let i = 1; i <= gap; i++) removed.add((a + i) % n);
    placed.set((a + 1) % n, stand);
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const stand = placed.get(i);
    if (stand) out.push(...stand);
    else if (!removed.has(i)) out.push(ring[i]);
  }
  return out;
}

/** The distance from `p` to the open polyline `line`. */
function distanceToLine(p: Point, line: Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
