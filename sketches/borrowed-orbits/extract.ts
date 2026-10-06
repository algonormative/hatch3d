import type { Part, Point } from '../../src/sketch/types.ts';
import { clipPolylineToRect } from '../../packages/plot-core/src/clip.ts';
import { cullMinSpacing, subtractConvex } from '../cloud-advection/extract.ts';
import { pointInPolygon } from './layout.ts';
import type { History } from './model.ts';
import type { OrbitStudy, Rect } from './study.ts';

/** RDP tolerance for trails, page mm. */
export const SIMPLIFY_MM = 0.05;
/** Chord error of the guide circles, page mm. */
export const GUIDE_CHORD_MM = 0.05;
/** Taper dash geometry, page mm: dashes shrink and gaps grow toward the tail. */
export const DASH_ON_MAX_MM = 3;
export const DASH_ON_MIN_MM = 0.5;
export const DASH_GAP_MIN_MM = 0.7;
export const DASH_GAP_MAX_MM = 3.5;
/** The pen width `trailMinSpacing` is measured in, page mm. */
export const PEN_WIDTH_MM = 0.25;
/** Resampling step and shortest kept piece for minimum-spacing culling, page mm. */
const CULL_STEP_MM = 0.25;
const CULL_MIN_RUN_MM = 0.4;
/** Pieces shorter than this are dropped as specks, page mm. */
const MIN_PIECE_MM = 0.15;

/** Stateless hash of (seed, a) to [0, 1). */
function hash01(seed: number, a: number): number {
  let h = (seed | 0) ^ Math.imul(a | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const pathLength = (path: Point[]): number =>
  path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

/** Ramer–Douglas–Peucker; endpoints are always kept. */
export function simplify(path: Point[], tolerance: number): Point[] {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = path[a], pb = path[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const sq = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = path[i];
      const t = sq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - pa.x) * dx + (p.y - pa.y) * dy) / sq));
      const d = Math.hypot(p.x - pa.x - t * dx, p.y - pa.y - t * dy);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return path.filter((_p, i) => keep[i] === 1);
}

/** Cut a polyline to its parts outside a simple polygon. Cut points land on the polygon boundary. */
export function clipOutsidePolygon(path: Point[], ring: Point[]): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => { if (current.length >= 2) runs.push(current); current = []; };
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const ts = [0];
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k], r = ring[(k + 1) % ring.length];
      const ex = r.x - p.x, ey = r.y - p.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-15) continue;
      const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den;
      const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    ts.push(1);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-12) continue;
      const pa = lerp(a, b, ts[k]), pb = lerp(a, b, ts[k + 1]);
      if (!pointInPolygon(ring, lerp(a, b, (ts[k] + ts[k + 1]) / 2))) {
        if (current.length === 0) current.push(pa);
        current.push(pb);
      } else flush();
    }
  }
  flush();
  return runs;
}

/** Parallel lines clipped to a simple polygon, on a global lattice so hatching registers across members. */
export function hatchPolygon(ring: Point[], angle: number, pitch: number): Point[][] {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const nx = -dy, ny = dx;
  const offsets = ring.map(p => p.x * nx + p.y * ny);
  const lo = Math.min(...offsets), hi = Math.max(...offsets);
  const lines: Point[][] = [];
  for (let k = Math.ceil(lo / pitch); k * pitch < hi; k++) {
    const off = k * pitch + 1e-9;
    const along: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const va = a.x * nx + a.y * ny - off, vb = b.x * nx + b.y * ny - off;
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      along.push((a.x + (b.x - a.x) * t) * dx + (a.y + (b.y - a.y) * t) * dy);
    }
    along.sort((p, q) => p - q);
    for (let i = 0; i + 1 < along.length; i += 2) {
      if (along[i + 1] - along[i] < pitch * 0.15) continue;
      const base = { x: nx * off, y: ny * off };
      lines.push([{ x: base.x + dx * along[i], y: base.y + dy * along[i] }, { x: base.x + dx * along[i + 1], y: base.y + dy * along[i + 1] }]);
    }
  }
  return lines;
}

