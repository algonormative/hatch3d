import type { Part, Point } from '../../src/sketch/types.ts';
import { hatchAtmosphere, maskAtmospherePaths, type AtmosphereField } from '../../packages/plot-core/src/atmosphere.ts';
import type { ActiveVortex, CloudSnapshot, Vec2 } from './model.ts';
import { velocityAtTime, type CloudDomain } from './sim.ts';
import type { CloudStudy } from './study.ts';

/** Extraction-only settings that are not part of MarkSettings. */
export interface ExtractParams {
  /** false: draw the structure as authored and nothing else; the simulation is not needed. */
  cloudEnabled: boolean;
  /** Interior hatch pitch of structural members, final page mm. */
  hatchPitch: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** Passes of 8-neighbour averaging that carry fluid density into solid cells (stops early once every reachable cell is filled). */
const OBSCURANCE_PASSES = 40;
/** Box-blur passes over the extraction grid. A drawing choice, constant for every frame: it spreads the steep gradient an absorbing face leaves, so contours there do not pile into a solid band. */
const FIELD_SMOOTH_PASSES = 2;
/** Page-mm sampling step and minimum run length for masking structure. */
const MASK_STEP_MM = 0.8;
const MASK_MIN_LENGTH_MM = 0.8;
/** Page-mm clearance kept around visible member linework, and sampling step used where cloud runs are cut. */
export const MEMBER_CLEARANCE_MM = 0.6;
const CUT_STEP_MM = 0.2;
/** Page-mm guard added to the core radius so quantization cannot leave a point inside it. */
const CORE_GUARD_MM = 0.02;
/** Resampling step for minimum-spacing culling, page mm. */
const CULL_STEP_MM = 0.5;
/** A piece that culling leaves shorter than this many cloud pitches is dropped (it would read as a dash). */
const CULL_MIN_RUN_PITCHES = 5;

/** One member's linework in art coordinates, after hidden-line removal by members drawn later. */
export interface MemberDrawing { outline: Point[][]; hatch: Point[][] }

/** Parts of a segment chain outside a convex polygon (Cyrus-Beck per segment, runs rejoined). */
export function subtractConvex(path: Point[], ring: Point[]): Point[][] {
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; area += p.x * q.y - q.x * p.y; }
  const sign = area >= 0 ? 1 : -1;
  const runs: Point[][] = [];
  let run: Point[] = [];
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const flush = (): void => { if (run.length >= 2) runs.push(run); run = []; };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < ring.length && t0 < t1; k++) {
      const p = ring[k], q = ring[(k + 1) % ring.length];
      const ex = q.x - p.x, ey = q.y - p.y;
      const c0 = sign * (ex * (a.y - p.y) - ey * (a.x - p.x));
      const c1 = sign * (ex * (b.y - a.y) - ey * (b.x - a.x));
      if (Math.abs(c1) < 1e-12) { if (c0 < 0) { t0 = 1; t1 = 0; } continue; }
      const t = -c0 / c1;
      if (c1 > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    const hit = t0 < t1 && t0 < 1 && t1 > 0;
    const pieces: [number, number][] = hit ? [[0, t0], [t1, 1]] : [[0, 1]];
    for (const [u0, u1] of pieces) {
      if (u1 - u0 < 1e-9) continue;
      const pa = lerp(a, b, u0), pb = lerp(a, b, u1);
      if (run.length === 0 || Math.hypot(run[run.length - 1].x - pa.x, run[run.length - 1].y - pa.y) > 1e-9) { flush(); run = [pa]; }
      run.push(pb);
    }
  }
  flush();
  return runs;
}

/**
 * Closed outline and interior hatch of every member. Members later in the list
 * hide earlier ones where they overlap, so overlapping architecture reads as one
 * drawing rather than a stack of transparent boxes.
 */
