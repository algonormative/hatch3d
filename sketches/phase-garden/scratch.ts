import type { Control, SketchContext } from '../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../src/projection.ts';
import type { PackedDepthBuffer } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';

/**
 * Scratched, hand-cut line treatment for plotted artwork, applied to visible runs after projection
 * and hidden-line removal (in depth-pixel space, with depth). Breaks only ever remove ink, and every
 * mark it adds (overshoots, re-strikes) is depth-tested again, so nothing hidden is revealed.
 * Each line family has its own character:
 * - `edge`: outlines overshoot past real corners, wobble slightly, and are sometimes struck twice
 *   0.15–0.3 mm apart.
 * - `hatch`: courses break into irregular dashes; some are cut short, a few skipped, a few slipped
 *   along their own direction. Hatch never moves sideways, so course spacing is unchanged.
 * - `membrane`: sparse short breaks and a faint wobble, so the laminations stay readable.
 */
export type LineFamily = 'edge' | 'hatch' | 'membrane';

export function lineRoughControls(): Control[] {
  return [
    { type: 'slider', id: 'lineRough', label: 'Line scratch', default: 0, min: 0, max: 1, step: 0.005, group: 'Scratch' },
  ];
}

export function lineRough(ctx: SketchContext): number {
  const v = ctx.params.lineRough;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** An independent stream per stroke, from the piece seed and a stream name, so other controls never shift it. */
export function scratchRandom(seed: number, stream: string, index: number): () => number {
  let h = 2166136261;
  for (const c of `${seed}\u0000${stream}\u0000${index}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScratchEnv {
  /** Shared depth buffer; without one every mark counts as visible (for flat audits only). */
  depth?: PackedDepthBuffer;
  bias: number;
  /** Final page millimetres per depth pixel. */
  mmPerPx: number;
}

const lerp = (a: ProjectedPoint, b: ProjectedPoint, t: number): ProjectedPoint =>
  ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, depth: a.depth + (b.depth - a.depth) * t });

function arclengths(run: ProjectedPoint[]): number[] {
  const s = [0];
  for (let i = 1; i < run.length; i++) s.push(s[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y));
  return s;
}

/** The sub-run between arclengths a and b (pixels). */
function cut(run: ProjectedPoint[], s: number[], a: number, b: number): ProjectedPoint[] {
  const out: ProjectedPoint[] = [];
  for (let i = 1; i < run.length; i++) {
    const s0 = s[i - 1], s1 = s[i];
    if (s1 <= a || s0 >= b || s1 - s0 < 1e-12) continue;
    if (!out.length) out.push(lerp(run[i - 1], run[i], Math.max(0, (a - s0) / (s1 - s0))));
    out.push(lerp(run[i - 1], run[i], Math.min(1, (b - s0) / (s1 - s0))));
  }
  return out;
}

/** Points sampled about one pixel apart, so depth tests and wobble act everywhere along a mark. */
function dense(points: ProjectedPoint[]): ProjectedPoint[] {
  const out: ProjectedPoint[] = points.length ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)));
    for (let k = 1; k <= n; k++) out.push(lerp(points[i - 1], points[i], k / n));
  }
  return out;
}

/** The visible runs of an added mark under the shared depth buffer. */
function visible(env: ScratchEnv, mark: ProjectedPoint[]): ProjectedPoint[][] {
  return env.depth ? splitPolylineByDepth(dense(mark), env.depth, env.bias).visible : [dense(mark)];
}

/** The leading visible part of an extension that starts at a visible point. */
function visiblePrefix(env: ScratchEnv, mark: ProjectedPoint[]): ProjectedPoint[] {
  const pts = dense(mark);
  const depth = env.depth;
  if (!depth) return pts;
  let n = 0;
  while (n < pts.length && splitPolylineByDepth([pts[n], pts[n]], depth, env.bias).visible.length) n++;
  return pts.slice(0, n);
}

/** A smooth sideways wobble of amplitude `amp` pixels, wavelengths of a few millimetres. */
function wobble(run: ProjectedPoint[], amp: number, rng: () => number, env: ScratchEnv, scale = 1): ProjectedPoint[] {
  if (amp <= 0 || run.length < 2) return run;
  const pts = dense(run);
  const s = arclengths(pts);
  const l1 = (3 + 4 * rng()) * scale / env.mmPerPx, l2 = (1.2 + 1.5 * rng()) * scale / env.mmPerPx;
  const p1 = rng() * 6.28, p2 = rng() * 6.28;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const o = amp * (0.65 * Math.sin(s[i] / l1 * 6.28 + p1) + 0.35 * Math.sin(s[i] / l2 * 6.28 + p2));
    return { x: p.x - (b.y - a.y) / len * o, y: p.y + (b.x - a.x) / len * o, depth: p.depth };
  });
}

/** Uneven dashes over [0, total] px, total gap capped at `cap` of the length. */
function dashes(total: number, rng: () => number, mm: number, dashMm: [number, number], gapMm: [number, number], chance: number, cap: number): [number, number][] {
  const out: [number, number][] = [];
  let at = 0, gaps = 0;
  while (at < total) {
    const end = Math.min(total, at + (dashMm[0] + (dashMm[1] - dashMm[0]) * rng()) / mm);
    const last = out.at(-1);
    if (last && Math.abs(last[1] - at) < 1e-9) last[1] = end; else out.push([at, end]);
    const gap = (gapMm[0] + (gapMm[1] - gapMm[0]) * rng()) / mm;
    if (end < total && rng() < chance && gaps + gap <= cap * total && total - end > gap) { gaps += gap; at = end + gap; } else at = end;
  }
  return out;
}

/** The visible overshoot past one end of a line (points after the end), possibly empty. */
function overshoot(env: ScratchEnv, line: ProjectedPoint[], end: 0 | 1, r: number, rng: () => number, scale = 1, cap = Infinity): ProjectedPoint[] {
  if (line.length < 2 || rng() > 0.3 + 0.55 * r) return [];
  const tip = end ? line[line.length - 1] : line[0];
  const back = end ? line[Math.max(0, line.length - 4)] : line[Math.min(line.length - 1, 3)];
  const len = Math.hypot(tip.x - back.x, tip.y - back.y);
  if (len < 1e-9) return [];
  const o = Math.min(cap, (0.4 + 1.4 * rng()) * r * scale) / env.mmPerPx;
  if (o <= 0) return [];
  const ext = { x: tip.x + (tip.x - back.x) / len * o, y: tip.y + (tip.y - back.y) / len * o,
    depth: tip.depth + (tip.depth - back.depth) / len * o };
  return visiblePrefix(env, [tip, ext]).slice(1);
}

/** Split a run at corners sharper than about 25°, keeping the corner point on both legs. */
function corners(run: ProjectedPoint[]): ProjectedPoint[][] {
  const pts = dense(run);
  if (pts.length < 8) return [run];
  const dir = (a: ProjectedPoint, b: ProjectedPoint) => Math.atan2(b.y - a.y, b.x - a.x);
  const legs: ProjectedPoint[][] = [];
  let start = 0;
  for (let i = 3; i < pts.length - 3; i++) {
    let turn = Math.abs(dir(pts[i], pts[i + 3]) - dir(pts[i - 3], pts[i]));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > 0.45 && i - start > 3) { legs.push(pts.slice(start, i + 1)); start = i; i += 3; }
  }
  legs.push(pts.slice(start));
  return legs.filter(l => l.length > 1);
}

/**
 * Scratch one visible run. `natural` says whether each end is the stroke's own end (a real corner)
 * rather than an occlusion or clip cut; only natural ends overshoot.
 */
/**
 * Size of the hand for a family: `scale` multiplies every absolute distance (wobble, overshoot,
 * break and re-strike); the minimums keep a mark at least a pen width wide so it still reads.
 */
export interface ScratchScale {
  scale?: number; minStrikeMm?: number; minGapMm?: number; maxOvershootMm?: number;
  /** Strokes shorter than this (dots, ticks) never overshoot. */
  minOvershootRunMm?: number;
}

export function scratchRun(run: ProjectedPoint[], family: LineFamily, rough: number, rng: () => number,
  natural: [boolean, boolean], env: ScratchEnv, size: ScratchScale = {}): ProjectedPoint[][] {
  if (rough <= 0 || run.length < 2) return [run];
  const mm = env.mmPerPx;
  const r = rough;
  const total = arclengths(run).at(-1)!;
  if (family === 'hatch') {
    // Skipped courses keep at least the first dash, so a slab face never goes blank in one place.
    if (rng() < 0.18 * r && total * mm > 3) return [cut(run, arclengths(run), 0, Math.min(total, (0.8 + 0.8 * rng()) / mm))];
    let a = 0, b = total;
    if (rng() < 0.45 * r) b = total * (0.45 + 0.4 * rng());
    if (rng() < 0.25 * r) a = total * 0.3 * rng();
    // A slipped course: the whole dash pattern shifted along its own direction.
    const slip = rng() < 0.25 * r ? (0.3 + 0.7 * rng()) / mm * (rng() < 0.5 ? -1 : 1) : 0;
    const s = arclengths(run);
    const out: ProjectedPoint[][] = [];
    for (const [d0, d1] of dashes(b - a, rng, mm, [1.5, 6], [0.45, 1.3], 0.15 + 0.3 * r, 0.35)) {
      const lo = Math.max(0, Math.min(total, a + d0 + slip)), hi = Math.max(0, Math.min(total, a + d1 + slip));
      if (hi - lo > 1e-6) out.push(cut(run, s, lo, hi));
    }
    return out.filter(p => p.length > 1);
  }
  if (family === 'membrane') {
    const w = wobble(run, 0.025 * r / mm, rng, env);
    const s = arclengths(w);
    const out = dashes(s.at(-1)!, rng, mm, [4, 14], [0.3, 0.8], 0.25 * r, 0.15).map(([a, b]) => cut(w, s, a, b));
    return out.filter(p => p.length > 1);
  }
  // Edges (and lettering, which is ruled with this same hand at its own scale): each straight leg
  // between real corners is cut separately, so every corner can overshoot. At interior corners the
  // pen runs past and comes back (a short retrace), so an outline stays one path; open ends
  // overshoot only when they are the stroke's own ends. Rare pen lifts break the line.
  const k = size.scale ?? 1;
  const reach = total * mm < (size.minOvershootRunMm ?? 0) ? 0 : size.maxOvershootMm;
  const legs = corners(run);
  let line: ProjectedPoint[] = [];
  legs.forEach(leg => {
    const w = wobble(leg, 0.1 * r * k / mm, rng, env, k);
    if (!line.length) { line = w; return; }
    const spur = overshoot(env, line, 1, r, rng, k, reach);
    line = [...line, ...spur, ...[...spur].reverse(), ...w.slice(1)];
  });
  for (const end of [0, 1] as const) {
    if (!natural[end]) continue;
    const spur = overshoot(env, line, end, r, rng, k, reach);
    line = end ? [...line, ...spur] : [...[...spur].reverse(), ...line];
  }
  const ls = arclengths(line);
  const gap = Math.max(size.minGapMm ?? 0, 0.35 * k), gapHi = Math.max(size.minGapMm ?? 0, 0.7 * k);
  const out = dashes(ls.at(-1)!, rng, mm, [6 * k, 20 * k], [gap, gapHi], 0.3 * r, 0.1)
    .map(([a, b]) => cut(line, ls, a, b)).filter(p => p.length > 1);
  if (total * mm > 4 * k && rng() < 0.4 * r) {
    const s = arclengths(line), L = s.at(-1)!;
    const a = L * 0.5 * rng(), b = Math.min(L, a + L * (0.35 + 0.45 * rng()));
    const piece = cut(line, s, a, b);
    if (piece.length > 1) {
      const p0 = piece[0], p1 = piece[piece.length - 1];
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      const nx = -(p1.y - p0.y) / len, ny = (p1.x - p0.x) / len;
      const side = rng() < 0.5 ? -1 : 1;
      const off = () => Math.max(size.minStrikeMm ?? 0, (0.15 + 0.15 * rng()) * k) / mm;
      const o0 = side * off(), o1 = side * off();
      const strike = piece.map((p, i) => {
        const t = i / (piece.length - 1), o = o0 + (o1 - o0) * t;
        return { x: p.x + nx * o, y: p.y + ny * o, depth: p.depth };
      });
      out.push(...visible(env, strike));
    }
  }
  return out;
}

/**
 * Lettering is ruled with the edge hand itself: `scratchRun(…, 'edge', …)` with every distance
 * scaled to the cap height, so a 2.2 mm letter gets proportionally small overshoots and wobble.
 * At an 8 mm cap the marks match slab edges one to one. Re-strikes and pen lifts are held to at
 * least about a pen width so they still read with the fine lettering pen.
 */
export const LETTER_REFERENCE_MM = 8;

export function letterScratchSize(capMm: number, penMm = 0.13): ScratchScale {
  // Overshoots stop at 3.5% of the cap (0.28 grid unit) and dots never overshoot, so an i stem
  // never reaches its dot.
  return { scale: capMm / LETTER_REFERENCE_MM, minStrikeMm: 1.2 * penMm, minGapMm: 1.5 * penMm,
    maxOvershootMm: 0.035 * capMm, minOvershootRunMm: 0.3 * capMm };
}

/** How far ruled lettering marks can sit from the clean glyph strokes, in millimetres. */
export function letterScratchMargin(capMm: number, rough: number, penMm = 0.13): number {
  if (rough <= 0) return 0;
  const k = capMm / LETTER_REFERENCE_MM;
  // Longest overshoot, plus wobble, plus the widest re-strike offset.
  return Math.min(0.035 * capMm, 1.8 * rough * k) + 0.1 * rough * k + Math.max(1.2 * penMm, 0.3 * k);
}

export function scratchLetterRun(run: ProjectedPoint[], rough: number, rng: () => number, env: ScratchEnv, capMm: number): ProjectedPoint[][] {
  return scratchRun(run, 'edge', rough, rng, [true, true], env, letterScratchSize(capMm));
}