/** The part of a polyline between arc lengths `s0` and `s1` (art units). Vertices inside the interval are kept as they are; the ends are interpolated, except that an end at the path's own end is its last vertex exactly. */
function slice(path: Point[], cum: number[], s0: number, s1: number): Point[] {
  const total = cum[cum.length - 1];
  const at = (s: number): Point => {
    if (s <= 0) return path[0];
    if (s >= total) return path[path.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const t = (s - cum[lo]) / (cum[hi] - cum[lo]);
    return { x: path[lo].x + (path[hi].x - path[lo].x) * t, y: path[lo].y + (path[hi].y - path[lo].y) * t };
  };
  const out: Point[] = [at(s0)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(path[i]);
  out.push(at(s1));
  return out;
}

/**
 * Break the oldest `taper` fraction of a trail into dashes that get shorter and sparser toward the tail:
 * a pen fading out. Dash lengths are page mm, interpolated by position in the faded region; `phase` (0..1) offsets
 * the first dash. The newest part of the trail stays solid and the head is its last vertex exactly.
 */
export function taperTrail(path: Point[], taper: number, phase: number, artToMm: number): Point[][] {
  if (path.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [];
  const faded = Math.max(0, Math.min(1, taper)) * total;
  if (faded <= 0) return [path];
  const mm = 1 / artToMm; // art units per page mm
  const pieces: [number, number][] = [];
  let s = -phase * (DASH_ON_MAX_MM + DASH_GAP_MAX_MM) * mm;
  while (s < faded) {
    const u = Math.max(0, Math.min(1, s / faded));
    const on = (DASH_ON_MIN_MM + (DASH_ON_MAX_MM - DASH_ON_MIN_MM) * u) * mm;
    const gap = (DASH_GAP_MAX_MM + (DASH_GAP_MIN_MM - DASH_GAP_MAX_MM) * u) * mm;
    const a = Math.max(0, s), b = Math.min(s + on, faded);
    if (b > a) pieces.push([a, b]);
    s += on + gap;
  }
  // The head is always drawn. The final piece starts at the faded boundary, or one minimum dash before the head if
  // that is earlier, so a gap straddling the head (taper 1) cannot erase it; a dash reaching that start runs on.
  const headStart = Math.max(0, Math.min(faded, total - DASH_ON_MIN_MM * mm));
  while (pieces.length > 0 && pieces[pieces.length - 1][0] > headStart) pieces.pop();
  const last = pieces[pieces.length - 1];
  if (last && last[1] >= headStart) last[1] = total;
  else pieces.push([headStart, total]);
  return pieces.map(([a, b]) => slice(path, cum, a, b));
}

/** A closed circle as a polyline, first point repeated; the segment count keeps the chord error under `chordMm`. */
export function circlePath(centre: Point, radius: number, radiusMm: number, chordMm: number): Point[] {
  const n = Math.max(24, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - chordMm / Math.max(radiusMm, chordMm * 2)))));
  const out = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) };
  });
  return [...out, { ...out[0] }];
}

const clipRect = (paths: Point[][], frame: Rect): Point[][] => paths.flatMap(path => clipPolylineToRect(path, frame));

export interface Trail {
  /** Particle index. */
  index: number;
  /** Art-space polyline from the window start (or the particle's seed) to the print step, ending at the stop point for a stopped particle. */
  path: Point[];
}

/**
 * One art-space polyline per particle over the history window. A captured or escaped particle's polyline ends
 * at its stop point (the position at `stoppedAt`); one that stopped before the window draws nothing.
 */
export function particleTrails(study: OrbitStudy, history: History): Trail[] {
  const trails: Trail[] = [];
  const count = history.final.px.length;
  const last = history.xs.length - 1;
  for (let i = 0; i < count; i++) {
    const stop = history.final.stoppedAt[i];
    let end = last;
    if (stop >= 0) {
      if (stop < history.fromStep) continue;
      end = Math.min(last, stop - history.fromStep);
    }
    const path: Point[] = [];
    for (let k = 0; k <= end; k++) path.push(study.worldToArt({ x: history.xs[k][i], y: history.ys[k][i] }));
    if (path.length >= 2) trails.push({ index: i, path });
  }
  return trails;
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9]/g, '_');

/**
 * Final trail marks: simplify, taper into dashes, clip to the poster frame, then optionally thin stacked ropes.
 * Returns art-space runs with the particle index each came from.
 */
