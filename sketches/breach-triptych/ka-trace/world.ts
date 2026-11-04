import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { thinRanked } from '../../kit/density.ts';
import { sharpenCorners, simplifyRing, traceMask } from '../../kit/outline.ts';
import { clipToRect, insideRing, keepAlong, pathLength } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { measureStrokeText, strokeText, type StrokeFace } from '../../../src/sketch/stroke-text.ts';
import { distanceToRings, offsetRing, ringsSimple } from '../../../src/sketch/region.ts';
import { ALONGSIDE_DEG, LINE_PITCH } from '../lodestone-world.ts';
import { ART, PAGE, TRIM } from '../world.ts';
import { hiddenFace } from './hidden-face.ts';
import { FIGURES, type Figure, type Px, type SloganSpot, type Stream, type Trace } from './figures.ts';

/**
 * Kawaii Aggro's composing: a traced figure (its flowing lines and cuts) under Upward Erasure's language. Parts of the
 * body become plates, each with lines of its own direction; the magenta is partly covered, by plates of black ink and by
 * whatever of the drawing passes behind a window; and the whole sheet is taken apart in slices and streams of columns.
 *
 * Every line is routed the same way once it has been slid through its slice: on the black sheet where it is outside a
 * window, in black on the magenta sheet where it is inside one.
 */

type Pen = 'silver' | 'gold' | 'black';
export interface Stroke { pen: Pen; rank: number; piece: Point[]; backOnly?: boolean; frontOnly?: boolean; local?: boolean }
interface Cell { ring: Point[]; kind: 'flow' | 'hatch' | 'cross' | 'bare'; angle: number }

const MM = (PAGE.height - 2 * TRIM.y0) / 1536, X0 = (PAGE.width - 1024 * MM) / 2;
export const at = ([x, y]: Px): Point => ({ x: X0 + x * MM, y: TRIM.y0 + y * MM });
const deg = (d: number) => d * Math.PI / 180;

export const num = (ctx: SketchContext, id: string, d: number, min: number, max: number) => n(ctx, id, d, min, max);
const P = (ctx: SketchContext) => ({
  plateMm: num(ctx, 'plateMm', 30, 12, 90), hatchMm: num(ctx, 'hatchMm', 1.5, 0.8, 5), bare: num(ctx, 'bareShare', 0.12, 0, 0.8), cross: num(ctx, 'crossShare', 0.2, 0, 0.8),
  flow: num(ctx, 'flowShare', 0.4, 0, 1), swing: num(ctx, 'plateSwing', 0.8, 0, 1.6),
  colourMm: num(ctx, 'colourPlateMm', 46, 14, 120), inkShare: num(ctx, 'inkShare', 0.6, 0, 1), inkMm: num(ctx, 'inkMm', 2.2, 0.8, 6),
  visorMm: num(ctx, 'visorPlateMm', 22, 8, 70), visorInk: num(ctx, 'visorInk', 0.55, 0, 1),
  sliceShare: num(ctx, 'sliceShare', 0.32, 0, 1), shiftMm: num(ctx, 'shiftMm', 30, 0, 80), sliceMin: num(ctx, 'sliceMin', 1.6, 1, 8), sliceMax: num(ctx, 'sliceMax', 20, 3, 60), faceCap: num(ctx, 'faceCap', 5, 0, 30),
  visorShift: num(ctx, 'visorShift', 14, 0, 70), visorSlices: num(ctx, 'visorSlices', 0.34, 0, 1), bites: num(ctx, 'visorBites', 0.45, 0, 3), facePitch: num(ctx, 'facePitch', 0.95, 0.8, 3), facePlate: num(ctx, 'facePlate', 25, 10, 60), faceCross: num(ctx, 'faceCross', 0.3, 0, 1),
  reach: num(ctx, 'reach', 1, 0, 2), colMin: num(ctx, 'colMin', 3.5, 2, 12), colMax: num(ctx, 'colMax', 15, 4, 40), gaps: num(ctx, 'colGaps', 0.32, 0, 0.9), pieces: num(ctx, 'pieces', 0.6, 0, 1.5), fragments: num(ctx, 'fragments', 1, 0, 3), streaks: num(ctx, 'streaks', 1, 0, 3),
});
type Params = ReturnType<typeof P>;

// ── Plates ───────────────────────────────────────────────────────────

