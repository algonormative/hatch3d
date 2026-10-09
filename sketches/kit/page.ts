import * as THREE from 'three';
import type { Point } from '../../src/sketch/types.ts';
import { PAGE, S } from './format.ts';

/** Page-space path helpers shared by the Breach sketches. */

export interface Rect { x0: number; x1: number; y0: number; y1: number }

/**
 * Liang–Barsky clip of a polyline to a rectangle: the runs inside it, each of two or more points.
 * (Not plot-core's Cohen–Sutherland `clipPolylineToRect`: that one rounds differently and breaks runs differently.)
 */
export function clipToRect(points: Point[], box: Rect): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    let enter = 0, exit = 1;
    for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
      if (p === 0) { if (q < 0) { enter = 1; exit = 0; break; } }
      else { const t = q / p; if (p < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t); }
    }
    if (enter > exit) { flush(); continue; }
    const at = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
    const start = at(enter), end = at(exit);
    if (run.length && (Math.hypot(run[run.length - 1].x - start.x, run[run.length - 1].y - start.y) > 0.001 || enter > 0)) flush();
    if (!run.length) run.push(start);
    run.push(end);
    if (exit < 1) flush();
  }
  flush();
  return runs;
}

/** Drop interior points that neither turn nor stretch the line: the plotted-path reducer. */
export function simplify(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const area = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (span > 1.4 || area > 0.15) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * `simplify` at a card's scale: a point is dropped where it neither turns nor stretches the line by the reducer's
 * tabloid thresholds scaled with the card (its 1.4 mm span by `scale`, its 0.15 mm² turn by `scale²`). Left at
 * tabloid's, that stride is a large share of a small card's curves, and turns rims, rings and figures into polygons.
 * `scale` defaults to the format's `S`, and at 1 (tabloid) this is `simplify` itself. Hand it to `PartBuckets` as its
 * `reduce` option, off tabloid or not, and every ordinary path a card adds is reduced this way.
 */
export function reduceAtScale(points: Point[], scale = S): Point[] {
  if (scale === 1) return simplify(points);
  if (points.length < 3) return points;
  const span = 1.4 * scale, turn = 0.15 * scale * scale;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) > span || Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > turn) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** The distance from `p` to the segment `a`-`b`. */
export const segDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

/**
 * A path less the points that lie on the line between their neighbours, within `eps` millimetres (Ramer-Douglas-Peucker):
 * the gentlest reducer, which keeps every curve's shape at any scale. Hand it to `PartBuckets` as `reduce` for a card
 * whose curves must stay curves (a cable, a ring).
 */
export function straightened(path: Point[], eps = 0.02): Point[] {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const spans: [number, number][] = [[0, path.length - 1]];
  while (spans.length) {
    const [i, j] = spans.pop()!;
    let worst = eps, at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(path[k], path[i], path[j]);
      if (d > worst) { worst = d; at = k; }
    }
    if (at >= 0) { keep[at] = 1; spans.push([i, at], [at, j]); }
  }
  return path.filter((_, k) => keep[k]);
}

/** Total length of a polyline. */
export function pathLength(path: Point[]): number {
  let length = 0;
  for (let j = 1; j < path.length; j++) length += Math.hypot(path[j].x - path[j - 1].x, path[j].y - path[j - 1].y);
  return length;
}

/**
 * Paper kept clear round what is already drawn, for marks drawn after it that must give way: a page-space index of the
 * drawn marks' points, sampled every `step` millimetres, and a test for whether a point lies within `gap` of any of
 * them. A card drawing near to far registers each mark as it keeps it; a background mark then keeps only the stretches
 * of itself that clear everything in front by `gap` (the format's `MIN_SPACING`, so no two strokes run closer than the
 * pens hold apart). A mark never gives way to itself: register it after testing it.
 */
export class Clearance {
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly gap: number, private readonly step = 0.1) {}

  private key(x: number, y: number): string { return `${Math.floor(x / this.gap)},${Math.floor(y / this.gap)}`; }

  /** Whether `p` lies within `gap` of a registered mark. */
  near(p: Point): boolean {
    const ix = Math.floor(p.x / this.gap), iy = Math.floor(p.y / this.gap), g2 = this.gap * this.gap;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.cells.get(`${ix + i},${iy + j}`);
      if (cell) for (let k = 0; k < cell.length; k += 2) if ((cell[k] - p.x) ** 2 + (cell[k + 1] - p.y) ** 2 < g2) return true;
    }
    return false;
  }

  /** Register a drawn mark. */
  add(path: Point[]): void {
    const put = (x: number, y: number) => {
      const key = this.key(x, y);
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = []);
      cell.push(x, y);
    };
    if (path.length) put(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / this.step));
      for (let k = 1; k <= steps; k++) put(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps);
    }
  }
}

/** Split a page path into short steps and keep the ones a test allows, carrying arclength. */
export function keepAlong(path: Point[], keep: (p: Point, at: number) => boolean, step = 0.15): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  let s = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (keep({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, s + len * (t0 + t1) / 2)) {
        if (!run.length) run.push(p0);
        run.push(p1);
      } else flush();
    }
    s += len;
  }
  flush();
  return out;
}

/** Resample so the lens can bend straight segments. */
export function densify(path: Point[], step = 0.8): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}


/**
 * A page bitmap of where some meshes cover the sheet, dilated by `halo` millimetres: the shared
 * test for marks that must stand in front of, or leave room round, 3D geometry. The page defaults to the format's.
 */
export function meshCoverage(geometries: THREE.BufferGeometry[], view: THREE.Camera, page: { width: number; height: number } = PAGE,
  halo = 0, res = 3): (p: Point) => boolean {
  const gw = Math.ceil(page.width * res), gh = Math.ceil(page.height * res);
  let grid = new Uint8Array(gw * gh);
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position'), index = g.getIndex();
    const tri = index ? index.count / 3 : pos.count / 3;
    const at = (k: number) => { v.fromBufferAttribute(pos, k).project(view); return { x: (v.x * 0.5 + 0.5) * gw, y: (-v.y * 0.5 + 0.5) * gh, z: v.z }; };
    for (let t = 0; t < tri; t++) {
      const [a, b, c] = [0, 1, 2].map(j => at(index ? index.getX(t * 3 + j) : t * 3 + j));
      if (a.z > 1 || b.z > 1 || c.z > 1) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(gw - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(gh - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) grid[y * gw + x] = 1;
      }
    }
  }
  const r = Math.round(halo * res);
  if (r > 0) {
    // Separable square dilation: rows, then columns.
    const rows = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      let last = -1e9;
      for (let x = 0; x < gw; x++) { if (grid[y * gw + x]) last = x; if (x - last <= r) rows[y * gw + x] = 1; }
      last = 1e9;
      for (let x = gw - 1; x >= 0; x--) { if (grid[y * gw + x]) last = x; if (last - x <= r) rows[y * gw + x] = 1; }
    }
    const out = new Uint8Array(gw * gh);
    for (let x = 0; x < gw; x++) {
      let last = -1e9;
      for (let y = 0; y < gh; y++) { if (rows[y * gw + x]) last = y; if (y - last <= r) out[y * gw + x] = 1; }
      last = 1e9;
      for (let y = gh - 1; y >= 0; y--) { if (rows[y * gw + x]) last = y; if (last - y <= r) out[y * gw + x] = 1; }
    }
    grid = out;
  }
  return p => {
    const x = Math.floor(p.x * res), y = Math.floor(p.y * res);
    return x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x] === 1;
  };
}
