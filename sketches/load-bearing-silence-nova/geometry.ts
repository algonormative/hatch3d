import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { clipPolylineToRect } from '../../src/utils/clip.ts';

/**
 * Load Bearing Silence / Nova: three layers only.
 *  1. the burst — an unmarked glare disc with long cyan rays reaching for the frame;
 *  2. the panels — one torn grid of large hatched plates, frozen mid-flight after a radial blast;
 *  3. the sunbeam — rays stop at each panel and stay dark for a seeded distance beyond it.
 * Everything is authored in page millimetres (TALL_ART is the identity mapping in abstract mode).
 */

type V3 = [number, number, number];
type M3 = number[]; // row-major 3 × 3
type Rect = { xMin: number; xMax: number; yMin: number; yMax: number };

/** Usable content area of the abstract poster (page mm), and the slightly inset ray envelope. */
export const ART: Rect = { xMin: 18, xMax: 261.4, yMin: 18, yMax: 413.8 };
const RAY_FRAME: Rect = { xMin: 21, xMax: 258.4, yMin: 21, yMax: 410.8 };
const FOCUS: Point = { x: (ART.xMin + ART.xMax) / 2, y: (ART.yMin + ART.yMax) / 2 };
const FOCAL = 760; // weak perspective: panels flung toward the viewer read slightly larger
const MIN_SPACING = 0.5;
const TEAR_INSET = 1.7; // heat line inside each torn seam, well clear of the outline
/** Umbra length per millimetre of angular inset behind a panel, at full shadow strength. */
const UMBRA = 6.5;
const GLARE_MIN = 24; // the unmarked 'silence' at the heart of the burst
const SOURCE_DEPTH = -22; // the burst sits behind the assembly plane

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function numeric(ctx: SketchContext, id: string, fallback: number, low: number, high: number): number {
  const value = ctx.params[id];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, low, high) : fallback;
}

// ---------------------------------------------------------------- vector helpers
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = norm(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1]; };
const mul = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const matmul = (a: M3, b: M3): M3 => {
  const out: M3 = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
};
const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Rodrigues rotation for an axis-angle vector. */
function rotation(w: V3): M3 {
  const angle = norm(w);
  if (angle < 1e-12) return IDENTITY.slice();
  const [x, y, z] = scale(w, 1 / angle);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}
/** Angle of the relative rotation a·bᵀ. */
export function rotationBetween(a: M3, b: M3): number {
  let trace = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) trace += a[i * 3 + k] * b[i * 3 + k];
  return Math.acos(clamp((trace - 1) / 2, -1, 1));
}

/** Weak-perspective projection onto the page. */
export function project(p: V3): Point {
  const s = FOCAL / (FOCAL - p[2]);
  return { x: FOCUS.x + (p[0] - FOCUS.x) * s, y: FOCUS.y + (p[1] - FOCUS.y) * s };
}

// ---------------------------------------------------------------- 2D polygon helpers
function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export const insideAny = (point: Point, polygons: Point[][]) => polygons.some(polygon => insidePolygon(point, polygon));

/** Parameters in (0, 1) where segment a→b crosses any polygon edge. */
function crossings(a: Point, b: Point, polygons: Point[][]): number[] {
  const ts: number[] = [];
  const rx = b.x - a.x, ry = b.y - a.y;
  for (const polygon of polygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const p = polygon[j], q = polygon[i];
      const sx = q.x - p.x, sy = q.y - p.y;
      const denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) < 1e-12) continue;
      const t = ((p.x - a.x) * sy - (p.y - a.y) * sx) / denominator;
      const u = ((p.x - a.x) * ry - (p.y - a.y) * rx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  return ts.sort((x, y) => x - y);
}

/** Exact hidden-line removal of a polyline against a set of occluding silhouettes. */
export function clipOutside(path: Point[], polygons: Point[][]): Point[][] {
  if (!polygons.length) return [path];
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1], b = path[index];
    const ts = [0, ...crossings(a, b, polygons), 1];
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < 1e-9) continue;
      const mid = (t0 + t1) / 2;
      const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (insideAny(at(mid), polygons)) { flush(); continue; }
      if (!run.length) run.push(at(t0));
      run.push(at(t1));
    }
  }
  flush();
  return runs;
}