/** The half of a convex ring on the side of the line through `q` that `normal` points away from. */
function clipHalf(ring: Point[], q: Point, normal: Point): Point[] {
  const out: Point[] = [], side = (p: Point) => (p.x - q.x) * normal.x + (p.y - q.y) * normal.y;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa <= 0 !== sb <= 0) { const t = sa / (sa - sb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}
/** Convex cells of `region` about scattered seeds, `groove` mm apart: the region's plates (a cell may run past its edge). */
function platesOf(region: Point[], sizeMm: number, groove: number, rng: () => number): Point[][] {
  const xs = region.map(p => p.x), ys = region.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const seeds: Point[] = [];
  for (let tries = 0; tries < 900; tries++) {
    const p = { x: x0 + rng() * (x1 - x0), y: y0 + rng() * (y1 - y0) };
    if (insideRing(region, p) && seeds.every(s => Math.hypot(s.x - p.x, s.y - p.y) > sizeMm * 0.8)) seeds.push(p);
  }
  if (!seeds.length) seeds.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  const big: Point[] = [{ x: x0 - 5, y: y0 - 5 }, { x: x1 + 5, y: y0 - 5 }, { x: x1 + 5, y: y1 + 5 }, { x: x0 - 5, y: y1 + 5 }];
  return seeds.map(s => seeds.reduce((ring, o) => {
    if (o === s) return ring;
    const dx = o.x - s.x, dy = o.y - s.y, d = Math.hypot(dx, dy);
    return clipHalf(ring, { x: s.x + dx / 2 - dx / d * groove / 2, y: s.y + dy / 2 - dy / d * groove / 2 }, { x: dx / d, y: dy / d });
  }, big)).filter(r => r.length >= 3);
}
/** Parallel lines across a convex ring. */
function hatch(ring: Point[], angle: number, pitch: number): Point[][] {
  const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux, out: Point[][] = [];
  const vs = ring.map(p => p.x * vx + p.y * vy), v0 = Math.min(...vs), v1 = Math.max(...vs);
  for (let v = v0 + pitch / 2; v < v1; v += pitch) {
    let t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], va = a.x * vx + a.y * vy, vb = b.x * vx + b.y * vy;
      if (va < v !== vb < v) {
        const k = (v - va) / (vb - va), t = (a.x + (b.x - a.x) * k) * ux + (a.y + (b.y - a.y) * k) * uy;
        t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      }
    }
    if (t0 < t1) out.push([{ x: t0 * ux + v * vx, y: t0 * uy + v * vy }, { x: t1 * ux + v * vx, y: t1 * uy + v * vy }]);
  }
  return out;
}
const closed = (ring: Point[]) => [...ring, ring[0]];
/** A Catmull-Rom curve through the points; its ends stay, and the last straight edge closes it. */
function spline(pts: Point[], steps = 16): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[i + 1], d = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (u: number, v: number, w: number, z: number) => 0.5 * (2 * v + (w - u) * t + (2 * u - 5 * v + 4 * w - z) * t2 + (3 * v - u - 3 * w + z) * t3);
      out.push({ x: f(a.x, b.x, c.x, d.x), y: f(a.y, b.y, c.y, d.y) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const within = (ring: Point[], keep: (p: Point) => boolean): Point[][] => keepAlong(ring, keep, 0.25);

/** A region's plates and their lines: on the black sheet in silver and gold, on the magenta in black. */
function platesIn(region: Point[], size: number, base: number, p: Params, kinds: { flow: number; bare: number; cross: number }, ink: { line: Pen; seam: Pen; pitch: number }, rng: () => number): { cells: Cell[]; strokes: Stroke[] } {
  const cells: Cell[] = platesOf(region, size, 1.2, rng).map(ring => {
    const r = rng(), kind: Cell['kind'] = r < kinds.flow ? 'flow' : r < kinds.flow + kinds.bare ? 'bare' : r < kinds.flow + kinds.bare + kinds.cross ? 'cross' : 'hatch';
    return { ring, kind, angle: base + p.swing * (rng() * 2 - 1) };
  });
  const inside = (q: Point) => insideRing(region, q), strokes: Stroke[] = [];
  for (const cell of cells) {
    for (const seam of within(closed(cell.ring), inside)) strokes.push({ pen: ink.seam, rank: 0.5, piece: seam });
    if (cell.kind === 'bare' || cell.kind === 'flow') continue;
    for (const line of hatch(cell.ring, cell.angle, ink.pitch)) for (const piece of within(line, inside)) strokes.push({ pen: ink.line, rank: 3, piece });
    if (cell.kind === 'cross') for (const line of hatch(cell.ring, cell.angle + 1.15, ink.pitch * 1.5)) for (const piece of within(line, inside)) strokes.push({ pen: ink.line, rank: 3.5, piece });
  }
  return { cells, strokes };
}

// ── Streams of columns ───────────────────────────────────────────────

interface StreamArt { rings: Point[][]; strokes: Stroke[] }
/** Columns off a base line, along `dir`: hard-edged, stepping, some lifted free; past them fragments and streaks. */
function streamOf(s: Stream, p: Params, rng: () => number): StreamArt {
  const a = at(s.from), b = at(s.to), len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const dir = { x: Math.cos(deg(s.dir)), y: Math.sin(deg(s.dir)) };
  const reach = s.reachMm * p.reach, rings: Point[][] = [], strokes: Stroke[] = [];
  const rect = (u0: number, u1: number, v0: number, v1: number): Point[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => ({ x: a.x + ux * u + dir.x * v, y: a.y + uy * u + dir.y * v }));
  const line = (u: number, v0: number, v1: number): Point[] => [{ x: a.x + ux * u + dir.x * v0, y: a.y + uy * u + dir.y * v0 }, { x: a.x + ux * u + dir.x * v1, y: a.y + uy * u + dir.y * v1 }];
  const back = s.backMm ?? 0;
  let u = 0;
  while (u < len) {
    const width = (p.colMin + (p.colMax - p.colMin) * rng() ** 1.6) * (s.widths ?? 1), u1 = Math.min(len, u + width);
    const rGap = rng(), rH = rng(), rPiece = rng(), rGapV = rng(), rPieceH = rng(), rStreak = rng(), rStreakU = rng(), rLong = rng();
    const taper = Math.sin(Math.PI * (u + width / 2) / len) ** 0.5;
    if (u1 - u >= 2) {
      const tip = reach * (0.12 + 0.88 * rH ** 1.5) * (0.35 + 0.65 * taper);
      let end = -back;
      if (rGap >= (s.gaps ?? p.gaps)) {
        rings.push(rect(u, u1, -back, tip));
        end = tip;
      }
      if (rPiece < p.pieces) {
        // A piece lifted free of its column.
        const v0 = end + 3 + rGapV * reach * 0.3, v1 = v0 + 4 + rPieceH * Math.min(26, reach * 0.3);
        if (v1 < reach * 1.35) rings.push(rect(u, u1, v0, v1));
        end = v1;
      }
      if (rStreak < 0.55 * p.streaks) {
        const su = u + rStreakU * (u1 - u);
        strokes.push({ pen: rLong < 0.2 ? 'gold' : 'silver', rank: 2, piece: line(su, end + 2, end + 2 + reach * (0.2 + 1.2 * rLong)) });
      }
    }
    u = u1;
  }
  // Fragments out past the columns: some cut, some only an outline with lines in it.
  const count = Math.round(len / 9 * p.fragments * (s.fragments ?? 1));
  for (let i = 0; i < count; i++) {
    const u0 = rng() * len, v0 = reach * (0.45 + 0.9 * rng()), w = 3.5 + 13 * rng() ** 1.5, h = 3.5 + 11 * rng() ** 1.5, kind = rng(), rA = rng();
    const ring = rect(u0, u0 + w, v0, v0 + h);
    if (kind < 0.42) { rings.push(ring); continue; }
    strokes.push({ pen: 'gold', rank: 0.5, piece: closed(ring), frontOnly: true });
    if (kind > 0.6) for (const l of hatch(ring, rA * Math.PI, 1.2 + rA)) strokes.push({ pen: 'silver', rank: 2.5, piece: l, frontOnly: true });
  }
  return { rings, strokes };
}

// ── Slices ───────────────────────────────────────────────────────────

interface Slice { v0: number; v1: number; du: number }
interface SliceFrame { toPage: (u: number, v: number) => Point; toFrame: (q: Point) => { u: number; v: number }; slices: Slice[] }
function slicesOf(f: Figure, p: Params, rng: () => number): SliceFrame {
  const a = deg(f.sliceDeg ?? 0), ux = Math.cos(a), uy = Math.sin(a);
  const toPage = (u: number, v: number): Point => ({ x: ux * u - uy * v, y: uy * u + ux * v });
  const toFrame = (q: Point) => ({ u: q.x * ux + q.y * uy, v: -q.x * uy + q.y * ux });
  const corners = [{ x: 0, y: 0 }, { x: PAGE.width, y: 0 }, { x: PAGE.width, y: PAGE.height }, { x: 0, y: PAGE.height }].map(q => toFrame(q).v);
  const vMax = Math.max(...corners), slices: Slice[] = [];
  const face = f.face ? f.face.map(q => toFrame(at(q)).v) : undefined;
  for (let v = Math.min(...corners); v < vMax;) {
    const rT = rng(), rA = rng(), rS = rng();
    const least = Math.max(p.sliceMin, f.sliceMinMm ?? 0), v1 = Math.min(vMax, v + least + (p.sliceMax - least) * rT ** 2.2);
    const onFace = face && v1 > Math.min(...face) && v < Math.max(...face);
    const signed = rS * 2 - 1, raw = Math.sign(signed) * Math.abs(signed) ** 1.5 * p.shiftMm;
    const share = p.sliceShare * (onFace ? f.faceShare ?? 1 : 1);
    slices.push({ v0: v, v1, du: rA < share ? (onFace ? Math.max(-p.faceCap, Math.min(p.faceCap, raw)) : raw) : 0 });
    v = v1;
  }
  return { toPage, toFrame, slices };
}
const sliceAt = (slices: Slice[], v: number): number => {
  let lo = 0, hi = slices.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (slices[mid].v0 <= v) lo = mid; else hi = mid - 1; }
  return lo;
};
/** A line cut at the slices' edges, each piece slid with its slice. */
function slid(piece: Point[], f: SliceFrame): Point[][] {
  const out: Point[][] = [], q = piece.map(f.toFrame);
  let k = sliceAt(f.slices, q[0].v), run: { u: number; v: number }[] = [q[0]];
  const flush = () => { if (run.length >= 2) out.push(run.map(r => f.toPage(r.u + f.slices[k].du, r.v))); };
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1], b = q[i], kb = sliceAt(f.slices, b.v);
    while (k !== kb) {
      const up = kb > k, edge = up ? f.slices[k + 1].v0 : f.slices[k].v0, t = (edge - a.v) / (b.v - a.v);
      const cut = { u: a.u + (b.u - a.u) * t, v: edge };
      run.push(cut); flush();
      k += up ? 1 : -1; run = [cut];
    }
    run.push(b);
  }
  flush();
  return out;
}

