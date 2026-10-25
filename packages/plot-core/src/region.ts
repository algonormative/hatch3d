import type { Point } from './types.js';

/**
 * Regions of the page as boolean trees, and exact clipping of polylines to them. Dependency-free, pure and
 * deterministic: millimetres in, millimetres out, no randomness, no densifying.
 *
 * A region is one of:
 *   - `all`: everything;
 *   - `rings`: the even-odd area of a set of rings (winding is irrelevant; a ring is closed implicitly);
 *   - `near`: the open band within `distance` of any ring EDGE (rings closed implicitly). It is the union of
 *     the capsules around the edges, so it is not the area inside a ring;
 *   - `not`, `and`, `or`: the boolean tree. `and([])` is everything and `or([])` is nothing.
 */
export type Region =
  | { all: true }
  | { rings: Point[][] }
  | { near: Point[][]; distance: number }
  | { not: Region } | { and: Region[] } | { or: Region[] };

const EPS = 1e-9;
/** Breakpoints closer than this are one breakpoint; spans shorter than this carry no length. */
const T_EPS = 1e-12;

// ── Points against rings ─────────────────────────────────────────────

/** Squared distance from p to segment ab. */
function segDist2(p: Point, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p.x - (ax + dx * t), ey = p.y - (ay + dy * t);
  return ex * ex + ey * ey;
}

/** Minimum distance from p to any edge of any ring (rings closed implicitly); Infinity when there are none. */
export function distanceToRings(p: Point, rings: Point[][]): number {
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n === 0) continue;
    if (n === 1) { best = Math.min(best, segDist2(p, ring[0].x, ring[0].y, ring[0].x, ring[0].y)); continue; }
    for (let i = 0, j = n - 1; i < n; j = i++) best = Math.min(best, segDist2(p, ring[j].x, ring[j].y, ring[i].x, ring[i].y));
  }
  return Math.sqrt(best);
}

/** True when p is strictly closer than `distance` to some edge; stops at the first one. */
function nearAny(p: Point, rings: Point[][], distance: number): boolean {
  if (!(distance > 0)) return false;
  const limit = distance * distance;
  for (const ring of rings) {
    const n = ring.length;
    if (n === 1 && segDist2(p, ring[0].x, ring[0].y, ring[0].x, ring[0].y) < limit) return true;
    if (n < 2) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) if (segDist2(p, ring[j].x, ring[j].y, ring[i].x, ring[i].y) < limit) return true;
  }
  return false;
}

/** Even-odd containment: crossings of a ray towards +x, counted over every ring edge. */
function insideRings(p: Point, rings: Point[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[j], b = ring[i];
      if ((b.y > p.y) !== (a.y > p.y) && p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    }
  }
  return inside;
}

export function inRegion(p: Point, region: Region): boolean {
  if ('all' in region) return true;
  if ('rings' in region) return insideRings(p, region.rings);
  if ('near' in region) return nearAny(p, region.near, region.distance);
  if ('not' in region) return !inRegion(p, region.not);
  if ('and' in region) { for (const r of region.and) if (!inRegion(p, r)) return false; return true; }
  for (const r of region.or) if (inRegion(p, r)) return true;
  return false;
}

// ── Ring geometry ────────────────────────────────────────────────────

/** Shoelace area: positive when the ring runs counter-clockwise in a y-up frame, negative otherwise. */
export function signedArea(ring: Point[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  return sum / 2;
}

/** The ring without its closing repeat or consecutive duplicate points. */
function cleaned(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(p.x - last.x) > EPS || Math.abs(p.y - last.y) > EPS) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) <= EPS && Math.abs(out[0].y - out[out.length - 1].y) <= EPS) out.pop();
  return out;
}

/**
 * The ring moved `d` along its outward normal: `d > 0` grows the enclosed area, `d < 0` shrinks it, whichever way
 * the ring winds. Corners are mitred; where the miter would be longer than `miterLimit × |d|` (sharp convex
 * corners of the offset) the join is bevelled instead. Where the offset edges overlap (inside corners) the
 * intersection is always used. The result is NOT cleaned of self-intersections: a feature smaller than `|d|`
 * folds over, and `ringsSimple` is how a caller finds out. Returned open (no closing repeat).
 */