export function trailMarks(study: OrbitStudy, history: History): { paths: Point[][]; origin: number[] } {
  const { fit, frame, marks } = study;
  const tolerance = SIMPLIFY_MM / fit.scale;
  let runs: Point[][] = [];
  let origin: number[] = [];
  for (const trail of particleTrails(study, history)) {
    const path = simplify(trail.path, tolerance);
    const pieces = taperTrail(path, marks.taper, hash01(marks.dashSeed, trail.index), fit.scale);
    for (const piece of pieces) for (const run of clipPolylineToRect(piece, frame)) {
      if (pathLength(run) * fit.scale < MIN_PIECE_MM) continue;
      runs.push(run);
      origin.push(trail.index);
    }
  }
  if (study.trailMinSpacing > 0) {
    // Culling sees the final ink (after taper and clip), so removed ink never blocks anything.
    const dmin = (study.trailMinSpacing * PEN_WIDTH_MM) / fit.scale;
    // Culling resamples every CULL_STEP_MM; simplify again so the thinned ink does not carry the dense samples.
    runs = cullMinSpacing(runs, origin, dmin, CULL_STEP_MM / fit.scale, CULL_MIN_RUN_MM / fit.scale).map(run => simplify(run, tolerance));
    origin = [];
  }
  return { paths: runs, origin };
}

/** Drawn-only guides: exact circles about the apparent centre, cut where a forbidden solid stands, clipped to the frame. */
export function guidePaths(study: OrbitStudy): Point[][] {
  const { guides, fit, frame, pageMmPerM } = study;
  const centre = study.worldToArt(guides.centre);
  const captures = study.forbidden.map(member => member.capture.map(study.worldToArt));
  return guides.radii.flatMap(radius => {
    let runs: Point[][] = [circlePath(centre, radius * pageMmPerM / fit.scale, radius * pageMmPerM, GUIDE_CHORD_MM)];
    for (const ring of captures) runs = runs.flatMap(run => clipOutsidePolygon(run, ring));
    return clipRect(runs, frame);
  });
}

/** Outline and parallel hatch of every forbidden solid, art space. Convex members hide earlier convex ones where they overlap. */
export function forbiddenDrawings(study: OrbitStudy): { outline: Point[][]; hatch: Point[][] } {
  const rings = study.forbidden.map(member => member.polygon.map(study.worldToArt));
  const pitch = Math.max(study.hatchPitch, 0.05) / study.fit.scale;
  const outline: Point[][] = [];
  const hatch: Point[][] = [];
  study.forbidden.forEach((member, i) => {
    let o: Point[][] = [[...rings[i], { ...rings[i][0] }]];
    let h = hatchPolygon(rings[i], Math.PI / 4, pitch);
    if (member.convex) {
      for (let j = i + 1; j < rings.length; j++) {
        if (!study.forbidden[j].convex) continue;
        o = o.flatMap(path => subtractConvex(path, rings[j]));
        h = h.flatMap(path => subtractConvex(path, rings[j]));
      }
    }
    outline.push(...clipRect(o, study.frame));
    hatch.push(...clipRect(h, study.frame));
  });
  return { outline, hatch };
}

/**
 * Draw one history. All coordinates are art coordinates; composePoster maps them to the page. With `history`
 * null (orbits off) only the guides and forbidden solids are drawn and nothing about the simulation is needed.
 */
export function extractMarks(study: OrbitStudy, history: History | null): Part[] {
  const { marks } = study;
  const forbidden = forbiddenDrawings(study);
  const parts: Part[] = [
    { id: 'guides', pen: marks.guidePen, paths: study.drawGuides ? guidePaths(study) : [] },
    { id: 'forbidden-outline', pen: marks.structurePen, paths: forbidden.outline },
    { id: 'forbidden-hatch', pen: marks.structurePen, paths: forbidden.hatch },
  ];
  if (history === null) return [...parts, { id: 'orbit-state-off', pen: marks.structurePen, paths: [], diagnostic: true }];
  return [
    ...parts,
    { id: 'trails', pen: marks.trailPen, paths: trailMarks(study, history).paths },
    { id: orbitStateId(history), pen: marks.structurePen, paths: [], diagnostic: true },
  ];
}

/** Diagnostic part id: carries snapshot identity into result.json. Ids may not hold spaces or `=`. */
export function orbitStateId(history: History): string {
  return `orbit-state-step-${history.toStep}-key-${safe(history.final.hashes.stateKey)}`;
}

const STATE_ID = /^orbit-state-step-(\d+)-key-([A-Za-z0-9_]+)$/;
export function parseOrbitStateId(id: string): { step: number; stateKey: string } | null {
  const m = STATE_ID.exec(id);
  return m ? { step: Number(m[1]), stateKey: m[2] } : null;
}