/** Complement of clipOutside for a single polygon: the pieces of a path inside it. */
function clipInside(path: Point[], polygon: Point[]): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1], b = path[index];
    const ts = [0, ...crossings(a, b, [polygon]), 1];
    for (let k = 1; k < ts.length; k++) {
      const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (!insidePolygon(at((ts[k - 1] + ts[k]) / 2), polygon)) { if (run.length >= 2) runs.push(run); run = []; continue; }
      if (!run.length) run.push(at(ts[k - 1]));
      run.push(at(ts[k]));
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** A circumscribed n-gon, so clipping against it clears the whole glare disc. */
export function disc(center: Point, radius: number, sides = 120): Point[] {
  const r = radius / Math.cos(Math.PI / sides);
  return Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
  });
}

const pathLength = (path: Point[]) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

// ---------------------------------------------------------------- the intact assembly
export interface PanelShape {
  id: number;
  /** Polygon in panel-local plate coordinates (mm), centred on the panel's own centroid. */
  outline: [number, number][];
  /** Indices into outline marking the start of each torn edge run (for accents). */
  torn: [number, number][][];
  width: number;
  height: number;
  /** Initial world centre (page mm, z toward viewer) and orientation. */
  center: V3;
  orientation: M3;
}
export interface Assembly { panels: PanelShape[]; center: V3; orientation: M3 }

/** One rigid grid that can be mentally reassembled: shared jagged seams, straight outer edges. */
export function buildAssembly(ctx: SketchContext): Assembly {
  const random = ctx.random('nova-structure');
  const count = Math.round(numeric(ctx, 'panelCount', 7, 5, 9));
  const size = numeric(ctx, 'panelSize', 62, 36, 84);
  const rows = count <= 8 ? 2 : 3;
  const cols = Math.ceil(count / rows);
  const widths = Array.from({ length: cols }, () => size * (0.86 + random() * 0.3));
  const heights = Array.from({ length: rows }, () => size * (0.66 + random() * 0.22));
  const totalW = widths.reduce((a, b) => a + b, 0), totalH = heights.reduce((a, b) => a + b, 0);
  const xs = [-totalW / 2], ys = [-totalH / 2];
  for (const w of widths) xs.push(xs[xs.length - 1] + w);
  for (const h of heights) ys.push(ys[ys.length - 1] + h);
  // Missing cells come from the corners: material already gone beyond the frame.
  const corners = [[0, 0], [cols - 1, rows - 1], [cols - 1, 0], [0, rows - 1]];
  const cornerOrder = corners.map(c => ({ c, k: random() })).sort((a, b) => a.k - b.k).map(item => item.c);
  const missing = new Set<string>();
  for (let i = 0; i < rows * cols - count; i++) missing.add(cornerOrder[i].join(','));
  const exists = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && !missing.has(`${c},${r}`);
  // Grid nodes carry a small shared jitter so seams do not meet on a perfect lattice.
  const node = new Map<string, [number, number]>();
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const interior = c > 0 && c < cols && r > 0 && r < rows;
    const j = interior ? size * 0.07 : 0;
    node.set(`${c},${r}`, [xs[c] + (random() - 0.5) * 2 * j, ys[r] + (random() - 0.5) * 2 * j]);
  }
  // Seams are generated once and shared, so both neighbours carry the same jagged tear.
  const seams = new Map<string, [number, number][]>();
  const seam = (a: string, b: string, torn: boolean): [number, number][] => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!seams.has(key)) {
      const p = node.get(a < b ? a : b)!, q = node.get(a < b ? b : a)!;
      if (!torn) seams.set(key, [p, q]);
      else {
        const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
        const nx = -dy / length, ny = dx / length;
        const teeth = Math.max(6, Math.round(length / 4.2));
        const amplitude = size * (0.03 + random() * 0.035);
        const points: [number, number][] = [p];
        let walk = 0;
        for (let k = 1; k < teeth; k++) {
          const t = (k + (random() - 0.5) * 0.7) / teeth;
          walk = walk * 0.45 + (random() - 0.5) * 2 * amplitude;
          const spike = random() < 0.18 ? (random() < 0.5 ? -1 : 1) * amplitude * 1.6 : 0;
          const taper = Math.min(1, 4 * Math.min(t, 1 - t) + 0.25);
          const swing = (walk + spike) * taper;
          points.push([p[0] + dx * t + nx * swing, p[1] + dy * t + ny * swing]);
        }
        points.push(q);
        seams.set(key, points);
      }
    }
    const points = seams.get(key)!;
    return a < b ? points : [...points].reverse();
  };
  const panels: PanelShape[] = [];
  const centerLocal: [number, number][] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!exists(c, r)) continue;
    const corners4 = [`${c},${r}`, `${c + 1},${r}`, `${c + 1},${r + 1}`, `${c},${r + 1}`];
    const neighbours = [[c, r - 1], [c + 1, r], [c, r + 1], [c - 1, r]];
    const ring: [number, number][] = [];
    const tornRuns: [number, number][][] = [];
    for (let side = 0; side < 4; side++) {
      const [nc, nr] = neighbours[side];
      const inGrid = nc >= 0 && nr >= 0 && nc < cols && nr < rows;
      const torn = inGrid; // a neighbour (present or already gone) means this edge was torn
      const edge = seam(corners4[side], corners4[(side + 1) % 4], torn);
      if (torn) tornRuns.push(edge);
      ring.push(...edge.slice(0, -1));
    }
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    centerLocal.push([cx, cy]);
    panels.push({ id: id++, outline: ring.map(([x, y]) => [x - cx, y - cy]),
      torn: tornRuns.map(run => run.map(([x, y]) => [x - cx, y - cy] as [number, number])),
      width: widths[c], height: heights[r], center: [0, 0, 0], orientation: IDENTITY });
  }
  // Pose: placed just above the sheet centre; the long axis runs diagonally down the tall sheet, tilted gently out of the page.
  const alpha = (random() < 0.5 ? -1 : 1) * (0.72 + random() * 0.4);
  const beta = (random() < 0.5 ? -1 : 1) * (0.18 + random() * 0.22);
  const gamma = (random() - 0.5) * 0.4;
  const orientation = matmul(rotation([0, 0, alpha]), matmul(rotation([beta, 0, 0]), rotation([0, gamma, 0])));
  const center: V3 = [FOCUS.x + (random() - 0.5) * 24, FOCUS.y - 6 + (random() - 0.5) * 20, 0];
  panels.forEach((panel, index) => {
    panel.center = add(center, mul(orientation, [centerLocal[index][0], centerLocal[index][1], 0]));
    panel.orientation = orientation;
  });
  return { panels, center, orientation };
}