export function offsetRing(ring: Point[], d: number, miterLimit = 4): Point[] {
  const pts = cleaned(ring);
  const n = pts.length;
  if (n < 3 || d === 0) return pts;
  const orient = signedArea(pts) >= 0 ? 1 : -1;
  // Outward unit normal of edge i (from pts[i] to pts[i+1]).
  const normals = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
    return { x: (orient * dy) / len, y: (-orient * dx) / len };
  });
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
    const n0 = normals[(i + n - 1) % n], n1 = normals[i];
    const turn = orient * ((p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x)); // > 0 at a convex corner
    const c = n0.x * n1.x + n0.y * n1.y; // cosine of the turning angle
    const gap = turn > 0 === d > 0 && Math.abs(turn) > 1e-12; // the offset edges pull apart at this corner
    if (1 + c < 1e-9) { // a spike folding straight back: no usable miter
      out.push({ x: p.x + d * n0.x, y: p.y + d * n0.y }, { x: p.x + d * n1.x, y: p.y + d * n1.y });
      continue;
    }
    const miter = Math.sqrt(2 / (1 + c)); // miter length as a multiple of |d|
    if (gap && miter > miterLimit) {
      out.push({ x: p.x + d * n0.x, y: p.y + d * n0.y }, { x: p.x + d * n1.x, y: p.y + d * n1.y });
      continue;
    }
    const k = d / (1 + c);
    out.push({ x: p.x + k * (n0.x + n1.x), y: p.y + k * (n0.y + n1.y) });
  }
  return out;
}

// ── Simplicity ───────────────────────────────────────────────────────

const orient2 = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Orientation with a tolerance in millimetres of distance from the line ab: -1, 0 or 1. */
function side(a: Point, b: Point, c: Point): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const v = len > 0 ? orient2(a, b, c) / len : 0;
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
}
function onSegment(a: Point, b: Point, c: Point): boolean {
  return c.x >= Math.min(a.x, b.x) - EPS && c.x <= Math.max(a.x, b.x) + EPS && c.y >= Math.min(a.y, b.y) - EPS && c.y <= Math.max(a.y, b.y) + EPS;
}
/** Do closed segments ab and cd share any point (touching counts)? */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = side(a, b, c), o2 = side(a, b, d), o3 = side(c, d, a), o4 = side(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/**
 * No ring self-intersects and no two rings cross: every pair of edges that are not neighbours in the same ring
 * is disjoint (touching counts as meeting), and neighbours share only their common vertex. One ring may lie
 * wholly inside another (an outer ring with a hole). Rings with fewer than three distinct points are not simple.
 */
export function ringsSimple(rings: Point[][]): boolean {
  const polys = rings.map(cleaned);
  if (polys.some((p) => p.length < 3)) return false;
  interface Edge { a: Point; b: Point; ring: number; index: number; x0: number; x1: number; y0: number; y1: number }
  const edges: Edge[] = [];
  polys.forEach((poly, ring) => poly.forEach((a, index) => {
    const b = poly[(index + 1) % poly.length];
    edges.push({ a, b, ring, index, x0: Math.min(a.x, b.x) - EPS, x1: Math.max(a.x, b.x) + EPS, y0: Math.min(a.y, b.y) - EPS, y1: Math.max(a.y, b.y) + EPS });
  }));
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (f.x0 > e.x1 || f.x1 < e.x0 || f.y0 > e.y1 || f.y1 < e.y0) continue;
      if (e.ring === f.ring) {
        const n = polys[e.ring].length;
        const gap = Math.min(f.index - e.index, n - (f.index - e.index));
        if (gap === 1) { // neighbours: they may share only the common vertex, so no folding straight back
          const shared = f.index === (e.index + 1) % n ? e.b : e.a;
          const eFar = shared === e.b ? e.a : e.b, fFar = shared === f.b ? f.a : f.b;
          if (side(shared, eFar, fFar) === 0 && (eFar.x - shared.x) * (fFar.x - shared.x) + (eFar.y - shared.y) * (fFar.y - shared.y) > 0) return false;
          continue;
        }
      }
      if (segmentsMeet(e.a, e.b, f.a, f.b)) return false;
    }
  }
  return true;
}

// ── Exact clipping ───────────────────────────────────────────────────