export function memberDrawings(study: CloudStudy, pitchMm: number): MemberDrawing[] {
  const rings = study.structure.map(member => member.polygon.map(study.worldToArt));
  const boxes = rings.map(ring => ({
    x0: Math.min(...ring.map(p => p.x)), x1: Math.max(...ring.map(p => p.x)),
    y0: Math.min(...ring.map(p => p.y)), y1: Math.max(...ring.map(p => p.y)),
  }));
  return study.structure.map((member, i) => {
    // Stroke members (rays, ring bands, filaments) are drawn as given. They do not overlap one another: the sun clamps its noise so that adjacent rays keep a gap.
    if (member.strokes) return { outline: member.strokes.map(line => line.map(study.worldToArt)), hatch: [] };
    const ring = rings[i];
    const pitch = Math.max(pitchMm * member.pitch, 0.05) / study.fit.scale;
    let hatch = hatchPolygon(ring, member.hatchAngle, pitch, member.tonal);
    if (member.cross) hatch = hatch.concat(hatchPolygon(ring, member.hatchAngle + 1.15, pitch * 1.9, false));
    let outline: Point[][] = [[...ring, { ...ring[0] }]];
    for (let j = i + 1; j < rings.length; j++) {
      if (study.structure[j].strokes) continue;
      const a = boxes[i], b = boxes[j];
      if (b.x1 < a.x0 || b.x0 > a.x1 || b.y1 < a.y0 || b.y0 > a.y1) continue;
      outline = outline.flatMap(path => subtractConvex(path, rings[j]));
      hatch = hatch.flatMap(path => subtractConvex(path, rings[j]));
    }
    return { outline, hatch };
  });
}

/**
 * Parallel lines clipped to a simple polygon. Untoned sets sit on a global lattice
 * (so hatching registers across members); a tonal set compresses toward one side.
 */
function hatchPolygon(ring: Point[], angle: number, pitch: number, tonal: boolean): Point[][] {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const nx = -dy, ny = dx;
  const offsets = ring.map(p => p.x * nx + p.y * ny);
  const lo = Math.min(...offsets), hi = Math.max(...offsets);
  const lines: Point[][] = [];
  const scan = (off: number): void => {
    const along: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const va = a.x * nx + a.y * ny - off, vb = b.x * nx + b.y * ny - off;
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      along.push(x * dx + y * dy);
    }
    along.sort((p, q) => p - q);
    for (let i = 0; i + 1 < along.length; i += 2) {
      if (along[i + 1] - along[i] < pitch * 0.15) continue;
      const base = { x: nx * off, y: ny * off };
      lines.push([
        { x: base.x + dx * along[i], y: base.y + dy * along[i] },
        { x: base.x + dx * along[i + 1], y: base.y + dy * along[i + 1] },
      ]);
    }
  };
  if (tonal) {
    const n = Math.max(3, Math.round((hi - lo) / pitch * 1.4));
    for (let k = 1; k < n; k++) scan(lo + (hi - lo) * Math.pow(k / n, 1.9) + 1e-9);
  } else {
    for (let k = Math.ceil(lo / pitch); k * pitch < hi; k++) scan(k * pitch + 1e-9);
  }
  return lines;
}

/**
 * Fluid concentration carried into solid cells by a few passes of 8-neighbour
 * averaging, so a member can be read as sitting behind cloud. Computed on a
 * copy: the snapshot is never mutated. Solid cells out of reach stay at zero.
 */
export function obscuranceGrid(domain: CloudDomain, density: ArrayLike<number>, passes = OBSCURANCE_PASSES): Float64Array {
  const { cols, rows, solid } = domain;
  const grid = new Float64Array(cols * rows);
  const known = new Uint8Array(cols * rows);
  for (let c = 0; c < grid.length; c++) {
    if (!solid[c]) { grid[c] = density[c]; known[c] = 1; }
  }
  for (let pass = 0; pass < passes; pass++) {
    const fresh: number[] = [];
    const value: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i;
        if (known[c]) continue;
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if ((di === 0 && dj === 0) || ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
            const q = jj * cols + ii;
            if (known[q]) { sum += grid[q]; n++; }
          }
        }
        if (n > 0) { fresh.push(c); value.push(sum / n); }
      }
    }
    if (fresh.length === 0) break;
    for (let k = 0; k < fresh.length; k++) { grid[fresh[k]] = value[k]; known[fresh[k]] = 1; }
  }
  return grid;
}