// ---------------------------------------------------------------- the blast
export interface Body { panel: PanelShape; center: V3; orientation: M3; distance: number; displacement: number; rotation: number; falloff: number }

export interface Source { page: Point; world: V3 }

export function sourceOf(ctx: SketchContext): Source {
  const x = lerp(ART.xMin, ART.xMax, numeric(ctx, 'sourceX', 0.46, 0, 1));
  const y = lerp(ART.yMin, ART.yMax, numeric(ctx, 'sourceY', 0.41, 0, 1));
  // Choose the world point so that it projects exactly onto the requested page position.
  const s = FOCAL / (FOCAL - SOURCE_DEPTH);
  const world: V3 = [FOCUS.x + (x - FOCUS.x) / s, FOCUS.y + (y - FOCUS.y) / s, SOURCE_DEPTH];
  return { page: { x, y }, world };
}

const FALLOFF_RADIUS = 105;
/** Panels that took at least this share of the blast keep a vermilion heat line on their tears. */
const HOT_FALLOFF = 0.6;
export const falloff = (distance: number) => 1 / (1 + (distance / FALLOFF_RADIUS) ** 2);

/**
 * Radial impulse with distance falloff, applied off-centre so it also spins each plate.
 * A short pressure pulse is integrated with a fixed step; afterwards the plates coast.
 */