/** The visor's own slices: thin and many, moving far, only across the visor and just past it. */
function fieldSlices(f: Figure, visor: Point[], p: Params, rng: () => number): SliceFrame & { bounds: { u0: number; u1: number; v0: number; v1: number } } {
  const a = deg(f.field!.deg), ux = Math.cos(a), uy = Math.sin(a);
  const toPage = (u: number, v: number): Point => ({ x: ux * u - uy * v, y: uy * u + ux * v });
  const toFrame = (q: Point) => ({ u: q.x * ux + q.y * uy, v: -q.x * uy + q.y * ux });
  const qs = visor.map(toFrame), v0 = Math.min(...qs.map(q => q.v)) - 45, v1 = Math.max(...qs.map(q => q.v)) + 25;
  const slices: Slice[] = [{ v0: -1e5, v1: v0, du: 0 }];
  for (let v = v0; v < v1;) {
    const rT = rng(), rA = rng(), rS = rng(), e = Math.min(v1, v + 2.5 + 20 * rT ** 1.6);
    const signed = rS * 2 - 1;
    slices.push({ v0: v, v1: e, du: rA < p.visorSlices ? Math.sign(signed) * Math.abs(signed) ** 1.4 * p.visorShift : 0 });
    v = e;
  }
  slices.push({ v0: v1, v1: 1e5, du: 0 });
  return { toPage, toFrame, slices, bounds: { u0: Math.min(...qs.map(q => q.u)), u1: Math.max(...qs.map(q => q.u)), v0: Math.min(...qs.map(q => q.v)), v1: Math.max(...qs.map(q => q.v)) } };
}
/** Square bites out of the visor's long edges. */
function bitesOf(visor: Point[], f: SliceFrame, p: Params, rng: () => number): Point[][] {
  const qs = visor.map(f.toFrame), u0 = Math.min(...qs.map(q => q.u)), u1 = Math.max(...qs.map(q => q.u)), v0 = Math.min(...qs.map(q => q.v)), v1 = Math.max(...qs.map(q => q.v));
  const out: Point[][] = [], count = Math.round((u1 - u0) / 11 * p.bites);
  for (let i = 0; i < count; i++) {
    const u = u0 + rng() * (u1 - u0), w = 3 + 12 * rng() ** 1.6, d = 2.5 + 8 * rng() ** 1.4, lower = rng() < 0.6;
    const a = lower ? v1 - d : v0 - 1, b = lower ? v1 + 1 : v0 + d;
    out.push([f.toPage(u, a), f.toPage(u + w, a), f.toPage(u + w, b), f.toPage(u, b)]);
  }
  return out;
}