/** 3×3 box blur (edge cells average over the neighbours that exist), `passes` times, on a copy. */
export function smoothGrid(input: Float64Array, cols: number, rows: number, passes: number): Float64Array {
  let src = input;
  for (let pass = 0; pass < passes; pass++) {
    const dst = new Float64Array(src.length);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
            sum += src[jj * cols + ii]; n++;
          }
        }
        dst[j * cols + i] = sum / n;
      }
    }
    src = dst;
  }
  return src;
}

/** Plain bilinear read of a cell-centred grid in world metres; zero outside the domain. */
function bilinear(domain: CloudDomain, grid: Float64Array, p: Vec2): number {
  const { cols, rows, spacing } = domain;
  const o = domain.config.domain.origin;
  const fx = (p.x - o.x) / spacing - 0.5, fy = (p.y - o.y) / spacing - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > cols - 0.5 || fy > rows - 0.5) return 0;
  const i0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), j0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
  const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
  const top = grid[j0 * cols + i0] * (1 - tx) + grid[j0 * cols + i1] * tx;
  const bottom = grid[j1 * cols + i0] * (1 - tx) + grid[j1 * cols + i1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function insideDomain(study: CloudStudy, w: Vec2): boolean {
  const { origin, size } = study.config.domain;
  return w.x >= origin.x && w.x <= origin.x + size.x && w.y >= origin.y && w.y <= origin.y + size.y;
}

/** Cut a polyline to its parts outside a circle. Cut points land on the circle. */
export function clipOutsideCircle(path: Point[], center: Point, radius: number): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => { if (current.length >= 2) runs.push(current); current = []; };
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - center.x, fy = a.y - center.y;
    const A = dx * dx + dy * dy;
    const ts = [0];
    if (A > 0) {
      const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - radius * radius;
      const disc = B * B - 4 * A * C;
      if (disc > 0) {
        const root = Math.sqrt(disc);
        for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    ts.push(1);
    for (let k = 0; k + 1 < ts.length; k++) {
      const pa = lerp(a, b, ts[k]), pb = lerp(a, b, ts[k + 1]);
      const mid = lerp(a, b, (ts[k] + ts[k + 1]) / 2);
      if (Math.hypot(mid.x - center.x, mid.y - center.y) >= radius) {
        if (current.length === 0) current.push(pa);
        current.push(pb);
      } else flush();
    }
  }
  flush();
  return runs;
}

const pathLength = (path: Point[]): number =>
  path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);


function pointInRing(ring: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const sq = dx * dx + dy * dy;
  const t = sq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / sq));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * Cut cloud marks away from members that are drawn. A sample is blocked when it lies inside a member
 * where that member is visible, or within `clearance` of a visible outline run. Where the member is
 * concealed the cloud may cross it. Runs end exactly at the edge of the blocked zone.
 */