export function simulateBlast(ctx: SketchContext, assembly: Assembly, source: Source): Body[] {
  const random = ctx.random('nova-blast');
  const strength = numeric(ctx, 'blastStrength', 0.62, 0, 1);
  const moment = numeric(ctx, 'moment', 0.5, 0, 1);
  const pulse = 0.08, dt = 1 / 400;
  const steps = Math.round(moment / dt);
  const meanArea = assembly.panels.reduce((s, p) => s + p.width * p.height, 0) / assembly.panels.length;
  return assembly.panels.map(panel => {
    // Fixed draw count per panel keeps every body's randomness independent of the controls.
    const pressure: [number, number] = [random() * 2 - 1, random() * 2 - 1];
    const tumble: V3 = unit([random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]);
    const kick = 0.85 + random() * 0.3;
    const offset = sub(panel.center, source.world);
    const distance = norm(offset);
    const direction = unit(offset);
    const g = falloff(distance);
    const mass = (panel.width * panel.height) / meanArea;
    const impulse = strength * g * kick * 210; // mm / unit-moment for a mean plate
    // Centre of pressure: biased toward the edge facing the burst, plus a seeded offset.
    const facing = sub(source.world, panel.center);
    const bias: V3 = scale(unit([facing[0], facing[1], 0]), Math.min(panel.width, panel.height) * 0.22);
    const lever = add(bias, mul(panel.orientation,
      [pressure[0] * panel.width * 0.28, pressure[1] * panel.height * 0.28, 0]));
    const inertia = mass * (panel.width ** 2 + panel.height ** 2) / 12;
    const torque = cross(lever, scale(direction, impulse * mass));
    const spin = add(scale(torque, 0.9 / inertia), scale(tumble, strength * g * 2.2));
    let position: V3 = [...panel.center];
    let velocity: V3 = [0, 0, 0];
    let omega: V3 = [0, 0, 0];
    let orientation = panel.orientation.slice();
    for (let step = 0; step < steps; step++) {
      const t = step * dt;
      if (t < pulse) {
        // Square pressure pulse delivers the whole impulse over `pulse` units of moment.
        velocity = add(velocity, scale(direction, impulse / mass * dt / pulse));
        omega = add(omega, scale(spin, dt / pulse));
      }
      position = add(position, scale(velocity, dt));
      orientation = matmul(rotation(scale(omega, dt)), orientation);
    }
    return { panel, center: position, orientation, distance, falloff: g,
      displacement: norm(sub(position, panel.center)), rotation: rotationBetween(orientation, panel.orientation) };
  });
}

// ---------------------------------------------------------------- panel marks
interface Drawn { silhouette: Point[]; outline: Point[][]; hatch: Point[][]; torn: Point[][]; depth: number; casts: boolean }

const toWorld = (body: { center: V3; orientation: M3 }, local: [number, number], lift = 0): V3 =>
  add(body.center, mul(body.orientation, [local[0], local[1], lift]));

/** Scanline hatch of a local polygon along u (or v when `across`), at a pitch in local mm. */
function scanHatch(outline: [number, number][], pitch: number, across: boolean): [number, number][][] {
  const ring = outline.map(([x, y]) => across ? [y, x] : [x, y]);
  const ys = ring.map(p => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const lines: [number, number][][] = [];
  for (let y = lo + pitch * 0.5; y < hi; y += pitch) {
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const seg: [number, number][] = [[xs[k], y], [xs[k + 1], y]];
      lines.push(across ? seg.map(([p, q]) => [q, p] as [number, number]) : seg);
    }
  }
  return lines;
}

function drawBody(body: { panel: PanelShape; center: V3; orientation: M3 }, source: Source, pitch: number, casts: boolean, heat = false): Drawn {
  const { panel } = body;
  const normal = mul(body.orientation, [0, 0, 1]);
  const front = normal[2] >= 0;
  const silhouette = panel.outline.map(p => project(toWorld(body, p)));
  // Plates that face the burst catch light: they get a more open hatch.
  const lit = dot(front ? normal : scale(normal, -1), sub(source.world, body.center)) > 0;
  const localPitch = pitch * (lit ? 1.4 : 1);
  // Thin the hatch where foreshortening would push projected lines under the pen minimum.
  const pu = mul(body.orientation, [1, 0, 0]), pv = mul(body.orientation, [0, 1, 0]);
  const area = Math.abs(pu[0] * pv[1] - pu[1] * pv[0]);
  const along = front ? Math.hypot(pu[0], pu[1]) : Math.hypot(pv[0], pv[1]);
  const projectedSpacing = along > 1e-6 ? localPitch * area / along : 0;
  const hatch: Point[][] = [];
  if (area > 0.12) {
    const step = Math.max(1, Math.ceil((MIN_SPACING + 0.15) / Math.max(1e-6, projectedSpacing)));
    const lines = scanHatch(panel.outline, localPitch * step, !front);
    for (const line of lines) {
      const projected = line.map(p => project(toWorld(body, p)));
      if (pathLength(projected) >= 0.6) hatch.push(projected);
    }
  }
  const outline = [[...silhouette, silhouette[0]]];
  const torn: Point[][] = [];
  if (heat && area > 0.5) {
    const local = panel.outline.map(([x, y]) => ({ x, y }));
    for (const run of panel.torn) {
      const inner = run.map((p, i) => {
        const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        const n: [number, number] = [-dy / l * TEAR_INSET, dx / l * TEAR_INSET];
        const probe = { x: p[0] + n[0], y: p[1] + n[1] };
        return insidePolygon(probe, local) ? probe : { x: p[0] - n[0], y: p[1] - n[1] };
      });
      // Keep only the inner pieces that stay clear of the plate's own outline.
      for (const piece of clipInside(inner, local)) {
        if (piece.length >= 2) torn.push(piece.map(p => project(toWorld(body, [p.x, p.y]))));
      }
    }
  }
  return { silhouette, outline, hatch, torn, depth: body.center[2], casts };
}