/** Lines cut by a window that is no longer there, joined back across it, end to end where they point at each other. */
function healed(lines: Point[][], gaps: Point[][]): Point[][] {
  const out = lines.map(l => l.slice());
  for (const gap of gaps) {
    const xs = gap.map(q => q.x), ys = gap.map(q => q.y), x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
    const near = (q: Point) => q.x > x0 && q.x < x1 && q.y > y0 && q.y < y1;
    const heading = (l: Point[], atEnd: boolean) => {
      const a = atEnd ? l[l.length - 1] : l[0], b = atEnd ? l[Math.max(0, l.length - 4)] : l[Math.min(l.length - 1, 3)], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      return { x: (a.x - b.x) / d, y: (a.y - b.y) / d };
    };
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (!a.length || !near(a[a.length - 1])) continue;
      const end = a[a.length - 1], ha = heading(a, true);
      let best = -1, bestAt = false, bestD = 11;
      for (let j = 0; j < out.length; j++) {
        if (j === i || !out[j].length) continue;
        for (const atEnd of [false, true]) {
          const q = atEnd ? out[j][out[j].length - 1] : out[j][0];
          if (!near(q)) continue;
          const d = Math.hypot(q.x - end.x, q.y - end.y);
          if (d < 0.5 || d >= bestD) continue;
          const toward = (q.x - end.x) / d * ha.x + (q.y - end.y) / d * ha.y, hb = heading(out[j], atEnd);
          if (toward > 0.8 && -(ha.x * hb.x + ha.y * hb.y) > 0.75) { best = j; bestAt = atEnd; bestD = d; }
        }
      }
      if (best >= 0) { out[i] = [...a, ...(bestAt ? out[best].slice().reverse() : out[best])]; out[best] = []; i--; }
    }
  }
  return out.filter(l => l.length >= 2);
}

// ── A mask of the windows, for the many tests along the lines ────────

interface Mask { has: (p: Point) => boolean; grown: (mm: number) => (p: Point) => boolean }
function maskOf(rings: Point[][], cell = 0.25): Mask {
  const nx = Math.ceil(PAGE.width / cell), ny = Math.ceil(PAGE.height / cell), grid = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * cell, cross: number[] = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a.y <= y !== b.y <= y) cross.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    cross.sort((u, v) => u - v);
    for (let k = 0; k + 1 < cross.length; k += 2) grid.fill(1, j * nx + Math.max(0, Math.round(cross[k] / cell)), j * nx + Math.min(nx, Math.round(cross[k + 1] / cell)));
  }
  const dist = new Float32Array(nx * ny).fill(1e6);
  for (let k = 0; k < grid.length; k++) if (grid[k]) dist[k] = 0;
  const relax = (k: number, o: number, c: number) => { if (dist[o] + c < dist[k]) dist[k] = dist[o] + c; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i > 0) relax(k, k - 1, 1);
    if (j > 0) { relax(k, k - nx, 1); if (i > 0) relax(k, k - nx - 1, 1.414); if (i < nx - 1) relax(k, k - nx + 1, 1.414); }
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (i < nx - 1) relax(k, k + 1, 1);
    if (j < ny - 1) { relax(k, k + nx, 1); if (i < nx - 1) relax(k, k + nx + 1, 1.414); if (i > 0) relax(k, k + nx - 1, 1.414); }
  }
  const index = (p: Point) => { const i = Math.floor(p.x / cell), j = Math.floor(p.y / cell); return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i; };
  return {
    has: p => { const k = index(p); return k >= 0 && grid[k] === 1; },
    grown: mm => p => { const k = index(p); return k >= 0 && dist[k] * cell <= mm; },
  };
}