function cutByVisibleMembers(
  paths: Point[][], rings: Point[][], outlines: Point[][], visibleAt: (p: Point) => boolean,
  clearance: number, step: number, origin?: number[],
): Point[][] {
  const reach = clearance + step;
  const boxes = rings.map(ring => ({
    x0: Math.min(...ring.map(p => p.x)) - reach, x1: Math.max(...ring.map(p => p.x)) + reach,
    y0: Math.min(...ring.map(p => p.y)) - reach, y1: Math.max(...ring.map(p => p.y)) + reach,
  }));
  const inBox = (p: Point): boolean => boxes.some(b => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
  const segments = outlines.flatMap(run => run.slice(1).map((q, i) => [run[i], q] as const));
  const blocked = (p: Point): boolean => {
    if (!inBox(p)) return false;
    for (const [a, b] of segments) if (distanceToSegment(p, a, b) < clearance) return true;
    return rings.some(ring => pointInRing(ring, p)) && visibleAt(p);
  };
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  // Last kept point on the way from a kept sample toward a blocked one.
  const edge = (kept: Point, gone: Point): Point => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (blocked(lerp(kept, gone, mid))) hi = mid; else lo = mid; }
    return lerp(kept, gone, lo);
  };
  const out: Point[][] = [];
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex];
    const emit = (run: Point[]): void => { out.push(run); origin?.push(pathIndex); };
    const samples: Point[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const near = len > step && (inBox(a) || inBox(b) || inBox(lerp(a, b, 0.5)));
      const n = near ? Math.ceil(len / step) : 1;
      for (let k = 1; k <= n; k++) samples.push(k === n ? b : lerp(a, b, k / n));
    }
    let run: Point[] = [];
    let prev = samples[0];
    let prevBlocked = blocked(prev);
    if (!prevBlocked) run.push(prev);
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i];
      const curBlocked = blocked(cur);
      if (!prevBlocked && !curBlocked) run.push(cur);
      else if (!prevBlocked && curBlocked) { run.push(edge(prev, cur)); if (run.length >= 2) emit(run); run = []; }
      else if (prevBlocked && !curBlocked) run = [edge(cur, prev), cur];
      prev = cur; prevBlocked = curBlocked;
    }
    if (run.length >= 2) emit(run);
  }
  return out;
}

/**
 * Minimum-spacing culling for contour wisps. Wisps are walked in order (hatchAtmosphere emits them level
 * by level, low levels first) and resampled every CULL_STEP_MM; a sample is dropped when it lies within
 * `dmin` of a sample already kept from a different wisp, and the wisp is split there. Runs of the same
 * wisp (`group`) never block each other, so cuts made earlier do not erode themselves. A spatial hash
 * keeps the work linear in the number of samples. Output vertices are the kept samples.
 */
export function cullMinSpacing(runs: Point[][], group: number[], dmin: number, step: number, minRun: number): Point[][] {
  const cell = dmin;
  const hash = new Map<number, { x: number; y: number; g: number }[]>();
  const key = (i: number, j: number): number => (i + 1048576) * 2097152 + (j + 1048576);
  const blocked = (p: Point, g: number): boolean => {
    const ci = Math.floor(p.x / cell), cj = Math.floor(p.y / cell);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const bucket = hash.get(key(ci + di, cj + dj));
      if (!bucket) continue;
      for (const q of bucket) if (q.g !== g && Math.hypot(q.x - p.x, q.y - p.y) < dmin) return true;
    }
    return false;
  };
  const accept = (p: Point, g: number): void => {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const bucket = hash.get(k);
    if (bucket) bucket.push({ x: p.x, y: p.y, g }); else hash.set(k, [{ x: p.x, y: p.y, g }]);
  };
  const out: Point[][] = [];
  runs.forEach((path, index) => {
    const g = group[index];
    const samples: Point[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 1; k <= n; k++) samples.push(k === n ? b : { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    // Decide against ink from other wisps only. A piece shorter than `minRun` would read as a dash
    // where two contours hover near dmin, so it is dropped; only surviving pieces then block later wisps.
    const pieces: Point[][] = [];
    let run: Point[] = [];
    for (const p of samples) {
      if (!blocked(p, g)) run.push(p);
      else { if (run.length >= 2) pieces.push(run); run = []; }
    }
    if (run.length >= 2) pieces.push(run);
    for (const piece of pieces) {
      if (pathLength(piece) < minRun) continue;
      out.push(piece);
      for (const p of piece) accept(p, g);
    }
  });
  return out;
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9]/g, '_');