// ---------------------------------------------------------------- shards
interface ShardBody { panel: PanelShape; center: V3; orientation: M3 }

/** A few slivers torn from seams; slower than their parent, so they trail behind it. */
function shards(ctx: SketchContext, bodies: Body[], source: Source, glare: number): ShardBody[] {
  const amount = numeric(ctx, 'shardAmount', 0.35, 0, 1);
  const random = ctx.random('nova-shards');
  const moment = numeric(ctx, 'moment', 0.5, 0, 1);
  const candidates: ShardBody[] = [];
  for (let i = 0; i < 24; i++) {
    const pick = random(), runPick = random(), along = random(), size = random(), slow = random(), spinPick = random();
    const spread: V3 = [random() - 0.5, random() - 0.5, random() - 0.5];
    const twist: V3 = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    const body = bodies[Math.floor(pick * bodies.length)];
    const runs = body.panel.torn;
    if (!runs.length) continue;
    const run = runs[Math.floor(runPick * runs.length)];
    const k = Math.min(run.length - 2, Math.floor(along * (run.length - 1)));
    const a = run[k], b = run[k + 1];
    const origin: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const initial = add(body.panel.center, mul(body.panel.orientation, [origin[0], origin[1], 0]));
    const travel = sub(body.center, body.panel.center);
    const lag = 0.5 + slow * 0.4;
    const outward = unit(sub(initial, source.world));
    const center = add(add(initial, scale(travel, lag)), add(scale(spread, 18 * moment), scale(outward, 10 + 30 * moment * body.falloff)));
    const projected = project(center);
    if (Math.hypot(projected.x - source.page.x, projected.y - source.page.y) < glare + 10) continue;
    const length = 7 + size * 11, width = 1.8 + size * 2.4;
    const outline: [number, number][] = [[-length / 2, 0], [length * 0.1, -width / 2], [length / 2, width * 0.15], [length * 0.05, width / 2]];
    const orientation = matmul(rotation(scale(unit(twist), (1 + spinPick * 3) * moment * 2)), body.panel.orientation);
    candidates.push({ panel: { id: 100 + i, outline, torn: [], width: length, height: width, center: initial, orientation }, center, orientation });
  }
  return candidates.slice(0, Math.round(amount * 12));
}

// ---------------------------------------------------------------- rays and the sunbeam
function frameDistance(origin: Point, angle: number, rect: Rect): number {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const tx = Math.abs(dx) < 1e-12 ? Infinity : ((dx > 0 ? rect.xMax : rect.xMin) - origin.x) / dx;
  const ty = Math.abs(dy) < 1e-12 ? Infinity : ((dy > 0 ? rect.yMax : rect.yMin) - origin.y) / dy;
  return Math.max(0, Math.min(tx, ty));
}