interface Edge { ax: number; ay: number; bx: number; by: number; x0: number; x1: number; y0: number; y1: number }
interface Leaf { near: boolean; distance: number; edges: Edge[]; x0: number; x1: number; y0: number; y1: number; grid?: EdgeGrid }

/**
 * A uniform grid over a leaf's edges (each in every cell its box overlaps), so a query visits only the edges whose
 * boxes can meet a given box. Every caller applies the same per-edge test it would to all of them, so the answers are
 * exactly the unindexed ones: the grid only skips edges that cannot pass.
 */
class EdgeGrid {
  private cells: number[][];
  private nx: number;
  private ny: number;
  private size: number;
  private stamp: Uint32Array;
  private query = 0;
  private edges: Edge[];
  private x0: number;
  private y0: number;
  constructor(edges: Edge[], x0: number, y0: number, x1: number, y1: number) {
    this.edges = edges; this.x0 = x0; this.y0 = y0;
    this.size = Math.max((x1 - x0) / 96, (y1 - y0) / 96, 1e-6);
    this.nx = Math.max(1, Math.ceil((x1 - x0) / this.size) + 1);
    this.ny = Math.max(1, Math.ceil((y1 - y0) / this.size) + 1);
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
    this.stamp = new Uint32Array(edges.length);
    edges.forEach((e, i) => this.visitCells(e.x0, e.y0, e.x1, e.y1, c => this.cells[c].push(i)));
  }
  private visitCells(x0: number, y0: number, x1: number, y1: number, f: (cell: number) => void) {
    const clampX = (v: number) => Math.min(this.nx - 1, Math.max(0, Math.floor((v - this.x0) / this.size)));
    const clampY = (v: number) => Math.min(this.ny - 1, Math.max(0, Math.floor((v - this.y0) / this.size)));
    const i0 = clampX(x0), i1 = clampX(x1), j0 = clampY(y0), j1 = clampY(y1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * this.nx + i);
  }
  /** Each edge whose cells overlap the box, once. */
  forEach(x0: number, y0: number, x1: number, y1: number, f: (e: Edge) => void) {
    if (++this.query === 0xffffffff) { this.stamp.fill(0); this.query = 1; }
    const q = this.query;
    this.visitCells(x0, y0, x1, y1, c => { for (const i of this.cells[c]) if (this.stamp[i] !== q) { this.stamp[i] = q; f(this.edges[i]); } });
  }
}

/** Index a leaf once it has enough edges to repay it. */
function indexed(leaf: Leaf): Leaf {
  if (leaf.edges.length >= 32) leaf.grid = new EdgeGrid(leaf.edges, leaf.x0, leaf.y0, leaf.x1, leaf.y1);
  return leaf;
}

/**
 * The edges of the rings that are at least `minPoints` long, each grown by `grow`. A one-point ring has one degenerate
 * edge (P, P), which a `near` region reads as a disc, matching `nearAny`.
 */
function edgesOf(rings: Point[][], grow: number, minPoints: number): { edges: Edge[]; x0: number; x1: number; y0: number; y1: number } {
  const edges: Edge[] = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < minPoints) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[j], b = ring[i];
      const edge = { ax: a.x, ay: a.y, bx: b.x, by: b.y, x0: Math.min(a.x, b.x) - grow, x1: Math.max(a.x, b.x) + grow, y0: Math.min(a.y, b.y) - grow, y1: Math.max(a.y, b.y) + grow };
      edges.push(edge);
      x0 = Math.min(x0, edge.x0); x1 = Math.max(x1, edge.x1); y0 = Math.min(y0, edge.y0); y1 = Math.max(y1, edge.y1);
    }
  }
  return { edges, x0, x1, y0, y1 };
}

function leavesOf(region: Region, out: Leaf[] = []): Leaf[] {
  if ('rings' in region) out.push({ near: false, distance: 0, ...edgesOf(region.rings, 0, 2) });
  else if ('near' in region) { if (region.distance > 0) out.push({ near: true, distance: region.distance, ...edgesOf(region.near, region.distance, 1) }); }
  else if ('not' in region) leavesOf(region.not, out);
  else if ('and' in region) for (const r of region.and) leavesOf(r, out);
  else if ('or' in region) for (const r of region.or) leavesOf(r, out);
  return out;
}