/** Fixed field threshold under which a streak is not drawn or stops; never derived from the frame. */
export const STREAK_THRESHOLD = 0.22;
/** Integration step along a streak, in world metres. */
const STREAK_STEP_M = 0.3;
const STREAK_POINT_CAP = 40_000;

/** Stateless hash of (seed, a, b) to [0, 1). */
function hash01(seed: number, a: number, b: number): number {
  let h = (seed | 0) ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Short flow streaks: seeds on a jittered grid, kept where the fixed-mapping field is at least
 * STREAK_THRESHOLD, traced both ways along the prescribed velocity with RK2 in world metres. Length
 * grows with the field (fixed mapping, no per-frame normalization). A streak stops at a solid, the
 * domain edge, or when the field drops under the threshold. Art coordinates.
 */
export function traceStreaks(domain: CloudDomain, study: CloudStudy, field: (art: Point) => number, vortices: ReadonlyArray<ActiveVortex>): Point[][] {
  const { config, fit, pageMmPerM } = study;
  const sArt = study.streak.spacing / fit.scale;
  const a = study.worldToArt(config.domain.origin);
  const b = study.worldToArt({ x: config.domain.origin.x + config.domain.size.x, y: config.domain.origin.y + config.domain.size.y });
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const cols = Math.ceil(Math.abs(b.x - a.x) / sArt), rows = Math.ceil(Math.abs(b.y - a.y) / sArt);
  const fieldAt = (w: Vec2): number => field(study.worldToArt(w));
  const dir = (w: Vec2, sign: number): Vec2 | null => {
    // The velocity at this snapshot's time: drifting and trained eddies are where they are at this step.
    const v = velocityAtTime(config, vortices, w);
    const n = Math.hypot(v.x, v.y);
    return n < 1e-9 ? null : { x: (sign * v.x) / n, y: (sign * v.y) / n };
  };
  const trace = (start: Vec2, sign: number, lengthM: number): Vec2[] => {
    const out: Vec2[] = [];
    let p = start;
    for (let travelled = 0; travelled < lengthM; travelled += STREAK_STEP_M) {
      const d1 = dir(p, sign);
      if (!d1) break;
      const mid = { x: p.x + (d1.x * STREAK_STEP_M) / 2, y: p.y + (d1.y * STREAK_STEP_M) / 2 };
      const d2 = dir(mid, sign);
      if (!d2) break;
      const q = { x: p.x + d2.x * STREAK_STEP_M, y: p.y + d2.y * STREAK_STEP_M };
      if (!insideDomain(study, q) || domain.segmentBlocked(p, q) !== null || fieldAt(q) < STREAK_THRESHOLD) break;
      out.push(q);
      p = q;
    }
    return out;
  };
  const streaks: Point[][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const art = { x: x0 + (i + hash01(study.streak.seed, i, 2 * j)) * sArt, y: y0 + (j + hash01(study.streak.seed, i, 2 * j + 1)) * sArt };
      const w = study.artToWorld(art);
      if (!insideDomain(study, w)) continue;
      const f = fieldAt(w);
      if (f < STREAK_THRESHOLD) continue;
      // Page-mm length from the field alone: 1.2 to 5 spacings.
      const lengthM = (study.streak.spacing * (1.2 + 3.8 * f)) / pageMmPerM;
      const forward = trace(w, 1, lengthM / 2);
      const backward = trace(w, -1, lengthM / 2);
      const line = [...backward.reverse(), w, ...forward];
      if (line.length >= 3) streaks.push(line.map(study.worldToArt));
    }
  }
  const points = streaks.reduce((n, s) => n + s.length, 0);
  if (points <= STREAK_POINT_CAP) return streaks;
  // Over budget: keep a seeded subset, so the cap never depends on frame order.
  const keep = STREAK_POINT_CAP / points;
  return streaks.filter((_s, i) => hash01(study.streak.seed ^ 0x5bd1, i, 7) < keep);
}