// ── The sheets ───────────────────────────────────────────────────────

export const points = (line: number[][]): Point[] => line.map(([x, y]) => ({ x, y }));
const SHARPEN = { edge: 1.5, run: 3, reach: 1.2 };
/** Half the cut pen's width: a window's guide runs this far inside its edge (mm). */
const GUIDE = 0.175;
/** Whether a window's guide line can be drawn at all: inset by half a pen, its outline must stay simple and stay inside. */
function guided(ring: Point[]): boolean {
  if (!ringsSimple([ring])) return false;
  for (const d of [GUIDE, -GUIDE]) {
    const inset = offsetRing(ring, d);
    if (ringsSimple([inset]) && inset.every(q => insideRing(ring, q) && distanceToRings(q, [ring]) >= GUIDE - 1e-6)) return true;
  }
  return false;
}
/** The window as sharp as its guide allows: sharpened, then as traced, then re-traced round at the knife's radius. */
function forTheKnife(ring: Point[]): Point[][] {
  for (const candidate of [simplifyRing(sharpenCorners(ring, SHARPEN), 0.15), simplifyRing(ring, 0.1), ring]) if (guided(candidate)) return [candidate];
  const xs = ring.map(q => q.x), ys = ring.map(q => q.y), box = { x0: Math.min(...xs) - 1, x1: Math.max(...xs) + 1, y0: Math.min(...ys) - 1, y1: Math.max(...ys) + 1 };
  return traceMask(q => insideRing(ring, q), box, 0.2, { simplify: 0.08, minRadius: 0.8, minArea: 7 }).filter(guided);
}

function partsOf(items: Stroke[], prefix: string, thin: boolean): Part[] {
  const byPen = new Map<string, Point[][]>();
  const put = (pen: string, piece: Point[]) => { if (pathLength(piece) >= 0.6) byPen.set(pen, [...(byPen.get(pen) ?? []), piece]); };
  if (thin) for (const { item, runs } of thinRanked(items, LINE_PITCH.gel, { angle: ALONGSIDE_DEG })) for (const run of runs) put(item.pen, run);
  else for (const item of items) put(item.pen, item.piece);
  return [...byPen].map(([pen, paths]) => ({ id: prefix + '-' + pen, pen, paths }));
}

export interface World { windows: Point[][]; art: { black: Part[]; magenta: Part[] } }

// ── The slogan ───────────────────────────────────────────────────────

const FACES: StrokeFace[] = ['matrix', 'wire', 'sans'];
/** A slogan's lines at its spot, and the boxes that are kept clear for them. */
function sloganAt(spot: SloganSpot, text: string, face: StrokeFace, rng: () => number): { lines: Point[][]; screens: Point[][] } {
  const lay = (words: string, origin: Point, dirDeg: number, size: number, apart: boolean) => {
    const along = { x: Math.cos(deg(dirDeg)), y: Math.sin(deg(dirDeg)) }, down = { x: -along.y, y: along.x };
    const style = { face, height: size }, chars = [...words], lines: Point[][] = [];
    const toPage = (q: Point, ox: number, oy: number): Point => ({ x: origin.x + along.x * (q.x + ox) + down.x * (q.y + oy), y: origin.y + along.y * (q.x + ox) + down.y * (q.y + oy) });
    let drift = 0, width = 0;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const t = chars.length > 1 ? i / (chars.length - 1) : 0, rGone = rng(), rSide = rng(), rGap = rng();
      // Coming apart toward the end: letters drift, then drop out.
      if (apart) drift += t * rGap * size * 0.8;
      if (apart && rGone < 0.65 * t ** 1.8) return;
      const x = measureStrokeText(words.slice(0, i + 1), style) - measureStrokeText(ch, style);
      const oy = apart ? t * t * (rSide * 2 - 1) * size * 1.3 : 0;
      for (const path of strokeText(ch, 0, 0, style)) lines.push(path.map(q => toPage(q, x + drift, oy)));
      width = Math.max(width, x + drift + measureStrokeText(ch, style));
    });
    const m = size * 0.45, screen = [[-m, -m], [width + m, -m], [width + m, size + m], [-m, size + m]].map(([u, v]) => toPage({ x: u, y: v }, 0, 0));
    return { lines, screen };
  };
  const out = { lines: [] as Point[][], screens: [] as Point[][] };
  if (spot.curve) {
    // Along a curve: each letter set on the curve at its place, turned to it; the box a band along the same stretch.
    const path = spline(spot.curve.map(at), 24), lens = [0];
    for (let i = 1; i < path.length; i++) lens.push(lens[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const total = lens[lens.length - 1], w0 = measureStrokeText(text, { face, height: spot.mm }), size = w0 > total ? spot.mm * total / w0 : spot.mm;
    const style = { face, height: size }, width = measureStrokeText(text, style), start = (total - width) / 2;
    const pose = (s: number) => {
      let k = 1;
      while (k < lens.length - 1 && lens[k] < s) k++;
      const a = path[k - 1], b = path[k], t = (s - lens[k - 1]) / (lens[k] - lens[k - 1] || 1), d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, along: { x: (b.x - a.x) / d, y: (b.y - a.y) / d } };
    };
    [...text].forEach((ch, i) => {
      if (ch === ' ') return;
      const w = measureStrokeText(ch, style), x = measureStrokeText(text.slice(0, i + 1), style) - w, m = pose(start + x + w / 2), down = { x: -m.along.y, y: m.along.x };
      for (const line of strokeText(ch, 0, 0, style)) out.lines.push(line.map(q => ({ x: m.p.x + m.along.x * (q.x - w / 2) + down.x * q.y, y: m.p.y + m.along.y * (q.x - w / 2) + down.y * q.y })));
    });
    const up: Point[] = [], low: Point[] = [], margin = size * 0.45;
    for (let k = 0; k <= 40; k++) { const m = pose(start + width * k / 40), down = { x: -m.along.y, y: m.along.x }; up.push({ x: m.p.x - down.x * margin, y: m.p.y - down.y * margin }); low.push({ x: m.p.x + down.x * (size + margin), y: m.p.y + down.y * (size + margin) }); }
    out.screens.push([...up, ...low.reverse()]);
    return out;
  }
  const fit = (words: string, mm: number, room: number) => { const w = measureStrokeText(words, { face, height: mm }); return w > room ? mm * room / w : mm; };
  if (spot.lines) {
    // A word a line, each centred on its spot, set as large as the longest allows.
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const c = at(spot.lines[Math.min(i, spot.lines.length - 1)]), word = i >= spot.lines.length - 1 ? words.slice(i).join(' ') : words[i];
      const size = fit(word, spot.mm, spot.room), w = measureStrokeText(word, { face, height: size });
      const made = lay(word, { x: c.x - w / 2, y: c.y - size / 2 }, spot.dir, size, false);
      out.lines.push(...made.lines); out.screens.push(made.screen);
      if (i >= spot.lines.length - 1) break;
    }
    return out;
  }
  const made = lay(text, at(spot.at), spot.dir, fit(text, spot.mm, spot.room), spot.apart ?? false);
  out.lines.push(...made.lines); out.screens.push(made.screen);
  return out;
}