/** Angular extent of a silhouette seen from the source, relative to its mean direction. */
function angularSpan(origin: Point, polygon: Point[]): { mid: number; low: number; high: number } {
  const cx = polygon.reduce((t, p) => t + p.x, 0) / polygon.length;
  const cy = polygon.reduce((t, p) => t + p.y, 0) / polygon.length;
  const mid = Math.atan2(cy - origin.y, cx - origin.x);
  let low = Infinity, high = -Infinity;
  for (const p of polygon) {
    const a = Math.atan2(p.y - origin.y, p.x - origin.x);
    const d = Math.atan2(Math.sin(a - mid), Math.cos(a - mid));
    low = Math.min(low, d); high = Math.max(high, d);
  }
  return { mid, low, high };
}

/** Intervals along a ray (as distances from the source) where it lies inside a polygon. */
function insideIntervals(origin: Point, angle: number, reach: number, polygon: Point[]): [number, number][] {
  const end = { x: origin.x + Math.cos(angle) * reach, y: origin.y + Math.sin(angle) * reach };
  const ts = [0, ...crossings(origin, end, [polygon]), 1];
  const out: [number, number][] = [];
  for (let k = 1; k < ts.length; k++) {
    const mid = (ts[k - 1] + ts[k]) / 2;
    if (insidePolygon({ x: origin.x + (end.x - origin.x) * mid, y: origin.y + (end.y - origin.y) * mid }, polygon)) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - ts[k - 1] * reach) < 1e-9) last[1] = ts[k] * reach;
      else out.push([ts[k - 1] * reach, ts[k] * reach]);
    }
  }
  return out;
}

function subtract(spans: [number, number][], cuts: [number, number][]): [number, number][] {
  let result = spans;
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [s0, s1] of result) {
      if (c1 <= s0 || c0 >= s1) { next.push([s0, s1]); continue; }
      if (c0 > s0) next.push([s0, c0]);
      if (c1 < s1) next.push([c1, s1]);
    }
    result = next;
  }
  return result;
}

export interface RayOptions { count: number; length: number; shadow: number; glare: number }

interface RayResult { cyan: Point[][]; gold: Point[][] }

function rays(ctx: SketchContext, source: Source, occluders: Drawn[], options: RayOptions): RayResult {
  const random = ctx.random('nova-rays');
  const origin = source.page;
  const count = options.count;
  // Nested start radii: every fourth slot starts at the glare, every second where half the
  // slots fit at pen spacing, the rest where all of them do. Spacing never drops under 0.5 mm.
  const radiusFor = (slots: number) => Math.max(options.glare, (slots * (MIN_SPACING + 0.05)) / (2 * Math.PI));
  // Fan field: a few broad bursts plus narrow spikes shade the burst through spacing and length.
  const fans = Array.from({ length: 7 }, (_, i) => ({
    angle: random() * Math.PI * 2,
    width: i < 3 ? 0.35 + random() * 0.5 : 0.05 + random() * 0.12,
    strength: i < 3 ? 0.55 + random() * 0.45 : 0.5 + random() * 0.5,
  }));
  const phase = random() * Math.PI * 2;
  const intensity = (angle: number) => {
    let value = 0.28;
    for (const fan of fans) {
      const d = Math.atan2(Math.sin(angle - fan.angle), Math.cos(angle - fan.angle));
      value += fan.strength * Math.exp(-0.5 * (d / fan.width) ** 2);
    }
    return clamp(value, 0, 1);
  };
  const cyan: Point[][] = [], gold: Point[][] = [];
  const standoff = 1.1;
  for (let k = 0; k < count; k++) {
    const keep = random(), lengthJitter = random(), shadowJitter = random(), startJitter = random(), ink = random();
    const angle = phase + (k / count) * Math.PI * 2;
    const level = intensity(angle);
    if (keep > 0.42 + 0.58 * level ** 1.4) continue;
    const reach = frameDistance(origin, angle, RAY_FRAME);
    const tier = k % 4 === 0 ? radiusFor(Math.ceil(count / 4)) : k % 2 === 0 ? radiusFor(Math.ceil(count / 2)) : radiusFor(count);
    const start = tier + startJitter * startJitter * 10;
    const fraction = clamp((0.5 + 0.6 * level + 0.32 * (lengthJitter - 0.5)) * options.length / 0.85, 0.08, 1);
    const end = lerp(start, reach, fraction);
    if (end - start < 2) continue;
    // Occluders hide the ray; each casting panel leaves a dark shaft beyond its far edge.
    const cuts: [number, number][] = [];
    for (const occluder of occluders) {
      const spans = insideIntervals(origin, angle, reach + 1, occluder.silhouette);
      for (const [a, b] of spans) cuts.push([a - standoff, b + standoff]);
      if (occluder.casts && spans.length && options.shadow > 0 && !insidePolygon(origin, occluder.silhouette)) {
        // The burst has size, so each umbra tapers: rays deep inside the panel's angular
        // span stay dark for longest, rays near its silhouette edge resume soonest.
        const far = spans[spans.length - 1][1];
        const span = angularSpan(origin, occluder.silhouette);
        const offset = Math.atan2(Math.sin(angle - span.mid), Math.cos(angle - span.mid));
        const inset = Math.max(0, Math.min(offset - span.low, span.high - offset)) * far;
        const length = inset * options.shadow * UMBRA * (0.8 + 0.4 * shadowJitter) + options.shadow * 14;
        cuts.push([far, far + length]);
      }
    }
    const spans = subtract([[start, end]], cuts.sort((a, b) => a[0] - b[0]));
    const dx = Math.cos(angle), dy = Math.sin(angle);
    for (const [a, b] of spans) {
      if (b - a < 1.2) continue;
      const path = [{ x: origin.x + dx * a, y: origin.y + dy * a }, { x: origin.x + dx * b, y: origin.y + dy * b }];
      for (const bounded of clipPolylineToRect(path, ART)) {
        if (pathLength(bounded) >= 1.2) (ink < 0.06 ? gold : cyan).push(bounded);
      }
    }
  }
  return { cyan, gold };
}