/**
 * Keep a seeded subset of the paths when their points exceed `cap`: paths are ranked by a stateless hash of
 * (seed, index) and taken in that order while they fit, then restored to their original order. The cap holds
 * exactly and never depends on frame order.
 */
function capPoints(paths: Point[][], cap: number, seed: number): Point[][] {
  if (paths.reduce((n, path) => n + path.length, 0) <= cap) return paths;
  const order = paths.map((_path, i) => i).sort((a, b) => hash01(seed ^ 0x2c1b, a, 11) - hash01(seed ^ 0x2c1b, b, 11) || a - b);
  const kept = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (used + paths[i].length > cap) continue;
    kept.add(i);
    used += paths[i].length;
  }
  return paths.filter((_path, i) => kept.has(i));
}

/** Diagnostic part id: carries snapshot identity into result.json. Ids may not hold spaces or `=`. */
export function cloudStateId(snapshot: CloudSnapshot): string {
  const drift = snapshot.mass.relativeDrift;
  const digits = Math.abs(drift).toFixed(6).replace('.', 'p');
  return `cloud-state-step-${snapshot.step}-key-${safe(snapshot.hashes.stateKey)}-dens-${safe(snapshot.densityHash)}-drift-${drift < 0 ? 'neg' : 'pos'}${digits}`;
}

const STATE_ID = /^cloud-state-step-(\d+)-key-([A-Za-z0-9_]+)-dens-([A-Za-z0-9_]+)-drift-(pos|neg)(\d+)p(\d+)$/;
export function parseCloudStateId(id: string): { step: number; stateKey: string; densityHash: string; relativeDrift: number } | null {
  const m = STATE_ID.exec(id);
  if (!m) return null;
  return { step: Number(m[1]), stateKey: m[2], densityHash: m[3], relativeDrift: (m[4] === 'neg' ? -1 : 1) * Number(`${m[5]}.${m[6]}`) };
}

/**
 * Draw one snapshot. All coordinates are art coordinates; composePoster maps
 * them to the page. The concentration → contour mapping is fixed for every step
 * (field = clamp01(concentration / referenceDensity)); nothing is normalized by
 * the frame's own maximum.
 */