/** A figure with no treatment: its traced lines and cuts, as they are. */
function plain(trace: Trace, min: number, thin: boolean): World {
  const windows = trace.windows.map(points), mask = maskOf(windows);
  const front: Stroke[] = [...trace.gold.map(l => ['gold', l] as const), ...trace.silver.map(l => ['silver', l] as const)].flatMap(([pen, line]) =>
    clipToRect(points(line), ART).flatMap(l => keepAlong(l, q => !mask.has(q), 0.2)).filter(q => pathLength(q) >= min)
      .map(piece => ({ pen, rank: (pen === 'gold' ? 0 : 1) + 1 / pathLength(piece), piece })));
  const back: Stroke[] = trace.black.map(points).flatMap(l => clipToRect(l, ART)).map(piece => ({ pen: 'black', rank: 1 / pathLength(piece), piece }));
  return { windows, art: { black: partsOf(front, 'black', thin), magenta: partsOf(back, 'magenta', thin) } };
}

export function world(ctx: SketchContext, thin: boolean, preview = false): World {
  const id = String(ctx.params.figure), f = FIGURES[id] ?? FIGURES.collar, min = Number(ctx.params.minLine ?? 1.6);
  if (!f.treated || ctx.params.treatment === 'plain') return plain(f.trace, min, thin);
  const p = P(ctx), rngOf = (name: string) => ctx.random(`ka-${id}-${name}`);
  const frame = slicesOf(f, p, rngOf('slices'));

  // The windows, before the slices: the traced ones, the visor, the streams.
  const visorRing = f.visor?.map(at), base: Point[][] = f.trace.windows.filter((_, i) => !f.dropWindows?.includes(i)).map(points);
  // With a field of its own, the visor and its streams slide apart from the rest of the sheet.
  const local: Point[][] = [], own = f.field ? local : base;
  if (visorRing) own.push(visorRing);
  const strokes: Stroke[] = [];
  f.streams?.forEach((s, i) => { const art = streamOf(s, p, rngOf('stream' + i)); own.push(...art.rings); strokes.push(...art.strokes.map(k => ({ ...k, local: !!f.field }))); });
  const lowerId = String(ctx.params.lower ?? 'picked'), lower = f.lowers?.[lowerId === 'picked' ? f.picks?.lower ?? 'gores' : lowerId];
  const goreRings = f.gores ? f.gores.fills.map((_, i) => [...spline(f.gores!.seams[i].map(at)), ...spline(f.gores!.seams[i + 1].map(at)).reverse()]) : [];
  const lowerRings = [...(lower?.ring ? [lower.ring.map(at)] : []), ...(lower?.gores ?? []).map(i => goreRings[i])];
  base.push(...lowerRings);
  const masses = (f.masses ?? []).map(curve => spline(curve.map(at)));
  base.push(...masses);
  const boxes = base.map(r => ({ x0: Math.min(...r.map(q => q.x)), x1: Math.max(...r.map(q => q.x)), y0: Math.min(...r.map(q => q.y)), y1: Math.max(...r.map(q => q.y)) }));
  const inBase = (q: Point) => {
    let c = false;
    for (let i = 0; i < base.length; i++) { const b = boxes[i]; if (q.x >= b.x0 && q.x <= b.x1 && q.y >= b.y0 && q.y <= b.y1 && insideRing(base[i], q)) c = true; }
    return c;
  };
  // The visor's own slices, and the bites out of its edges.
  const fieldFrame = f.field ? fieldSlices(f, visorRing!, p, rngOf('field')) : undefined;
  const bites = fieldFrame ? bitesOf(visorRing!, fieldFrame, p, rngOf('bites')) : [];
  const inFront = f.field?.inFront?.map(at);
  const inLocal = (q: Point) => local.some(r => insideRing(r, q)) && !bites.some(r => insideRing(r, q));
  const windowAt = (q: Point) => {
    if (q.x <= TRIM.x0 + 0.2 || q.x >= TRIM.x1 - 0.2 || q.y <= TRIM.y0 + 0.2 || q.y >= TRIM.y1 - 0.2) return false;
    const r = frame.toFrame(q);
    if (inBase(frame.toPage(r.u - frame.slices[sliceAt(frame.slices, r.v)].du, r.v))) return true;
    if (!fieldFrame || (inFront && insideRing(inFront, q))) return false;
    const c = fieldFrame.toFrame(q);
    return inLocal(fieldFrame.toPage(c.u - fieldFrame.slices[sliceAt(fieldFrame.slices, c.v)].du, c.v));
  };
  // Traced square to the slices, so their steps keep their corners.
  const cs = [{ x: 0, y: 0 }, { x: PAGE.width, y: 0 }, { x: PAGE.width, y: PAGE.height }, { x: 0, y: PAGE.height }].map(frame.toFrame);
  const box = { x0: Math.min(...cs.map(c => c.u)), x1: Math.max(...cs.map(c => c.u)), y0: Math.min(...cs.map(c => c.v)), y1: Math.max(...cs.map(c => c.v)) };
  const traced = traceMask(q => windowAt(frame.toPage(q.x, q.y)), box, preview ? 0.35 : 0.25, { simplify: 0.08, minRadius: 0.85, minArea: 7, square: true }).map(r => r.map(q => frame.toPage(q.x, q.y)));
  const windows = traced.flatMap(forTheKnife);
  const mask = maskOf(windows);

  // Plates: of the body, of the colour, of the visor.
  const clears: Point[][] = [], under: Point[][] = [];
  const bodies = f.body ?? [];
  bodies.forEach((region, i) => {
    const r = region.ring.map(at), made = platesIn(r, region.plateMm ?? p.plateMm, deg(region.angle ?? 60), p, { flow: region.flow ?? p.flow, bare: region.bare ?? p.bare, cross: p.cross }, { line: 'silver', seam: 'gold', pitch: region.pitch ?? p.hatchMm }, rngOf('body' + i));
    strokes.push(...made.strokes);
    for (const cell of made.cells) if (cell.kind !== 'flow') clears.push(cell.ring);
    under.push(r);
  });
  const inCleared = (q: Point) => under.some(r => insideRing(r, q)) && clears.some(r => insideRing(r, q));
  const colour = [...(f.colour ?? []).map(i => points(f.trace.windows[i])), ...masses];
  colour.forEach((ring, i) => {
    const made = platesIn(ring, masses.includes(ring) ? f.massMm ?? p.colourMm : p.colourMm, deg(f.colourDeg ?? 35), p, { flow: 1 - p.inkShare, bare: 0, cross: p.inkShare * 0.25 }, { line: 'black', seam: 'black', pitch: p.inkMm }, rngOf('colour' + i));
    strokes.push(...made.strokes.map(s => ({ ...s, backOnly: true })));
  });
  // The visor: partly covered. Plates of it are inked, and only those keep what passes behind them.
  const visors = visorRing ? [visorRing] : (f.visorWindows ?? []).map(i => points(f.trace.windows[i])), clearVisor: Point[][] = [];
  if (f.hidden && visorRing) {
    // A hidden face in place of plates of ink: only the lines of it inside the visor (and a little past, as it slides).
    const fit = { noseTip: at(f.hidden.noseTip), chin: at(f.hidden.chin), yaw: f.hidden.yaw, tilt: f.hidden.tilt, plateMm: p.facePlate, pitchMm: p.facePitch, cross: p.faceCross };
    const seen = hiddenFace(ctx, fit, preview ? 0.012 : 0.01);
    const near = (q: Point) => { const c = fieldFrame!.toFrame(q), box = fieldFrame!.bounds; return c.v > box.v0 - 14 && c.v < box.v1 + 14 && c.u > box.u0 - 40 && c.u < box.u1 + 40; };
    for (const [paths, rank] of [[seen.features, 0.4], [seen.seams, 0.8], [seen.lines, 3]] as const) for (const line of paths) for (const piece of keepAlong(line, near, 0.25)) strokes.push({ pen: 'black', rank, piece, backOnly: true, local: true });
  } else for (const visor of visors) {
    const made = platesIn(visor, p.visorMm, deg(f.visorDeg ?? 20), p, { flow: 1 - p.visorInk, bare: 0, cross: p.visorInk * 0.35 }, { line: 'black', seam: 'black', pitch: p.inkMm * 0.75 }, rngOf('visor'));
    strokes.push(...made.strokes.map(s => ({ ...s, backOnly: true })));
    for (const cell of made.cells) if (cell.kind === 'flow') clearVisor.push(cell.ring);
  }
  lowerRings.forEach((ring, i) => {
    const made = platesIn(ring, f.massMm ?? p.colourMm, deg(f.colourDeg ?? 35), p, { flow: 1 - p.inkShare, bare: 0, cross: p.inkShare * 0.25 }, { line: 'black', seam: 'black', pitch: p.inkMm }, rngOf('lower' + i));
    strokes.push(...made.strokes.map(s => ({ ...s, backOnly: true })));
  });
  // The dress: long panels, their seams and neckline in gold, what the skin's lines left behind cleared from under them.
  if (f.gores) {
    goreRings.forEach((ring, i) => {
      const fill = f.gores!.fills[i], inside = (q: Point) => insideRing(ring, q);
      clears.push(ring); under.push(ring);
      if (fill.bare || lower?.gores?.includes(i)) return;
      for (const line of hatch(ring, deg(fill.angle), fill.pitch)) for (const piece of within(line, inside)) strokes.push({ pen: 'silver', rank: 3, piece });
      if (fill.cross) for (const line of hatch(ring, deg(fill.cross), fill.pitch * 1.5)) for (const piece of within(line, inside)) strokes.push({ pen: 'silver', rank: 3.5, piece });
    });
    for (const seam of f.gores.seams) strokes.push({ pen: 'gold', rank: 0, piece: spline(seam.map(at)), frontOnly: true });
    strokes.push({ pen: 'gold', rank: 0, piece: spline(f.gores.neckline.map(at)), frontOnly: true });
  }
  for (const line of f.field?.frontLines ?? []) strokes.push({ pen: 'silver', rank: 0.2, piece: spline(line.map(at)), frontOnly: true });
  const clearedByVisor = (q: Point) => clearVisor.some(r => insideRing(r, q));
  // The traced lines, off the plates that took their place; and what the visor hides, drawn on it.
  const keepTraced = (q: Point) => !inCleared(q) && !clearedByVisor(q);
  const silver = f.heal ? healed(f.trace.silver.map(points), f.heal.map(i => points(f.trace.windows[i]))) : f.trace.silver.map(points);
  for (const [pen, lines] of [['gold', f.trace.gold.map(points)], ['silver', silver], ['black', f.trace.black.map(points)]] as const) for (const line of lines) {
    for (const piece of keepAlong(line, keepTraced, 0.2)) if (pathLength(piece) >= min) strokes.push({ pen: pen === 'black' ? 'silver' : pen, rank: (pen === 'gold' ? 0 : 1) + 1 / pathLength(piece), piece });
  }
  for (const line of f.under ?? []) strokes.push({ pen: 'black', rank: 0.2, piece: spline(line.map(at)), backOnly: true });

  // The slogan: set clean over the glitch, on whichever sheet each part of it lands, with its box kept clear of other lines.
  const asked = String(ctx.params.sloganPlace ?? 'picked'), place = asked === 'picked' ? f.picks?.place : asked, spot = place ? f.spots?.[place] : undefined;
  const face = FACES.includes(ctx.params.sloganFace as StrokeFace) ? ctx.params.sloganFace as StrokeFace : 'matrix';
  const text = (String(ctx.params.sloganText ?? '').trim() || f.picks?.text || '').toUpperCase();
  const set = spot && text.trim() ? sloganAt(spot, text.trim(), face, rngOf('slogan')) : undefined;
  const off = (q: Point) => !set?.screens.some(r => insideRing(r, q));

  // Every line slid through its slice, then routed to its sheet.
  const clear = mask.grown(0.5), behind = mask.grown(4.5), front: Stroke[] = [], back: Stroke[] = [];
  for (const s of strokes) for (const moved of slid(s.piece, s.local && fieldFrame ? fieldFrame : frame)) for (const piece of clipToRect(moved, ART)) {
    if (!s.backOnly) for (const run of keepAlong(piece, q => !clear(q), 0.2)) if (pathLength(run) >= 0.8) front.push({ ...s, piece: run });
    if (!s.frontOnly) for (const run of keepAlong(piece, behind, 0.2)) if (pathLength(run) >= 0.8 && run.some(mask.has)) back.push({ ...s, pen: 'black', piece: run });
  }
  const tell = (items: Stroke[]) => (set ? items.flatMap(it => keepAlong(it.piece, off, 0.2).filter(q => pathLength(q) >= 0.8).map(piece => ({ ...it, piece }))) : items);
  const sheets = { black: partsOf(tell(front), 'black', thin), magenta: partsOf(tell(back), 'magenta', thin) };
  if (set) {
    const onBlack: Point[][] = [], onMagenta: Point[][] = [];
    for (const line of set.lines) for (const piece of clipToRect(line, ART)) {
      onBlack.push(...keepAlong(piece, q => !mask.has(q), 0.05));
      onMagenta.push(...keepAlong(piece, mask.has, 0.05));
    }
    if (onBlack.length) sheets.black.push({ id: 'black-slogan', pen: 'silver', paths: onBlack });
    if (onMagenta.length) sheets.magenta.push({ id: 'magenta-slogan', pen: 'black', paths: onMagenta });
  }
  return { windows, art: sheets };
}