/** t along ab where it crosses the edge, when it does inside the edge (ends included, within tolerance). */
function crossing(ax: number, ay: number, dx: number, dy: number, e: Edge): number | undefined {
  const ex = e.bx - e.ax, ey = e.by - e.ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return undefined; // parallel or degenerate; the neighbouring edges bound a collinear overlap
  const cx = e.ax - ax, cy = e.ay - ay;
  const t = (cx * ey - cy * ex) / denom;
  const u = (cx * dy - cy * dx) / denom;
  return u >= -EPS && u <= 1 + EPS ? t : undefined;
}

/** Roots of |A + tD - P|² = r² as an open interval, when the line enters the disc. */
function discInterval(ax: number, ay: number, dx: number, dy: number, px: number, py: number, r: number): [number, number] | undefined {
  const a = dx * dx + dy * dy;
  if (a <= 0) return undefined;
  const fx = ax - px, fy = ay - py;
  const b = 2 * (dx * fx + dy * fy), c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return undefined;
  const root = Math.sqrt(disc);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

/** Parametric half-plane clip of the line against lo <= alpha + beta t <= hi. */
function slab(lo: number, hi: number, alpha: number, beta: number, range: [number, number]): boolean {
  if (Math.abs(beta) < 1e-15) return alpha >= lo && alpha <= hi;
  let t0 = (lo - alpha) / beta, t1 = (hi - alpha) / beta;
  if (t0 > t1) [t0, t1] = [t1, t0];
  if (t0 > range[0]) range[0] = t0;
  if (t1 < range[1]) range[1] = t1;
  return range[0] < range[1];
}

/**
 * The line A + tD meets the capsule {X : dist(X, edge) < r} in one interval (the capsule is convex). It is the hull
 * of its hits on the disc at each end of the edge and on the slab rectangle edge ± r·n.
 */
function capsuleInterval(ax: number, ay: number, dx: number, dy: number, e: Edge, r: number): [number, number] | undefined {
  let lo = Infinity, hi = -Infinity;
  const take = (iv: [number, number] | undefined) => { if (iv) { lo = Math.min(lo, iv[0]); hi = Math.max(hi, iv[1]); } };
  take(discInterval(ax, ay, dx, dy, e.ax, e.ay, r));
  take(discInterval(ax, ay, dx, dy, e.bx, e.by, r));
  const len = Math.hypot(e.bx - e.ax, e.by - e.ay);
  if (len > 0) {
    const ux = (e.bx - e.ax) / len, uy = (e.by - e.ay) / len;
    const range: [number, number] = [-Infinity, Infinity];
    const s0 = (ax - e.ax) * ux + (ay - e.ay) * uy, s1 = dx * ux + dy * uy;
    const w0 = -(ax - e.ax) * uy + (ay - e.ay) * ux, w1 = -dx * uy + dy * ux;
    if (slab(0, len, s0, s1, range) && slab(-r, r, w0, w1, range)) take([range[0], range[1]]);
  }
  return lo < hi ? [lo, hi] : undefined;
}

/** Every t in (0, 1) where the region's membership along ab can change, sorted and deduplicated. */
function breakpoints(a: Point, b: Point, leaves: Leaf[]): number[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const sx0 = Math.min(a.x, b.x), sx1 = Math.max(a.x, b.x), sy0 = Math.min(a.y, b.y), sy1 = Math.max(a.y, b.y);
  const ts: number[] = [];
  const add = (t: number) => { if (t > 0 && t < 1) ts.push(t); };
  for (const leaf of leaves) {
    if (leaf.x0 > sx1 || leaf.x1 < sx0 || leaf.y0 > sy1 || leaf.y1 < sy0) continue;
    const visit = (e: Edge) => {
      if (e.x0 > sx1 || e.x1 < sx0 || e.y0 > sy1 || e.y1 < sy0) return;
      if (leaf.near) {
        const iv = capsuleInterval(a.x, a.y, dx, dy, e, leaf.distance);
        if (iv) { add(iv[0]); add(iv[1]); }
      } else {
        const t = crossing(a.x, a.y, dx, dy, e);
        if (t !== undefined) add(t);
      }
    };
    if (leaf.grid) leaf.grid.forEach(sx0, sy0, sx1, sy1, visit);
    else for (const e of leaf.edges) visit(e);
  }
  ts.sort((p, q) => p - q);
  const out: number[] = [];
  for (const t of ts) if (out.length === 0 || t - out[out.length - 1] > T_EPS) out.push(t);
  return out;
}

const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/**
 * `inRegion` for one region, compiled once for many points: each `rings` and `near` leaf with enough edges answers
 * from its edge grid (the even-odd count from the edges whose boxes reach the point's height across to its right, the
 * band from the edges whose grown boxes hold the point), with the same predicates as `insideRings` and `nearAny`, so
 * it agrees with `inRegion` everywhere.
 */
function compileRegion(region: Region): (p: Point) => boolean {
  if ('all' in region) return () => true;
  if ('rings' in region) {
    const leaf = indexed({ near: false, distance: 0, ...edgesOf(region.rings.filter(r => r.length >= 3), 0, 3) });
    if (!leaf.grid) return p => insideRings(p, region.rings);
    const grid = leaf.grid;
    return p => {
      let inside = false;
      grid.forEach(p.x, p.y, leaf.x1, p.y, e => {
        if ((e.by > p.y) !== (e.ay > p.y) && p.x < ((e.ax - e.bx) * (p.y - e.by)) / (e.ay - e.by) + e.bx) inside = !inside;
      });
      return inside;
    };
  }
  if ('near' in region) {
    const distance = region.distance;
    if (!(distance > 0)) return () => false;
    const leaf = indexed({ near: true, distance, ...edgesOf(region.near, distance, 1) });
    if (!leaf.grid) return p => nearAny(p, region.near, distance);
    const grid = leaf.grid, limit = distance * distance;
    return p => {
      let hit = false;
      grid.forEach(p.x, p.y, p.x, p.y, e => { if (!hit && p.x >= e.x0 && p.x <= e.x1 && p.y >= e.y0 && p.y <= e.y1 && segDist2(p, e.ax, e.ay, e.bx, e.by) < limit) hit = true; });
      return hit;
    };
  }
  if ('not' in region) { const f = compileRegion(region.not); return p => !f(p); }
  if ('and' in region) { const fs = region.and.map(compileRegion); return p => fs.every(f => f(p)); }
  const fs = region.or.map(compileRegion);
  return p => fs.some(f => f(p));
}

/**
 * Clip polylines to a region, exactly. Each segment is cut at every breakpoint where any leaf of the region could
 * change its answer (ring crossings; the two ends of the segment's passage through each `near` capsule), the
 * breakpoints are sorted and deduplicated, and the midpoint of each span decides it. Between breakpoints every
 * leaf is constant, so the midpoint test is exact for any boolean tree. Consecutive kept spans weld into one
 * polyline; a gap starts a new one; outputs with fewer than two points are dropped. No densifying, no bisection.
 */
export function clipToRegion(paths: Point[][], region: Region): Point[][] {
  const leaves = leavesOf(region).map(indexed);
  const contains = compileRegion(region);
  const out: Point[][] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    let current: Point[] = [];
    const flush = () => { if (current.length >= 2) out.push(current); current = []; };
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (samePoint(a, b)) continue;
      const bounds = [0, ...breakpoints(a, b, leaves), 1];
      // Keep runs of consecutive kept spans as one interval, so breakpoints that change nothing add no vertex.
      let start = -1;
      const emit = (t0: number, t1: number) => {
        const p0 = t0 === 0 ? a : { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
        const p1 = t1 === 1 ? b : { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
        if (current.length === 0) current.push({ x: p0.x, y: p0.y });
        else if (!samePoint(current[current.length - 1], p0)) { flush(); current.push({ x: p0.x, y: p0.y }); }
        current.push({ x: p1.x, y: p1.y });
      };
      for (let k = 0; k < bounds.length - 1; k++) {
        const t0 = bounds[k], t1 = bounds[k + 1];
        if (t1 - t0 < T_EPS) continue;
        const keep = contains({ x: a.x + (b.x - a.x) * ((t0 + t1) / 2), y: a.y + (b.y - a.y) * ((t0 + t1) / 2) });
        if (keep) { if (start < 0) start = t0; }
        else if (start >= 0) { emit(start, t0); start = -1; }
      }
      if (start >= 0) emit(start, 1);
    }
    flush();
  }
  return out;
}
