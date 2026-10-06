import type { Point } from '../../src/sketch/types.ts';
import { clipToRect, keepAlong, type Rect } from './page.ts';

/**
 * Flat-mark fills: hatch laid straight on the sheet, with no perspective, for the marks the Breach
 * cards draw in page millimetres (a hatched disc, a lightning band, a censor bar).
 *
 * These keep their own scanline arithmetic rather than calling src/patch/region-hatch.ts: that
 * fills arbitrary even-odd regions on a rotated scanline grid, so its lines start at other offsets
 * and round differently, which would move every plotted path of the pieces already printed.
 */

/** A closed circle polyline of `steps` segments (first point repeated at the end). */
export function circlePath(centre: Point, r: number, steps = 144): Point[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: centre.x + r * Math.cos(i / steps * Math.PI * 2), y: centre.y + r * Math.sin(i / steps * Math.PI * 2),
  }));
}

/** One hatch family: its angle in radians and its pitch in millimetres. */
export type HatchFamily = readonly [angle: number, pitch: number];

/**
 * Chords of a circle in one or more crossing families, centred lines `pitch` apart (the first half a
 * pitch from the edge). Chords whose half-length is under `minHalf` are skipped.
 */
export function discHatch(centre: Point, r: number, families: readonly HatchFamily[], minHalf = 0.3): Point[][] {
  const out: Point[][] = [];
  for (const [angle, pitch] of families) {
    const cx = Math.cos(angle), cy = Math.sin(angle), nx = -cy, ny = cx;
    for (let o = -r + pitch / 2; o < r; o += pitch) {
      const h = Math.sqrt(r * r - o * o);
      if (h < minHalf) continue;
      const mx = centre.x + nx * o, my = centre.y + ny * o;
      out.push([{ x: mx - cx * h, y: my - cy * h }, { x: mx + cx * h, y: my + cy * h }]);
    }
  }
  return out;
}

/** A solid-looking disc: two rules (`core` and `core - rule`) and crossing hatch `inset` inside the edge. */
export function hatchedDisc(centre: Point, core: number, families: readonly HatchFamily[], rule = 0.6, inset = 0.9): Point[][] {
  return [circlePath(centre, core), circlePath(centre, core - rule), ...discHatch(centre, core - inset, families)];
}

/** Signed side of a page point relative to a polyline, and its distance from it. */
export function sideOf(path: Point[], p: Point): { side: number; dist: number } {
  let best = Infinity, side = 1;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) { best = d; side = Math.sign(dx * (p.y - a.y) - dy * (p.x - a.x)) || 1; }
  }
  return { side, dist: best };
}

/** The two edges of a band of half-width `half` round a centreline, mitred at the corners so it keeps its width. */
export function bandOutlines(centreline: Point[], half: number): [Point[], Point[]] {
  const offset = (sign: number): Point[] => centreline.map((p, i) => {
    const a = centreline[Math.max(0, i - 1)], b = centreline[Math.min(centreline.length - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    // Miter the corners so the band keeps its width round each turn.
    let scale = 1;
    if (i > 0 && i < centreline.length - 1) {
      const u = { x: p.x - centreline[i - 1].x, y: p.y - centreline[i - 1].y }, ul = Math.hypot(u.x, u.y);
      scale = 1 / Math.max(0.35, (-u.y / ul) * nx + (u.x / ul) * ny);
    }
    return { x: p.x + sign * nx * half * scale, y: p.y + sign * ny * half * scale };
  });
  return [offset(1), offset(-1)];
}

export interface BandHatch {
  /** Millimetres between lines (default 0.6). */
  pitch?: number;
  /** Line angle in radians to the page (default 30°). */
  angle?: number;
  /** How far inside the band edge the hatch stops (default 0.5 mm). */
  margin?: number;
}

/** Parallel hatch across `area`, kept only where it lies within `half - margin` of the centreline. */
export function bandHatch(centreline: Point[], half: number, area: Rect, hatch: BandHatch = {}): Point[][] {
  const { pitch = 0.6, angle = Math.PI / 6, margin = 0.5 } = hatch;
  const cx = Math.cos(angle), cy = Math.sin(angle);
  const span = Math.hypot(area.x1 - area.x0, area.y1 - area.y0);
  const out: Point[][] = [];
  for (let o = -span; o < span; o += pitch) {
    const ox = area.x0 - cy * o, oy = area.y0 + cx * o;
    const line: Point[] = [{ x: ox - cx * span, y: oy - cy * span }, { x: ox + cx * span, y: oy + cy * span }];
    for (const piece of clipToRect(line, area)) out.push(...keepAlong(piece, p => sideOf(centreline, p).dist < half - margin, 0.3));
  }
  return out;
}

/** A flat band along a centreline: two outline rules and a dense hatch between them. */
export function bandMarks(centreline: Point[], half: number, area: Rect, hatch?: BandHatch): Point[][] {
  return [...bandOutlines(centreline, half), ...bandHatch(centreline, half, area, hatch)];
}

/** A flat bar on the sheet: its centre, length along its axis `tilt` (radians), and height across it. */
export interface Bar { cx: number; cy: number; l: number; h: number }

/**
 * A bar filled with hatching instead of ink: its outer quad, an inner rule `rule` mm inside, and
 * crossing families inside the rule's `inset`. Returns the quad and the paths (outline, rule, hatch).
 */
export function hatchedBar(b: Bar, tilt: number, families: readonly HatchFamily[], rule = 1.1, inset = 1.6): { quad: Point[]; paths: Point[][] } {
  const ux = Math.cos(tilt), uy = Math.sin(tilt);
  const at = (s: number, t: number): Point => ({ x: b.cx + ux * s - uy * t, y: b.cy + uy * s + ux * t });
  const quad = [at(-b.l / 2, -b.h / 2), at(b.l / 2, -b.h / 2), at(b.l / 2, b.h / 2), at(-b.l / 2, b.h / 2)];
  const paths: Point[][] = [[...quad, quad[0]],
    [at(-b.l / 2 + rule, -b.h / 2 + rule), at(b.l / 2 - rule, -b.h / 2 + rule), at(b.l / 2 - rule, b.h / 2 - rule), at(-b.l / 2 + rule, b.h / 2 - rule), at(-b.l / 2 + rule, -b.h / 2 + rule)]];
  for (const [angle, pitch] of families) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const reach = (b.l + b.h) / 2;
    for (let k = -reach; k <= reach; k += pitch) {
      // Line s = k + t·(dx/dy) in bar coordinates, clipped to the inner rectangle.
      let t0 = -b.h / 2 + inset, t1 = b.h / 2 - inset;
      const sAt = (t: number) => k + t * dx / dy;
      const lo = -b.l / 2 + inset, hi = b.l / 2 - inset;
      const s0 = sAt(t0), s1 = sAt(t1);
      if (Math.max(s0, s1) < lo || Math.min(s0, s1) > hi) continue;
      const clipT = (s: number) => (s - k) * dy / dx;
      if (s0 < lo) t0 = clipT(lo); else if (s0 > hi) t0 = clipT(hi);
      if (s1 < lo) t1 = clipT(lo); else if (s1 > hi) t1 = clipT(hi);
      if (Math.abs(t1 - t0) < 0.4) continue;
      paths.push([at(sAt(t0), t0), at(sAt(t1), t1)]);
    }
  }
  return { quad, paths };
}