export function extractMarks(
  domain: CloudDomain | null,
  snapshot: CloudSnapshot | null,
  study: CloudStudy,
  params: ExtractParams,
): Part[] {
  const { marks, fit } = study;
  const drawings = memberDrawings(study, params.hatchPitch);
  const live = params.cloudEnabled && domain !== null && snapshot !== null;

  if (!live) {
    return [
      ...study.structure.map((member, i) => ({ id: `structure-${member.name}`, pen: member.pen, paths: [...drawings[i].outline, ...drawings[i].hatch] })),
      { id: 'cloud-state-off', pen: marks.structurePen, paths: [], diagnostic: true },
    ];
  }

  // One field drives everything: fluid concentration spread into the solid cells so it passes smoothly
  // through members, mapped with the fixed rule clamp01(c / referenceDensity). It contours the cloud,
  // conceals structure, and decides where members are visible.
  const referenceDensity = marks.referenceDensity;
  const grid = smoothGrid(obscuranceGrid(domain, snapshot.density), domain.cols, domain.rows, FIELD_SMOOTH_PASSES);
  const field = ((art: Point): number => {
    const w = study.artToWorld(art);
    return insideDomain(study, w) ? clamp01(bilinear(domain, grid, w) / referenceDensity) : 0;
  }) as AtmosphereField;
  const concealThreshold = 1 - 0.98 * Math.sqrt(marks.obscure);
  const visibleAt = (p: Point): boolean => marks.obscure === 0 || field(p) < concealThreshold;
  // The minimum length drops only fragments the cut created; an untouched path (returned by
  // reference) survives however short it is, so a clear sky leaves the structure as authored.
  const mask = (path: Point[]): Point[][] => marks.obscure > 0
    ? maskAtmospherePaths([path], field, { amount: marks.obscure, sampleStep: MASK_STEP_MM / fit.scale, minLength: 0 })
      .filter(run => run === path || pathLength(run) >= MASK_MIN_LENGTH_MM / fit.scale)
    : [path];

  // Structure: concealed where cloud is dense. Visible outline runs are remembered for the clearance rule.
  const visibleOutlines: Point[][] = [];
  const structureParts: Part[] = study.structure.map((member, i) => {
    const outline = drawings[i].outline.flatMap(mask);
    visibleOutlines.push(...outline);
    return { id: `structure-${member.name}`, pen: member.pen, paths: [...outline, ...drawings[i].hatch.flatMap(mask)] };
  });

  // Cloud: contour wisps of the field, cut away from visible members, then the quiet-core extraction mask.
  const a = study.worldToArt({ x: study.config.domain.origin.x, y: study.config.domain.origin.y });
  const b = study.worldToArt({
    x: study.config.domain.origin.x + study.config.domain.size.x,
    y: study.config.domain.origin.y + study.config.domain.size.y,
  });
  const bounds = { xMin: Math.min(a.x, b.x), xMax: Math.max(a.x, b.x), yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y) };
  const cloudField = Object.assign((art: Point): number => field(art), {
    scale: marks.featureScale / fit.scale, bounds, seed: marks.wispSeed,
  }) as AtmosphereField;
  const wisps = study.style === 'streaks' ? [] : hatchAtmosphere(bounds, cloudField, {
    spacing: marks.hatchSpacing / fit.scale, angle: marks.hatchAngle,
  });
  // Only solid members cut the cloud by area; drawn-only marks keep just the clearance from their lines.
  const rings = study.structure.filter(m => m.solid !== false).map(m => m.polygon.map(study.worldToArt));
  // Shared by contours and streaks: keep clear of visible members, then cut the quiet core.
  const finish = (paths: Point[][], minLength: number, spacing = 0): Point[][] => {
    const origin: number[] = [];
    let kept = cutByVisibleMembers(paths, rings, visibleOutlines, visibleAt, MEMBER_CLEARANCE_MM / fit.scale, CUT_STEP_MM / fit.scale, origin);
    if (marks.core.radius > 0) {
      const center = fit.inverse(marks.core.center);
      const radius = (marks.core.radius + CORE_GUARD_MM) / fit.scale;
      const clipped: Point[][] = [];
      const clippedOrigin: number[] = [];
      kept.forEach((path, i) => { for (const run of clipOutsideCircle(path, center, radius)) { clipped.push(run); clippedOrigin.push(origin[i]); } });
      kept = clipped;
      origin.length = 0;
      origin.push(...clippedOrigin);
    }
    // Culling sees the final ink (after the member and core cuts), so removed ink never blocks anything.
    if (spacing > 0) kept = cullMinSpacing(kept, origin, spacing / fit.scale, CULL_STEP_MM / fit.scale, Math.max(minLength, CULL_MIN_RUN_PITCHES * marks.hatchSpacing / fit.scale));
    return kept.filter(path => pathLength(path) >= minLength);
  };
  const cloud = finish(wisps, (marks.hatchSpacing * 0.75) / fit.scale, study.contourMinSpacing * marks.hatchSpacing);
  const streaks = capPoints(finish((study.style === 'contours' ? [] : traceStreaks(domain, study, field, snapshot.vortices)), (study.streak.spacing * 0.5) / fit.scale), STREAK_POINT_CAP, study.streak.seed);

  return [
    ...structureParts,
    ...(study.style !== 'streaks' ? [{ id: `cloud-${marks.cloudPen}`, pen: marks.cloudPen, paths: cloud }] : []),
    ...(study.style !== 'contours' ? [{ id: `streak-${study.streak.pen}`, pen: study.streak.pen, paths: streaks }] : []),
    { id: cloudStateId(snapshot), pen: marks.structurePen, paths: [], diagnostic: true },
  ];
}