// ---------------------------------------------------------------- scene
export interface NovaScene {
  parts: Part[];
  source: Source;
  glareRadius: number;
  assembly: Assembly;
  bodies: Body[];
  /** Projected panel silhouettes in draw order (far to near). */
  silhouettes: Point[][];
}

export function drawNova(ctx: SketchContext): NovaScene {
  const source = sourceOf(ctx);
  const assembly = buildAssembly(ctx);
  const bodies = simulateBlast(ctx, assembly, source);
  const pitch = numeric(ctx, 'hatchPitch', 1.0, 0.6, 3);
  const count = Math.round(numeric(ctx, 'rayCount', 440, 40, 720));
  const glare = Math.max(GLARE_MIN, (Math.ceil(count / 4) * (MIN_SPACING + 0.05)) / (2 * Math.PI));
  const glareDisc = disc(source.page, glare);
  const drawnPanels = bodies.map(body => drawBody(body, source, pitch, true, body.falloff > HOT_FALLOFF));
  const drawnShards = shards(ctx, bodies, source, glare).map(body => drawBody(body, source, pitch * 0.8, false));
  const all = [...drawnPanels, ...drawnShards].sort((a, b) => a.depth - b.depth);
  const panelCarbon: Point[][] = [], shardCarbon: Point[][] = [], tear: Point[][] = [];
  // Hidden-line removal: each body is cut by every nearer silhouette and by the glare.
  all.forEach((item, index) => {
    const nearer = [...all.slice(index + 1).map(other => other.silhouette), glareDisc];
    const target = item.casts ? panelCarbon : shardCarbon;
    const emit = (paths: Point[][], into: Point[][]) => {
      for (const path of paths) for (const piece of clipOutside(path, nearer)) for (const bounded of clipPolylineToRect(piece, ART)) {
        if (pathLength(bounded) >= 0.6) into.push(bounded);
      }
    };
    emit([...item.outline, ...item.hatch], target);
    emit(item.torn, tear);
  });
  const lightRays = rays(ctx, source, all, {
    count, glare,
    length: numeric(ctx, 'rayLength', 0.85, 0.15, 1),
    shadow: numeric(ctx, 'shadowStrength', 0.75, 0, 1),
  });
  const parts: Part[] = [
    { id: 'ray-cyan', pen: 'cyan', paths: lightRays.cyan },
    { id: 'ray-gold', pen: 'gold', paths: lightRays.gold },
    { id: 'panel-carbon', pen: 'carbon', paths: panelCarbon },
    { id: 'shard-carbon', pen: 'carbon', paths: shardCarbon },
    { id: 'tear-vermilion', pen: 'vermilion', paths: tear },
  ];
  return { parts, source, glareRadius: glare, assembly, bodies, silhouettes: drawnPanels.map(d => d.silhouette) };
}
