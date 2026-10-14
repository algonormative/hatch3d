import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { validateSketch } from '../../packages/plot-core/src/index.ts';
import { GUIDE_DEFAULTS, cutGuides, plyControl, plyRegion, renderPly, validateAssemblySpec, validateCuts } from '../sketch/assembly.ts';
import { INKS, PAPERS, inkPen, inkReads } from '../sketch/materials.ts';
import { clipToRegion, distanceToRings, inRegion } from '../sketch/region.ts';
import { measureStrokeText } from '../sketch/stroke-text.ts';
import type { Region } from '../sketch/region.ts';
import type { AssemblySpec, Control, Cut, Cuts, Part, Pen, Point } from '../sketch/types.ts';

const P = (x: number, y: number): Point => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const line = (...c: number[]): Point[] => c.reduce<Point[]>((out, v, i) => (i % 2 ? out : [...out, P(v, c[i + 1])]), []);
const length = (paths: Point[][]): number => paths.reduce((sum, path) => sum + path.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0), 0);
const mulberry32 = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

interface R { x0: number; y0: number; x1: number; y1: number }
/** Independent oracle: distance from a point to an axis-aligned rectangle (0 inside). */
const rectDist = (p: Point, r: R): number => Math.hypot(Math.max(r.x0 - p.x, 0, p.x - r.x1), Math.max(r.y0 - p.y, 0, p.y - r.y1));
const rectOf = (cut: Cut): R => ({ x0: Math.min(...cut.rings[0].map((p) => p.x)), y0: Math.min(...cut.rings[0].map((p) => p.y)), x1: Math.max(...cut.rings[0].map((p) => p.x)), y1: Math.max(...cut.rings[0].map((p) => p.y)) });

/**
 * Clip each segment, then compare against the oracle: every sampled point of the output satisfies it, and the kept
 * length matches a fine brute-force sampling of the oracle to within the sampling step per transition.
 */
function expectMatchesOracle(region: Region, oracle: (p: Point) => boolean, segments: Point[][], slack = 1e-6): { kept: number; total: number } {
  const N = 20000;
  let kept = 0, total = 0;
  for (const seg of segments) {
    const out = clipToRegion([seg], region);
    for (const piece of out) for (let i = 1; i < piece.length; i++) for (let k = 0; k <= 8; k++) {
      const a = piece[i - 1], b = piece[i];
      expect(oracle(P(a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8))).toBe(true);
    }
    const len = length([seg]);
    let inside = 0, flips = 1, prev: boolean | undefined;
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      const ok = oracle(P(seg[0].x + (seg[1].x - seg[0].x) * t, seg[0].y + (seg[1].y - seg[0].y) * t));
      if (ok) inside++;
      if (prev !== undefined && prev !== ok) flips++;
      prev = ok;
    }
    expect(Math.abs(length(out) - (inside / N) * len)).toBeLessThan((len / N) * (flips + 1) + slack);
    kept += length(out); total += len;
  }
  return { kept, total };
}

// ── The fixture: three plies, a window in the middle and a window in the top ──

const page = { width: 200, height: 200, margin: 10 };
const pens: Pen[] = [inkPen('gold'), inkPen('black'), inkPen('carbon')];
const MARGIN = 1.5, BLEED = 1, MIDDLE_BLEED = 2;
const spec: AssemblySpec = {
  control: 'ply', cutPen: 'black', margin: MARGIN, bleed: BLEED,
  plies: [
    { id: 'bottom', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold' },
    { id: 'middle', paper: { id: 'gold-yellow', color: PAPERS['gold-yellow'].color }, pens: ['black'], cutInk: 'black', bleed: MIDDLE_BLEED },
    { id: 'top', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
  ],
  signature: { ply: 'top', pen: 'carbon', box: { x: 150, y: 175, width: 30, height: 10 } },
};
const noSignature: AssemblySpec = { ...spec, signature: undefined };
const WINDOW_M = rect(40, 40, 140, 140), WINDOW_T = rect(60, 60, 160, 160);
const cuts: Cuts = { middle: [{ id: 'm1', rings: [WINDOW_M] }], top: [{ id: 't1', rings: [WINDOW_T] }] };
const M = { x0: 40, y0: 40, x1: 140, y1: 140 }, T = { x0: 60, y0: 60, x1: 160, y1: 160 };
const exact = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('plyRegion', () => {
  it('shows the bottom ply exactly inside the upper windows, running b(q) under each upper edge and no more', () => {
    const region = plyRegion(spec, cuts, 'bottom');
    // Through the middle (bleed 2) and top (the assembly's bleed 1) windows: x in [max(40 - 2, 60 - 1), min(140 + 2, 160 + 1)].
    const across = clipToRegion([line(0, 100, 200, 100)], region);
    expect(across).toHaveLength(1);
    exact(across[0][0].x, 59);
    exact(across[0][1].x, 142);
    const down = clipToRegion([line(100, 0, 100, 200)], region);
    expect(down).toHaveLength(1);
    exact(down[0][0].y, 59);
    exact(down[0][1].y, 142);
    // Next to the top window's corner the growth is round: 0.5 mm above its edge the band's end is a disc root.
    const skirt = clipToRegion([line(0, 59.5, 200, 59.5)], region);
    exact(skirt[0][0].x, 60 - Math.sqrt(1 - 0.25));
    exact(skirt[0][1].x, 142);
    expect(clipToRegion([line(0, 50, 200, 50)], region)).toEqual([]); // 10 mm outside the top window
  });

  it('matches an independent rounded-rectangle oracle on random lines', () => {
    const rng = mulberry32(21);
    const segments = Array.from({ length: 60 }, () => line(rng() * 200, rng() * 200, rng() * 200, rng() * 200));
    const { kept, total } = expectMatchesOracle(plyRegion(spec, cuts, 'bottom'), (p) => rectDist(p, M) < MIDDLE_BLEED + 1e-6 && rectDist(p, T) < BLEED + 1e-6, segments);
    expect(kept).toBeGreaterThan(total * 0.05);
    expect(kept).toBeLessThan(total * 0.9);
  });

  it('keeps a ply off its own cuts by the margin, and shows it only through the windows above', () => {
    const top = clipToRegion([line(0, 100, 200, 100)], plyRegion(spec, cuts, 'top'));
    expect(top.map((path) => path.map((p) => p.x))).toEqual([[0, 60 - MARGIN], [160 + MARGIN, 200]]);
    // The middle ply shows through the top window (grown by 1) and keeps 1.5 mm off its own window.
    const middle = clipToRegion([line(0, 100, 200, 100)], plyRegion(spec, cuts, 'middle'));
    expect(middle).toHaveLength(1);
    exact(middle[0][0].x, 140 + MARGIN);
    exact(middle[0][1].x, 160 + BLEED);
  });

  it('keeps art off its own ply’s cuts, on randomised rectangles', () => {
    const rng = mulberry32(5);
    const random: Cut[] = Array.from({ length: 3 }, (_, i) => {
      const x0 = 20 + i * 58 + rng() * 10, y0 = 20 + rng() * 60;
      return { id: `r${i}`, rings: [rect(x0, y0, x0 + 10 + rng() * 30, y0 + 10 + rng() * 80)] };
    });
    const rects = random.map(rectOf);
    const segments = Array.from({ length: 80 }, () => line(rng() * 200, rng() * 200, rng() * 200, rng() * 200));
    const { kept, total } = expectMatchesOracle(plyRegion(noSignature, { top: random }, 'top'), (p) => rects.every((r) => rectDist(p, r) >= MARGIN - 1e-6), segments);
    expect(kept).toBeLessThan(total);
    expect(kept).toBeGreaterThan(total * 0.5);
    // And exactly: a horizontal line through a cut keeps m off both sides of it.
    const y = (rects[0].y0 + rects[0].y1) / 2;
    const through = clipToRegion([line(0, y, 200, y)], plyRegion(noSignature, { top: random }, 'top'));
    exact(through[0][1].x, rects[0].x0 - MARGIN);
    exact(through[1][0].x, rects[0].x1 + MARGIN);
  });

  it('keeps the signature box empty of art on the signing ply, and only there', () => {
    const across = clipToRegion([line(0, 180, 200, 180)], plyRegion(spec, {}, 'top'));
    expect(across.map((path) => path.map((p) => p.x))).toEqual([[0, 150], [180, 200]]);
    const down = clipToRegion([line(165, 0, 165, 200)], plyRegion(spec, {}, 'top'));
    expect(down.map((path) => path.map((p) => p.y))).toEqual([[0, 175], [185, 200]]);
    expect(inRegion(P(165, 180), plyRegion(noSignature, {}, 'top'))).toBe(true);
    expect(inRegion(P(165, 180), plyRegion({ ...spec, signature: { ...spec.signature!, ply: 'middle' } }, {}, 'top'))).toBe(true);
    expect(inRegion(P(165, 180), plyRegion(spec, {}, 'top'))).toBe(false);
  });

  it('an upper ply with no cuts hides the ply below; an unknown ply throws', () => {
    expect(clipToRegion([line(0, 100, 200, 100)], plyRegion(spec, { top: cuts.top }, 'bottom'))).toEqual([]);
    expect(() => plyRegion(spec, cuts, 'attic')).toThrow(/Unknown ply/);
  });
});

describe('cutGuides', () => {
  const half = inkPen('black').width / 2;
  const options = { ...GUIDE_DEFAULTS, penWidth: inkPen('black').width };
  const outlines = (part: Part, rings: number) => part.paths.slice(0, rings);
  /** The X marks (the strokes after the outline), centre and both diagonals, with the label turned off. */
  const marks = (cut: Cut, o = options) => {
    const part = cutGuides(cut, 'black', { ...o, label: false });
    const strokes = part.paths.slice(cut.rings.length);
    expect(strokes.length % 2).toBe(0);
    const centres: Point[] = [];
    for (let i = 0; i < strokes.length; i += 2) {
      const [a, b] = strokes[i], [c, d] = strokes[i + 1];
      expect(strokes[i]).toHaveLength(2);
      exact((a.x + b.x) / 2, (c.x + d.x) / 2);
      exact((a.y + b.y) / 2, (c.y + d.y) / 2);
      centres.push(P((a.x + b.x) / 2, (a.y + b.y) / 2));
    }
    return { part, strokes, centres };
  };
  const big: Cut = { id: 'big', rings: [rect(48, 48, 152, 152)] };

  it('outlines each ring half a pen width inside the waste, closed, for either winding', () => {
    for (const ring of [rect(70, 70, 130, 130), rect(70, 70, 130, 130).reverse()]) {
      const cut: Cut = { id: 'a', rings: [ring] };
      const part = cutGuides(cut, 'black', options);
      expect(part.id).toBe('cut-a');
      expect(part.pen).toBe('black');
      expect(part.boundary).toEqual(cut.rings);
      const [outline] = outlines(part, 1);
      expect(outline[0]).toEqual(outline[outline.length - 1]);
      expect(outline).toHaveLength(5);
      for (const v of outline) {
        expect(Math.abs(distanceToRings(v, cut.rings) - half)).toBeLessThan(1e-6);
        expect(inRegion(v, { rings: cut.rings })).toBe(true);
      }
      expect(Math.min(...outline.map((p) => p.x))).toBeCloseTo(70 + half, 9);
      expect(Math.max(...outline.map((p) => p.x))).toBeCloseTo(130 - half, 9);
    }
  });

  it('offsets a shaped ply (outer ring plus hole) towards the waste on both rings', () => {
    const cut: Cut = { id: 'shaped', rings: [rect(10, 10, 190, 190), rect(60, 60, 140, 140)] };
    const part = cutGuides(cut, 'black', options);
    const [outer, hole] = outlines(part, 2);
    for (const v of [...outer, ...hole]) expect(inRegion(v, { rings: cut.rings })).toBe(true);
    // The outer outline's corners are a half pen width from both edges; the hole's are mitred out, so a half pen from its edges' lines.
    for (const v of outer) expect(Math.abs(distanceToRings(v, cut.rings) - half)).toBeLessThan(1e-6);
    for (const v of hole) expect(Math.abs(distanceToRings(v, cut.rings) - half * Math.SQRT2)).toBeLessThan(1e-6);
    expect(Math.max(...hole.map((p) => p.x))).toBeCloseTo(140 + half, 9);
    expect(Math.max(...outer.map((p) => p.x))).toBeCloseTo(190 - half, 9);
    expect(Math.min(...outer.map((p) => p.x))).toBeCloseTo(10 + half, 9); // the outer outline moved in
    expect(Math.min(...hole.map((p) => p.x))).toBeCloseTo(60 - half, 9); // the hole's moved out
  });

  it('offsets an L-shaped window, with its reflex corner, into the waste', () => {
    const cut: Cut = { id: 'ell', rings: [[P(40, 40), P(140, 40), P(140, 80), P(80, 80), P(80, 140), P(40, 140)]] };
    const part = cutGuides(cut, 'black', options);
    const [outline] = outlines(part, 1);
    for (const v of outline) {
      expect(distanceToRings(v, cut.rings)).toBeGreaterThan(half - 1e-6);
      expect(inRegion(v, { rings: cut.rings })).toBe(true);
    }
    expect(Math.min(...outline.map((v) => distanceToRings(v, cut.rings)))).toBeCloseTo(half, 6);
    expect(outline).toHaveLength(7);
  });

  it('places X marks on a lattice from the window centre, each clear of the cut, and no others', () => {
    const { centres, strokes } = marks(big);
    // An X of two strokes of length `size` reaches size / 2 from its centre (not the half-diagonal of its square).
    const need = 4 / 2 + half + GUIDE_DEFAULTS.guard;
    const key = (c: Point) => `${c.x.toFixed(6)},${c.y.toFixed(6)}`;
    const expected: string[] = [];
    for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) {
      const c = P(100 + i * 12, 100 + j * 12);
      if (Math.min(c.x - 48, 152 - c.x, c.y - 48, 152 - c.y) >= need) expected.push(key(c));
    }
    expect(centres.map(key).sort()).toEqual(expected.sort());
    expect(expected).toContain(key(P(100, 100)));
    expect(expected).not.toContain(key(P(148, 100))); // 4 mm in from the edge: its reach fits (2.175) but not the guard
    // Each X is two strokes of length `size`, and the ink stays a guard clear of the cut.
    for (const stroke of strokes) {
      exact(Math.hypot(stroke[1].x - stroke[0].x, stroke[1].y - stroke[0].y), GUIDE_DEFAULTS.size);
      for (const end of stroke) expect(distanceToRings(end, big.rings) - half).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.guard - 1e-9);
    }
  });

  it('keeps a lattice X that is 4.5 mm in from the edge: size / 2 + pen / 2 + guard = 4.175 clears', () => {
    // The old budget used size / sqrt 2 (2.83), which wanted 5.0 mm and dropped this mark.
    const wide: Cut = { id: 'wide5', rings: [rect(47.5, 80, 152.5, 120)] };
    const { centres } = marks(wide);
    expect(centres.some((c) => Math.abs(c.x - 148) < 1e-9 && Math.abs(c.y - 100) < 1e-9)).toBe(true);
    expect(centres.some((c) => Math.abs(c.x - 160) < 1e-9)).toBe(false); // outside the window
  });

  it('grows the pitch by 1.25 until at most maxMarks fit', () => {
    const wide: Cut = { id: 'wide', rings: [rect(11, 11, 189, 189)] };
    const { centres } = marks(wide);
    expect(centres.length).toBeLessThanOrEqual(GUIDE_DEFAULTS.maxMarks);
    expect(centres.length).toBeGreaterThan(20);
    const step = Math.min(...centres.filter((c) => c.x !== 100).map((c) => Math.abs(c.x - 100)));
    const grown = [0, 1, 2, 3, 4].map((k) => GUIDE_DEFAULTS.pitch * 1.25 ** k);
    expect(grown.some((pitch) => Math.abs(step - pitch) < 1e-9)).toBe(true);
    expect(step).toBeGreaterThan(GUIDE_DEFAULTS.pitch);
    expect(marks(wide, { ...options, maxMarks: 4 }).centres.length).toBeLessThanOrEqual(4);
  });

  it('always has an X: a window too small for the lattice gets one at its roomiest point, shrunk to fit', () => {
    for (const side of [8, 12, 30]) {
      const cut: Cut = { id: 's', rings: [rect(100, 100, 100 + side, 100 + side)] };
      const { centres, strokes } = marks(cut);
      expect(centres.length).toBeGreaterThanOrEqual(1);
      for (const stroke of strokes) for (const end of stroke) expect(distanceToRings(end, cut.rings) - half).toBeGreaterThanOrEqual(0.5 - 1e-9);
    }
    const small = marks({ id: 's', rings: [rect(100, 100, 108, 108)] });
    expect(small.centres).toHaveLength(1);
    expect(Math.abs(small.centres[0].x - 104)).toBeLessThan(1e-9);
  });

  it('shrinks the lone X to 2 x (clearance - pen / 2 - 0.5), so its ink stops 0.5 mm short of the cut', () => {
    // A 4 mm wide slot: clearance 2, so the X is 2 x (2 - 0.175 - 0.5) = 2.65 long, not the default 4.
    const slot: Cut = { id: 'slot4', rings: [rect(100, 50, 104, 110)] };
    const { strokes } = marks(slot);
    expect(strokes).toHaveLength(2);
    for (const stroke of strokes) {
      exact(Math.hypot(stroke[1].x - stroke[0].x, stroke[1].y - stroke[0].y), 2 * (2 - half - 0.5));
      for (const end of stroke) expect(distanceToRings(end, slot.rings) - half).toBeGreaterThanOrEqual(0.5 - 1e-9);
    }
    // In a diamond the strokes point straight at the walls, so the budget is exact: the ink ends 0.5 mm from them.
    const diamond: Cut = { id: 'dia', rings: [[P(100, 97), P(103, 100), P(100, 103), P(97, 100)]] };
    const lone = marks(diamond);
    expect(lone.centres).toHaveLength(1);
    const clearance = distanceToRings(lone.centres[0], diamond.rings);
    for (const stroke of lone.strokes) exact(Math.hypot(stroke[1].x - stroke[0].x, stroke[1].y - stroke[0].y), 2 * (clearance - half - 0.5));
    const ends = lone.strokes.flat().map((end) => distanceToRings(end, diamond.rings) - half);
    expect(Math.min(...ends)).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(Math.min(...ends)).toBeLessThan(0.5 + 1e-6);
  });

  it('throws when a window is too narrow for any X, or finer than the guide pen', () => {
    // The X needs 2 x (clearance - pen / 2 - 0.5) >= 1.5, which is clearance >= 1.425: a 2.9 mm slot draws a 1.55 X, 2.8 does not.
    expect(() => cutGuides({ id: 'slot', rings: [rect(100, 50, 102.8, 110)] }, 'black', options)).toThrow(/slot: no room for an X mark/);
    expect(marks({ id: 'slot', rings: [rect(100, 50, 102.9, 110)] }).strokes).toHaveLength(2);
    exact(Math.hypot(...(([a, b]) => [b.x - a.x, b.y - a.y])(marks({ id: 'slot', rings: [rect(100, 50, 102.9, 110)] }).strokes[0]) as [number, number]), 2 * (1.45 - half - 0.5));
    expect(() => cutGuides({ id: 'sliver', rings: [rect(100, 50, 100.3, 110)] }, 'black', options)).toThrow(/sliver: feature finer than the guide pen/);
    // A neck narrower than the pen folds the outline over itself.
    const dumbbell = [P(40, 40), P(80, 40), P(80, 59.9), P(100, 59.9), P(100, 40), P(140, 40), P(140, 80), P(100, 80), P(100, 60.2), P(80, 60.2), P(80, 80), P(40, 80)];
    expect(() => cutGuides({ id: 'neck', rings: [dumbbell] }, 'black', options)).toThrow(/neck: feature finer than the guide pen/);
  });

  it('sets the label clear of the cut and leaves out the X marks under it', () => {
    const cut: Cut = { ...big, label: 'CUT A' };
    const on = cutGuides(cut, 'black', options);
    const off = cutGuides(cut, 'black', { ...options, label: false });
    const same = (a: Point[], b: Point[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
    const label = on.paths.filter((p) => !off.paths.some((q) => same(p, q)));
    const removed = off.paths.filter((q) => !on.paths.some((p) => same(p, q)));
    expect(label.length).toBeGreaterThan(5);
    const xs = label.flat().map((p) => p.x), ys = label.flat().map((p) => p.y);
    const box = { x0: Math.min(...xs) - GUIDE_DEFAULTS.guard, x1: Math.max(...xs) + GUIDE_DEFAULTS.guard, y0: Math.min(...ys) - GUIDE_DEFAULTS.guard, y1: Math.max(...ys) + GUIDE_DEFAULTS.guard };
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(GUIDE_DEFAULTS.heights[0], 6); // the biggest height fits
    // The padded box sits inside the window with the guard to spare.
    expect(rectDist(P(box.x0, box.y0), { x0: 48, y0: 48, x1: 152, y1: 152 })).toBe(0);
    expect(Math.min(box.x0 - 48, 152 - box.x1, box.y0 - 48, 152 - box.y1)).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.guard);
    const meets = (stroke: Point[]) => {
      const sx = stroke.map((p) => p.x), sy = stroke.map((p) => p.y);
      return !(Math.max(...sx) < box.x0 || Math.min(...sx) > box.x1 || Math.max(...sy) < box.y0 || Math.min(...sy) > box.y1);
    };
    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect(removed.every(meets)).toBe(true);
    const keptMarks = on.paths.slice(1).filter((p) => !label.includes(p));
    expect(keptMarks.length).toBeGreaterThan(0);
    expect(keptMarks.some(meets)).toBe(false);
    // Without a label of its own a cut is lettered `CUT <id>`; a string option overrides both.
    const strokes = (c: Cut, o = options) => {
      const withText = cutGuides(c, 'black', o), without = cutGuides(c, 'black', { ...o, label: false });
      return withText.paths.filter((p) => !without.paths.some((q) => same(p, q)));
    };
    const width = (paths: Point[][]) => Math.max(...paths.flat().map((p) => p.x)) - Math.min(...paths.flat().map((p) => p.x));
    expect(width(strokes({ id: 'win', rings: big.rings }))).toBeGreaterThan(width(label));
    expect(width(strokes({ id: 'win', rings: big.rings }, { ...options, label: 'CUT A' }))).toBeCloseTo(width(label), 9);
  });

  it('leaves the label out rather than let it take the only X', () => {
    // Wide enough for the 2.5 mm label to sit clear in the middle, but with room for just one X, which is where the label would go.
    const w = measureStrokeText('CUT A', { face: 'sans', height: 2.5 }) + 11;
    const cut: Cut = { id: 'one', label: 'CUT A', rings: [rect(100 - w / 2, 93, 100 + w / 2, 107)] };
    const on = cutGuides(cut, 'black', options), off = cutGuides(cut, 'black', { ...options, label: false });
    expect(marks(cut).centres).toHaveLength(1);
    expect(on.paths).toEqual(off.paths);
  });

  it('keeps every guide point clear of the cut line on a 45 degree strip, and leaves out the label that has no room', () => {
    // A 4.6 mm wide, 90 mm long strip at 45 degrees: its bounding box is huge, but only the strip is waste.
    const w = 4.6, L = 90, r = Math.SQRT1_2;
    const nx = (-r * w) / 2, ny = (r * w) / 2, ex = L * r, ey = L * r;
    const ring = [P(30 + nx, 30 + ny), P(30 - nx, 30 - ny), P(30 - nx + ex, 30 - ny + ey), P(30 + nx + ex, 30 + ny + ey)];
    const cut: Cut = { id: 'strip', label: 'CUT A', rings: [ring] };
    const on = cutGuides(cut, 'black', options), off = cutGuides(cut, 'black', { ...options, label: false });
    for (const path of on.paths) for (const p of path) {
      expect(inRegion(p, { rings: [ring] })).toBe(true);
      expect(distanceToRings(p, [ring])).toBeGreaterThanOrEqual(half - 1e-6);
    }
    const same = (a: Point[], b: Point[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
    const label = on.paths.filter((path) => !off.paths.some((other) => same(path, other)));
    for (const p of label.flat()) expect(distanceToRings(p, [ring])).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.guard);
    expect(label).toEqual([]); // no height of lettering fits clear of a strip this narrow
  });

  it('sizes the guide by the ply’s cutInk but emits it on the cutPen layer', () => {
    // cutInk gold is 0.5 mm wide and cutPen black is 0.35 mm: the layer is black's, the outline is offset by gold's 0.25.
    const goldInk = structuredClone(spec);
    goldInk.plies[2].cutInk = 'gold';
    const guide = renderPly(goldInk, { params: { ply: 'top' } }, pens, { cuts: { top: [{ id: 'w', rings: [WINDOW_T] }] }, art: {} }).find((p) => p.id === 'cut-w')!;
    expect(guide.pen).toBe(goldInk.cutPen);
    expect(Math.min(...guide.paths[0].map((p) => p.x))).toBeCloseTo(60 + 0.25, 9);
    expect(Math.max(...guide.paths[0].map((p) => p.y))).toBeCloseTo(160 - 0.25, 9);
    const blackInk = renderPly(spec, { params: { ply: 'top' } }, pens, { cuts: { top: [{ id: 'w', rings: [WINDOW_T] }] }, art: {} }).find((p) => p.id === 'cut-w')!;
    expect(blackInk.pen).toBe(goldInk.cutPen);
    expect(Math.min(...blackInk.paths[0].map((p) => p.x))).toBeCloseTo(60 + 0.175, 9);
  });

  it('tries each height in turn, and omits the label when none fits', () => {
    const slim: Cut = { id: 'slim', label: 'CUT A', rings: [rect(70, 100, 130, 112)] };
    const heightOf = (cut: Cut) => {
      const off = cutGuides(cut, 'black', { ...options, label: false });
      const on = cutGuides(cut, 'black', options);
      const label = on.paths.filter((p) => !off.paths.some((q) => q.length === p.length && q.every((r, i) => r.x === p[i].x && r.y === p[i].y)));
      return label.length ? Math.max(...label.flat().map((p) => p.y)) - Math.min(...label.flat().map((p) => p.y)) : 0;
    };
    expect(heightOf(slim)).toBeCloseTo(3.5, 6); // 5 mm lettering needs a taller window
    expect(heightOf({ id: 'tiny', label: 'CUT A', rings: [rect(100, 100, 112, 112)] })).toBe(0);
    expect(heightOf({ id: 'free', label: 'CUT A', rings: [rect(48, 48, 152, 152)] })).toBeCloseTo(5, 6);
    expect(cutGuides({ ...big, label: 'CUT A' }, 'black', { ...options, label: false }).paths).toHaveLength(2 * marks(big).centres.length + 1);
  });
});

describe('validators', () => {
  const controls = (): Control[] => [plyControl(spec)];
  const bad = (mutate: (s: AssemblySpec) => void, controlList: Control[] = controls()) => {
    const copy = structuredClone(spec);
    mutate(copy);
    return () => validateAssemblySpec(copy, pens, controlList);
  };

  it('plyControl is a select over the ply ids, bottom to top, defaulting to the top ply', () => {
    expect(plyControl(spec)).toEqual({ type: 'select', id: 'ply', label: 'Ply', default: 'top', options: ['bottom', 'middle', 'top'] });
    expect(plyControl(spec, 'Sheet').label).toBe('Sheet');
    expect(() => validateAssemblySpec(spec, pens, controls())).not.toThrow();
  });

  it('validateAssemblySpec raises each listed error', () => {
    expect(bad((s) => { s.plies[0].id = 'my ply'; })).toThrow(/safe id/);
    expect(bad((s) => { s.control = 'my control'; })).toThrow(/control must be a safe id/);
    expect(bad((s) => { s.plies[1].id = 'bottom'; })).toThrow(/Duplicate ply id: bottom/);
    expect(bad(() => {}, [])).toThrow(/must be a select control/);
    expect(bad(() => {}, [{ type: 'slider', id: 'ply', label: 'Ply', default: 1, min: 0, max: 2, step: 1 }])).toThrow(/must be a select control/);
    expect(bad(() => {}, [{ type: 'select', id: 'ply', label: 'Ply', default: 'top', options: ['bottom', 'top'] }])).toThrow(/options must be the ply ids/);
    expect(bad(() => {}, [{ type: 'select', id: 'ply', label: 'Ply', default: 'top', options: ['top', 'middle', 'bottom'] }])).toThrow(/options must be the ply ids/);
    expect(bad((s) => { s.plies[0].pens = ['nope']; })).toThrow(/pen nope is not a declared pen/);
    expect(bad((s) => { s.plies[0].cutInk = 'nope'; })).toThrow(/cutInk nope is not a declared pen/);
    expect(bad((s) => { s.cutPen = 'nope'; })).toThrow(/cutPen nope is not a declared pen/);
    expect(bad((s) => { s.signature!.pen = 'nope'; })).toThrow(/signature pen nope is not a declared pen/);
    expect(bad((s) => { s.signature!.ply = 'attic'; })).toThrow(/signature ply attic/);
    expect(bad((s) => { s.margin = 0; })).toThrow(/margin must be greater than 0/);
    expect(bad((s) => { s.margin = -1; })).toThrow(/margin/);
    expect(bad((s) => { s.bleed = -0.5; })).toThrow(/bleed must not be negative/);
    expect(bad((s) => { s.bleed = 0; })).not.toThrow();
    expect(() => validateAssemblySpec(null as unknown as AssemblySpec, pens, controls())).toThrow(/must be an object/);
  });

  it('validateSketch checks the assembly only when there is one', () => {
    const base = { name: 'asm', page, pens, controls: controls(), draw: () => [] };
    expect(() => validateSketch({ ...base, assembly: spec })).not.toThrow();
    expect(() => validateSketch({ ...base, assembly: { ...spec, margin: 0 } })).toThrow(/margin/);
    expect(() => validateSketch({ ...base, controls: [] , assembly: spec })).toThrow(/select control/);
    expect(() => validateSketch({ ...base, controls: [] })).not.toThrow();
  });

  it('validateCuts passes a sound assembly with no warnings', () => {
    expect(validateCuts(spec, cuts, page)).toEqual([]);
    expect(validateCuts(spec, { ...cuts, middle: [{ id: 'm1', rings: [rect(60, 60, 63, 120)] }] }, page)).toEqual([]); // exactly 3 mm wide
  });

  it('validateCuts throws on a self-intersecting ring', () => {
    const bowtie = [P(60, 60), P(100, 100), P(100, 60), P(60, 100)];
    expect(() => validateCuts(spec, { top: [{ id: 'x', rings: [bowtie] }] }, page)).toThrow(/ply top cut x: ring 0 intersects itself/);
  });

  it('validateCuts throws when two cuts on one ply cross or nest, and allows it across plies', () => {
    const a: Cut = { id: 'a', rings: [rect(40, 40, 100, 100)] };
    expect(() => validateCuts(spec, { top: [a, { id: 'b', rings: [rect(80, 80, 140, 140)] }] }, page)).toThrow(/cuts a and b cross/);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(40, 40, 140, 140)] }, { id: 'b', rings: [rect(60, 60, 100, 100)] }] }, page)).toThrow(/cuts a and b nest/);
    expect(() => validateCuts(spec, { top: [a], middle: [{ id: 'b', rings: [rect(80, 80, 140, 140)] }] }, page)).not.toThrow();
    expect(() => validateCuts(spec, { top: [a, { id: 'b', rings: [rect(120, 120, 180, 180)] }] }, page)).not.toThrow(); // apart
  });

  it('validateCuts throws on a vertex outside the page margin, and on an unsafe or repeated cut id', () => {
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(5, 40, 60, 100)] }] }, page)).toThrow(/outside the 10 mm page margin/);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(40, 40, 60, 100)] }] }, { ...page, margin: 45 })).toThrow(/page margin/);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(10, 10, 190, 190)] }] }, page)).not.toThrow(); // on the margin is fine
    expect(() => validateCuts(spec, { top: [{ id: 'a b', rings: [rect(40, 40, 60, 100)] }] }, page)).toThrow(/safe id/);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(40, 40, 60, 100)] }, { id: 'a', rings: [rect(100, 40, 120, 100)] }] }, page)).toThrow(/duplicate cut id/);
    expect(() => validateCuts(spec, { attic: [] }, page)).toThrow(/unknown ply: attic/);
  });

  it('validateCuts throws on a window narrower than 3 mm, sampled on a 0.5 mm grid', () => {
    expect(() => validateCuts(spec, { top: [{ id: 'slot', rings: [rect(60, 60, 62.9, 120)] }] }, page)).toThrow(/ply top cut slot: the window is nowhere 3 mm wide/);
    expect(() => validateCuts(spec, { top: [{ id: 'slot', rings: [rect(60, 60, 64, 120)] }] }, page)).not.toThrow();
    // An annulus counts by its waste: a 2 mm frame is too narrow, a 5 mm one is not.
    const frame = (w: number): Cut => ({ id: 'frame', rings: [rect(20, 20, 180, 180), rect(20 + w, 20 + w, 180 - w, 180 - w)] });
    expect(() => validateCuts(spec, { top: [frame(2)] }, page)).toThrow(/3 mm wide/);
    expect(() => validateCuts(spec, { top: [frame(5)] }, page)).not.toThrow();
  });

  it('validateCuts checks all four sides of the page margin', () => {
    const at = (x0: number, y0: number, x1: number, y1: number) => () => validateCuts(spec, { top: [{ id: 'a', rings: [rect(x0, y0, x1, y1)] }] }, page);
    expect(at(100, 100, 190, 190)).not.toThrow(); // right and bottom exactly on the margin
    expect(at(10, 10, 60, 60)).not.toThrow(); // left and top exactly on it
    expect(at(100, 100, 190.5, 150)).toThrow(/vertex \(190\.5, 100\) is outside the 10 mm page margin/);
    expect(at(100, 100, 150, 190.5)).toThrow(/outside the 10 mm page margin/);
    expect(at(9.5, 100, 60, 150)).toThrow(/outside the 10 mm page margin/);
    expect(at(100, 9.5, 150, 60)).toThrow(/outside the 10 mm page margin/);
    // Without a page there is no margin to check.
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [rect(100, 100, 400, 400)] }] }, undefined)).not.toThrow();
  });

  it('validateCuts finds a nested cut whichever of the two is inside', () => {
    const inner = rect(60, 60, 100, 100), outer = rect(40, 40, 140, 140);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [outer] }, { id: 'b', rings: [inner] }] }, page)).toThrow(/cuts a and b nest/);
    expect(() => validateCuts(spec, { top: [{ id: 'a', rings: [inner] }, { id: 'b', rings: [outer] }] }, page)).toThrow(/cuts a and b nest/);
  });

  it('a ply named like an Object.prototype member has no cuts unless the cuts say so', () => {
    const odd: AssemblySpec = {
      ...noSignature,
      plies: [
        { id: 'constructor', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold' },
        { id: 'toString', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
      ],
    };
    expect(validateCuts(odd, {}, page)).toEqual(['ply constructor is fully hidden: ply toString above it has no cuts']);
    expect(clipToRegion([line(0, 100, 200, 100)], plyRegion(odd, {}, 'toString'))).toEqual([line(0, 100, 200, 100)]);
    expect(renderPly(odd, { params: { ply: 'toString' } }, pens, { cuts: {}, art: {} })).toEqual([]);
    const own = { toString: [{ id: 'w', rings: [WINDOW_T] }] };
    expect(renderPly(odd, { params: { ply: 'toString' } }, pens, { cuts: own, art: {} }).map((p) => p.id)).toEqual(['cut-w', 'asm-toString-w']);
    expect(validateCuts(odd, own, page)).toEqual([]);
  });

  it('validateCuts refuses two cuts whose diagnostic part id asm-<ply>-<cut> is the same', () => {
    const dashed: AssemblySpec = {
      ...noSignature,
      plies: [
        { id: 'a-b', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold' },
        { id: 'a', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
      ],
    };
    const ok = { 'a-b': [{ id: 'c', rings: [rect(40, 40, 100, 100)] }], a: [{ id: 'd', rings: [rect(40, 40, 100, 100)] }] };
    expect(() => validateCuts(dashed, ok, page)).not.toThrow();
    const clash = { 'a-b': [{ id: 'c', rings: [rect(40, 40, 100, 100)] }], a: [{ id: 'b-c', rings: [rect(40, 40, 100, 100)] }] };
    expect(() => validateCuts(dashed, clash, page)).toThrow(/ply a cut b-c: the diagnostic part id asm-a-b-c is already taken/);
  });

  it('validateAssemblySpec wants a signature box with a positive size, and a nonnegative ply bleed', () => {
    for (const width of [0, -5, Number.NaN]) expect(bad((s) => { s.signature!.box.width = width; })).toThrow(/signature box must have a positive size/);
    for (const height of [0, -5, Number.NaN]) expect(bad((s) => { s.signature!.box.height = height; })).toThrow(/signature box must have a positive size/);
    expect(bad((s) => { s.signature!.box = { x: 150, y: 175, width: 0.1, height: 0.1 }; })).not.toThrow();
    expect(bad((s) => { s.plies[1].bleed = -0.1; })).toThrow(/Ply middle bleed must be nonnegative/);
    expect(bad((s) => { s.plies[1].bleed = Number.NaN; })).toThrow(/Ply middle bleed must be nonnegative/);
    expect(bad((s) => { s.plies[1].bleed = 0; })).not.toThrow();
  });

  it('validateCuts refuses a label the stroke face cannot draw, which would throw in cutGuides', () => {
    const labelled = (label: unknown, kind: Cut['kind'] = 'waste'): Cuts => ({ top: [{ id: 'a', label: label as string, kind, rings: [rect(40, 40, 100, 100)] }] });
    expect(() => validateCuts(spec, labelled('CUT A'), page)).not.toThrow();
    expect(() => validateCuts(spec, labelled('Door 2-B, left (n.1)'), page)).not.toThrow();
    expect(() => validateCuts(spec, labelled('caf\u00e9'), page)).toThrow(/cut a: label has unsupported character U\+00E9/);
    expect(() => validateCuts(spec, labelled('\u65e5\u672c'), page)).toThrow(/cut a: label has unsupported character U\+65E5/);
    expect(() => validateCuts(spec, labelled('caf\u00e9', 'part'), page)).toThrow(/label has unsupported character U\+00E9/); // every cut's label is checked
    expect(() => validateCuts(spec, labelled(42), page)).toThrow(/cut a: label must be a string/);
    expect(() => validateCuts(spec, labelled('x'.repeat(257)), page)).toThrow(/label is longer than 256 characters/);
    expect(() => validateCuts(spec, labelled('x'.repeat(256)), page)).not.toThrow();
    // It names the cut that failed, and is one of the collected problems.
    expect(() => validateCuts(spec, { top: [{ id: 'a', label: '\u00e9', rings: [rect(5, 40, 60, 100)] }] }, page)).toThrow(/unsupported character[\s\S]*page margin/);
    expect(() => cutGuides({ id: 'a', label: 'caf\u00e9', rings: [rect(40, 40, 100, 100)] }, 'black', { ...GUIDE_DEFAULTS, penWidth: 0.35 })).toThrow(/Unsupported stroke character U\+E9/);
  });

  it('validateCuts collects every problem into one error', () => {
    const run = () => validateCuts(spec, { top: [{ id: 'a', rings: [rect(5, 40, 60, 100)] }, { id: 'b', rings: [rect(60, 60, 62, 100)] }] }, page);
    expect(run).toThrow(/page margin[\s\S]*3 mm wide/);
  });

  it('validateCuts warns about an island and about a ply hidden under a ply with no cuts', () => {
    const island = validateCuts(spec, { ...cuts, top: [{ id: 't1', rings: [rect(20, 20, 180, 180), rect(60, 60, 140, 140)] }] }, page);
    expect(island).toHaveLength(1);
    expect(island[0]).toMatch(/ply top cut t1: a hole inside the waste/);
    const hidden = validateCuts(spec, { top: cuts.top }, page);
    expect(hidden).toEqual(['ply bottom is fully hidden: ply middle above it has no cuts']);
    expect(validateCuts(spec, {}, page)).toEqual(['ply bottom is fully hidden: ply middle above it has no cuts', 'ply middle is fully hidden: ply top above it has no cuts']);
  });
});

describe('the window minimum: every window validateCuts accepts, cutGuides can mark', () => {
  const options = { ...GUIDE_DEFAULTS, penWidth: inkPen('black').width };
  const felt: Pen = { id: 'felt', color: '#222222', width: 1.2 };
  const allPens = [...pens, felt];

  it('a 50 mm long window at 3.0, 3.4 and 3.8 mm wide validates and renders its guides', () => {
    for (const w of [3.0, 3.4, 3.8]) {
      const cut: Cut = { id: 'w', rings: [rect(20, 20, 20 + w, 70)] };
      const world = { cuts: { top: [cut] }, art: {} };
      expect(() => validateCuts(spec, world.cuts, page, pens)).not.toThrow();
      const guide = renderPly(spec, { params: { ply: 'top' }, page }, pens, world).find((p) => p.id === 'cut-w')!;
      expect(guide.paths.length).toBeGreaterThanOrEqual(3); // the outline and the strokes of at least one X
    }
  });

  it('a window of 2.8 mm is refused by both, and one wider than 3 mm is refused when a wide pen cannot mark it', () => {
    expect(() => validateCuts(spec, { top: [{ id: 'w', rings: [rect(20, 20, 22.8, 70)] }] }, page, pens)).toThrow(/the window is nowhere 3 mm wide/);
    expect(() => cutGuides({ id: 'w', rings: [rect(20, 20, 22.8, 70)] }, 'black', options)).toThrow(/no room for an X mark/);
    // A 1.2 mm pen needs a clearance of 0.75 + 0.6 + 0.5 = 1.85, a 3.7 mm window: 3.4 mm is wide enough for the 0.35 pen only.
    const wide = structuredClone(spec);
    wide.plies[2].cutInk = 'felt';
    const cut: Cut = { id: 'w', rings: [rect(20, 20, 23.4, 70)] };
    expect(() => validateCuts(spec, { top: [cut] }, page, allPens)).not.toThrow();
    expect(() => validateCuts(wide, { top: [cut] }, page, allPens)).toThrow(/ply top cut w: the window is nowhere 3.7 mm wide \(greatest inscribed clearance 1.70 mm, under 1.85 mm\)/);
    expect(() => cutGuides(cut, 'black', { ...options, penWidth: 1.2 })).toThrow(/no room for an X mark/);
    expect(() => validateCuts(wide, { top: [{ id: 'w', rings: [rect(20, 20, 23.8, 70)] }] }, page, allPens)).not.toThrow();
    expect(() => cutGuides({ id: 'w', rings: [rect(20, 20, 23.8, 70)] }, 'black', { ...options, penWidth: 1.2 })).not.toThrow();
  });

  it('a part or piece (no X marks) keeps the plain 3 mm floor whatever the pen', () => {
    const wide = structuredClone(spec);
    wide.plies[1].cutInk = 'felt';
    expect(() => validateCuts(wide, { middle: [{ id: 'p', kind: 'part', rings: [rect(20, 20, 23.2, 70)] }] }, page, allPens)).not.toThrow();
  });

  it('property: over random rectangles and rotated strips and three pens, validateCuts OK means cutGuides marks it', () => {
    const rng = mulberry32(99);
    let accepted = 0, rejected = 0;
    for (let n = 0; n < 240; n++) {
      const ink = ['black', 'gold', 'felt'][n % 3];
      const w = 2.4 + rng() * 3.2, len = 20 + rng() * 60;
      const angle = n % 2 === 0 ? 0 : rng() * Math.PI;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const ring = ([[-len / 2, -w / 2], [len / 2, -w / 2], [len / 2, w / 2], [-len / 2, w / 2]] as [number, number][]).map(([u, v]) => P(100 + u * cos - v * sin, 100 + u * sin + v * cos));
      const inked: AssemblySpec = { ...spec, plies: spec.plies.map((ply) => (ply.id === 'top' ? { ...ply, cutInk: ink } : ply)) };
      const cut: Cut = { id: 'r', rings: [ring] };
      let valid = true;
      try { validateCuts(inked, { top: [cut] }, page, allPens); } catch { valid = false; }
      if (!valid) { rejected++; continue; }
      accepted++;
      expect(() => cutGuides(cut, 'black', { ...GUIDE_DEFAULTS, penWidth: allPens.find((pen) => pen.id === ink)!.width }), `${ink} w=${w} angle=${angle}`).not.toThrow();
    }
    expect(accepted).toBeGreaterThan(60);
    expect(rejected).toBeGreaterThan(60);
  });

  it('does not reject a diamond the 0.5 mm grid under-measures', () => {
    // Inscribed clearance 2.2 / sqrt 2 = 1.556: the grid points nearest the centre are only 1.27..1.41 from the edges.
    const diamond = (r: number): Point[] => [P(50, 50 - r), P(50 + r, 50), P(50, 50 + r), P(50 - r, 50)];
    const cut: Cut = { id: 'd', rings: [diamond(2.2)] };
    expect(() => validateCuts(spec, { top: [cut] }, page)).not.toThrow();
    expect(() => validateCuts(spec, { top: [cut] }, page, pens)).not.toThrow();
    expect(cutGuides(cut, 'black', options).paths.length).toBeGreaterThanOrEqual(3);
    expect(() => validateCuts(spec, { top: [{ id: 'd', rings: [diamond(2.0)] }] }, page)).toThrow(/3 mm wide/); // 1.414: really too narrow
    // 2.125 / sqrt 2 = 1.5026, just over the floor: the centre is 0.125 off the 0.5 grid, which only the finer refinement lands on.
    expect(() => validateCuts(spec, { top: [{ id: 'd', rings: [diamond(2.125)] }] }, page)).not.toThrow();
    expect(() => validateCuts(spec, { top: [{ id: 'd', rings: [diamond(2.115)] }] }, page)).toThrow(/3 mm wide/); // 1.4956: just under
  });
});

describe('renderPly', () => {
  const art = (pen: string, id: string): Part => ({ id, pen, paths: Array.from({ length: 40 }, (_, i) => line(0, 10 + i * 4.5, 200, 10 + i * 4.5)) });
  const world = { cuts, art: { bottom: [art('gold', 'gold-lines')], middle: [art('black', 'black-lines')], top: [art('carbon', 'carbon-lines')] } };
  const render = (ply: string, w = world) => renderPly(spec, { params: { ply } }, pens, w);

  it('clips each ply’s art to what it shows', () => {
    const bottom = render('bottom').find((p) => p.id === 'gold-lines')!;
    expect(bottom.pen).toBe('gold');
    expect(bottom.paths.length).toBeGreaterThan(5);
    for (const path of bottom.paths) for (const p of path) {
      expect(rectDist(p, M)).toBeLessThan(MIDDLE_BLEED + 1e-6);
      expect(rectDist(p, T)).toBeLessThan(BLEED + 1e-6);
    }
    // Drops a part that clips to nothing.
    const out = renderPly(spec, { params: { ply: 'bottom' } }, pens, { cuts, art: { bottom: [{ id: 'far', pen: 'gold', paths: [line(0, 5, 200, 5)] }] } });
    expect(out.find((p) => p.id === 'far')).toBeUndefined();
  });

  it('adds the guides of the ply’s own cuts only, in the cut pen', () => {
    expect(render('bottom').filter((p) => p.id.startsWith('cut-'))).toEqual([]);
    const middle = render('middle').filter((p) => p.id.startsWith('cut-'));
    expect(middle.map((p) => [p.id, p.pen])).toEqual([['cut-m1', 'black']]);
    expect(render('top').filter((p) => p.id.startsWith('cut-')).map((p) => p.id)).toEqual(['cut-t1']);
    // The guide is sized by the ply's cutInk: gold (0.5) on a black ply is not the fineliner (0.35).
    const goldSpec = structuredClone(spec);
    goldSpec.plies[1].cutInk = 'gold';
    const fine = renderPly(spec, { params: { ply: 'middle' } }, pens, world).find((p) => p.id === 'cut-m1')!;
    const gel = renderPly(goldSpec, { params: { ply: 'middle' } }, pens, world).find((p) => p.id === 'cut-m1')!;
    expect(fine.paths[0][0].x).toBeCloseTo(40 + 0.175, 9);
    expect(gel.paths[0][0].x).toBeCloseTo(40 + 0.25, 9);
    // Partial guide options override the defaults.
    expect(renderPly(spec, { params: { ply: 'middle' } }, pens, world, { label: false }).find((p) => p.id === 'cut-m1')!.paths.length)
      .toBeLessThan(fine.paths.length);
  });

  it('every ply draws the same asm-* diagnostics, for every cut of every ply and the signature', () => {
    const diagnostics = (ply: string) => render(ply).filter((p) => p.id.startsWith('asm-'));
    const top = diagnostics('top');
    expect(top.map((p) => p.id)).toEqual(['asm-middle-m1', 'asm-top-t1', 'asm-signature']);
    expect(top.every((p) => p.diagnostic === true && p.pen === 'black')).toBe(true);
    expect(top[0].paths).toEqual([[...WINDOW_M, WINDOW_M[0]]]);
    expect(top[2].paths).toEqual([[P(150, 175), P(180, 175), P(180, 185), P(150, 185), P(150, 175)]]);
    for (const ply of ['bottom', 'middle']) expect(diagnostics(ply)).toEqual(top);
    expect(render('top').map((p) => p.id)).toContain('carbon-lines');
  });

  it('throws for an unknown ply, or art in a pen the ply does not carry', () => {
    expect(() => render('attic')).toThrow(/Unknown ply: attic/);
    expect(() => render('bottom', { cuts, art: { bottom: [art('carbon', 'wrong')], middle: [], top: [] } })).toThrow(/pen carbon, which ply bottom does not carry/);
    expect(() => renderPly({ ...spec, plies: spec.plies.map((p) => ({ ...p, cutInk: 'gold', pens: p.pens })) }, { params: { ply: 'top' } }, [pens[1], pens[2]], world)).toThrow(/cutInk gold is not a declared pen/);
  });
});

describe('renderPly checks its world before it draws', () => {
  const felt: Pen = { id: 'felt', color: '#222222', width: 1.2 };
  const part = (id: string, pen = 'carbon'): Part => ({ id, pen, paths: [line(0, 150, 200, 150)] });
  const run = (world: { cuts?: Cuts; art?: Record<string, Part[]>; sealed?: Record<string, Part[]> }, ctx: { page?: typeof page } = {}, s: AssemblySpec = spec, ply = 'top') =>
    () => renderPly(s, { params: { ply }, ...ctx }, [...pens, felt], { cuts, art: {}, ...world });

  it('validates the cuts with the guide pen widths, and the page margin only when a page is known', () => {
    const narrow: Cuts = { ...cuts, top: [{ id: 's', rings: [rect(20, 20, 22.5, 70)] }] };
    expect(run({ cuts: narrow })).toThrow(/ply top cut s: the window is nowhere 3 mm wide/);
    // The cuts of every ply are checked whichever ply is rendered, so all the plies of a world are accepted or refused alike.
    expect(run({ cuts: { ...cuts, middle: narrow.top } }, {}, spec, 'bottom')).toThrow(/ply middle cut s: the window is nowhere 3 mm wide/);
    // A wide cut ink needs a wider window than the same cut in a fine one.
    const wideInk = structuredClone(spec);
    wideInk.plies[2].cutInk = 'felt';
    const slot: Cuts = { ...cuts, top: [{ id: 's', rings: [rect(20, 20, 23.4, 70)] }] };
    expect(run({ cuts: slot })).not.toThrow();
    expect(run({ cuts: slot }, {}, wideInk)).toThrow(/ply top cut s: the window is nowhere 3.7 mm wide/);
    // The page margin: a cut at x = 5 is outside a 10 mm margin only if the page is given.
    const edge: Cuts = { ...cuts, top: [{ id: 'e', rings: [rect(5, 20, 60, 70)] }] };
    expect(run({ cuts: edge }, { page })).toThrow(/ply top cut e: vertex \(5, 20\) is outside the 10 mm page margin/);
    expect(run({ cuts: edge })).not.toThrow();
    expect(run({ cuts: { ...cuts, attic: [] } })).toThrow(/Cuts name an unknown ply: attic/);
  });

  it('refuses art or sealed art keyed by something that is not a ply', () => {
    expect(run({ art: { top: [], attic: [] } })).toThrow(/World art names an unknown ply: attic/);
    expect(run({ sealed: { attic: [part('word')] } })).toThrow(/World sealed art names an unknown ply: attic/);
    expect(run({ art: { toString: [] } })).toThrow(/World art names an unknown ply: toString/);
    expect(run({ art: { top: [part('ok')] }, sealed: { top: [part('word')] } })).not.toThrow();
  });

  it('refuses a part id that starts with asm-, cut- or place-, on any ply and in art or sealed art', () => {
    for (const id of ['asm-x', 'cut-w', 'place-bar']) {
      expect(run({ art: { top: [part(id)] } }), id).toThrow(/World art part .* uses the reserved id prefix/);
      expect(run({ sealed: { top: [part(id)] } }), id).toThrow(/World sealed art part .* uses the reserved id prefix/);
      expect(run({ art: { bottom: [part(id, 'gold')] } }), id).toThrow(/reserved id prefix/); // art for a ply this render is not
    }
    for (const id of ['asmodeus', 'cutlery', 'places', 'a-asm-', 'cut']) expect(run({ art: { top: [part(id)] } }), id).not.toThrow();
  });

  it('refuses a signature box that is not on the page, when the page is known', () => {
    const off = (box: { x: number; y: number; width: number; height: number }): AssemblySpec => ({ ...spec, signature: { ...spec.signature!, box } });
    expect(run({}, { page })).not.toThrow();
    expect(run({}, { page }, off({ x: 175, y: 175, width: 30, height: 10 }))).toThrow(/signature box lies outside the 200 x 200 mm page/);
    expect(run({}, { page }, off({ x: 150, y: 195, width: 30, height: 10 }))).toThrow(/signature box lies outside/);
    expect(run({}, { page }, off({ x: -1, y: 175, width: 30, height: 10 }))).toThrow(/signature box lies outside/);
    expect(run({}, { page }, off({ x: 150, y: -1, width: 30, height: 10 }))).toThrow(/signature box lies outside/);
    expect(run({}, { page }, off({ x: 170, y: 190, width: 30, height: 10 }))).not.toThrow(); // flush with the corner
    expect(run({}, {}, off({ x: 175, y: 175, width: 30, height: 10 }))).not.toThrow(); // no page, no check
  });
});

describe('materials', () => {
  it('has the three papers and the ink table', () => {
    expect(Object.fromEntries(Object.entries(PAPERS).map(([id, paper]) => [id, paper.color]))).toEqual({ black: '#141416', 'gold-yellow': '#e0b13a', white: '#f7f6f2' });
    const table = Object.fromEntries(['gold', 'silver', 'fluoro-pink', 'fluoro-orange', 'fluoro-green', 'fluoro-yellow', 'black'].map((id) => [id, [INKS[id].color, INKS[id].reads, INKS[id].trial ?? []]]));
    expect(table).toEqual({
      gold: ['#c9a54a', ['black'], ['gold-yellow']], silver: ['#c4c8cc', ['black'], ['white']],
      'fluoro-pink': ['#ff4fa3', ['black'], ['white']], 'fluoro-orange': ['#ff8a2a', ['black'], ['white']],
      'fluoro-green': ['#7dff5a', ['black'], []], 'fluoro-yellow': ['#f2ff3a', ['black'], []], black: ['#1c1c1e', ['gold-yellow', 'white'], []],
    });
    expect(INKS.black.width).toBe(0.35);
    for (const id of ['gold', 'silver', 'fluoro-pink', 'fluoro-orange', 'fluoro-green', 'fluoro-yellow']) {
      expect(INKS[id].width).toBe(0.5);
      expect(INKS[id].note).toMatch(/placeholder until the calibration plot/);
    }
  });

  it('carries the Breach inks with the colours the cards declare', () => {
    const fool = readFileSync(resolve(import.meta.dirname, '../../sketches/breach-tarot/0-fool/sketch.ts'), 'utf8');
    for (const id of ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet']) expect(fool).toContain(`id: '${id}', color: '${INKS[id].color}'`);
    expect(INKS.carbon.reads).toEqual(['white', 'gold-yellow']);
    for (const id of ['ultramarine', 'vermilion', 'acid', 'violet']) expect(INKS[id].reads).toEqual(['white']);
  });

  it('inkPen gives a declarable pen, and inkReads answers by paper', () => {
    expect(inkPen('gold')).toEqual({ id: 'gold', color: '#c9a54a', width: 0.5 });
    expect(inkPen('black')).toEqual({ id: 'black', color: '#1c1c1e', width: 0.35 });
    expect(() => inkPen('nope')).toThrow(/Unknown ink/);
    expect(inkReads('gold', 'black')).toBe(true);
    expect(inkReads('gold', 'gold-yellow')).toBe(false); // on trial there, not read
    expect(inkReads('black', 'white')).toBe(true);
    expect(inkReads('carbon', 'gold-yellow')).toBe(true);
    expect(() => inkReads('nope', 'white')).toThrow(/Unknown ink/);
    expect(() => inkReads('gold', 'cream')).toThrow(/Unknown paper/);
    for (const id of Object.keys(INKS)) expect(() => validateSketch({ name: 'x', page, pens: [inkPen(id)], controls: [], draw: () => [] })).not.toThrow();
  });
});

describe('part cuts: cut out and kept', () => {
  const part = (kind: Cut['kind'] = 'part'): Cut => ({ id: 'p1', kind, rings: [WINDOW_T] });
  /** Distance from a point to the rectangle's outline, inside or out. */
  const boundaryDist = (p: Point, r: R) => (rectDist(p, r) > 0 ? rectDist(p, r) : Math.min(p.x - r.x0, r.x1 - p.x, p.y - r.y0, r.y1 - p.y));

  it('keeps art on both sides of a part cut, except within the margin of its edge', () => {
    const region = plyRegion(noSignature, { top: [part()] }, 'top');
    expect(clipToRegion([line(0, 100, 200, 100)], region).map((path) => path.map((p) => p.x))).toEqual([[0, 60 - MARGIN], [60 + MARGIN, 160 - MARGIN], [160 + MARGIN, 200]]);
    // A window of the same outline throws away what is inside, which is the difference.
    expect(clipToRegion([line(0, 100, 200, 100)], plyRegion(noSignature, { top: [part('waste')] }, 'top')).map((path) => path.map((p) => p.x))).toEqual([[0, 60 - MARGIN], [160 + MARGIN, 200]]);
    // Kind-less cuts are windows.
    expect(plyRegion(noSignature, { top: [{ id: 'p1', rings: [WINDOW_T] }] }, 'top')).toEqual(plyRegion(noSignature, { top: [part('waste')] }, 'top'));
  });

  it('matches an independent outline-distance oracle on random lines, inside and out', () => {
    const rng = mulberry32(31);
    const segments = Array.from({ length: 60 }, () => line(rng() * 200, rng() * 200, rng() * 200, rng() * 200));
    const { kept, total } = expectMatchesOracle(plyRegion(noSignature, { top: [part()] }, 'top'), (p) => boundaryDist(p, T) >= MARGIN - 1e-6, segments);
    expect(kept).toBeGreaterThan(total * 0.5);
    expect(kept).toBeLessThan(total);
  });

  it('lets the plies below see through a part cut, with bleed, exactly as through a window', () => {
    const rng = mulberry32(8);
    const segments = Array.from({ length: 30 }, () => line(rng() * 200, rng() * 200, rng() * 200, rng() * 200));
    const asPart = plyRegion(noSignature, { middle: cuts.middle, top: [part()] }, 'bottom'), asWindow = plyRegion(noSignature, { middle: cuts.middle, top: [part('waste')] }, 'bottom');
    expect(clipToRegion(segments, asPart)).toEqual(clipToRegion(segments, asWindow));
    const across = clipToRegion([line(0, 100, 200, 100)], asPart);
    expect(across).toHaveLength(1);
    exact(across[0][0].x, 60 - BLEED);
    exact(across[0][1].x, 140 + MIDDLE_BLEED);
  });

  it('draws the boundary ring itself as the guide: closed, uninset, with no X marks or label', () => {
    const options = { ...GUIDE_DEFAULTS, penWidth: 0.35 };
    for (const ring of [WINDOW_T, [...WINDOW_T].reverse()]) {
      const cut: Cut = { id: 'p1', kind: 'part', rings: [ring] };
      expect(cutGuides(cut, 'black', options)).toEqual({ id: 'cut-p1', pen: 'black', paths: [[...ring, ring[0]]], boundary: [ring] });
    }
    const ringed: Cut = { id: 'p2', kind: 'part', label: 'CUT A', rings: [rect(40, 40, 140, 140), rect(60, 60, 120, 120)] };
    const guide = cutGuides(ringed, 'black', options);
    expect(guide.paths).toEqual(ringed.rings.map((ring) => [...ring, ring[0]]));
    expect(guide.boundary).toEqual(ringed.rings);
    // Through renderPly it is the ply's own cut guide, drawn on the cut pen.
    const world = { cuts: { middle: [part()], top: [] }, art: {} };
    const parts = renderPly(spec, { params: { ply: 'middle' } }, pens, world);
    expect(parts.find((p) => p.id === 'cut-p1')!.paths).toEqual([[...WINDOW_T, WINDOW_T[0]]]);
  });

  it('is checked like any cut, without the loose-island warning', () => {
    const holed: Cut = { id: 'p1', kind: 'part', rings: [rect(20, 20, 180, 180), rect(60, 60, 140, 140)] };
    expect(validateCuts(spec, { middle: [holed], top: cuts.top }, page)).toEqual([]);
    expect(() => validateCuts(spec, { middle: [{ id: 'p1', kind: 'part', rings: [rect(60, 60, 62.9, 120)] }], top: cuts.top }, page)).toThrow(/ply middle cut p1: the part is nowhere 3 mm wide/);
    expect(() => validateCuts(spec, { top: [{ id: 'p1', kind: 'sticker' as Cut['kind'], rings: [WINDOW_T] }] }, page)).toThrow(/unknown cut kind sticker/);
    // A part cut counts as a window in a ply above, so it does not hide the plies below.
    expect(validateCuts(spec, { middle: [part()], top: [part()] }, page)).toEqual([]);
  });
});

describe('onlay plies', () => {
  const lintel: AssemblySpec = {
    control: 'ply', cutPen: 'black', margin: MARGIN, bleed: BLEED,
    plies: [
      { id: 'black', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold' },
      { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
      { id: 'bar', paper: { id: 'black', color: PAPERS.black.color }, pens: [], cutInk: 'gold', onlay: { from: 'lintel-l/black/bar' } },
    ],
  };
  const BAR = rect(40, 80, 160, 92);
  const footprint = (rings: Point[][] = [BAR]): Cut => ({ id: 'bar', kind: 'footprint', rings });
  const lintelCuts: Cuts = { white: [{ id: 'w', rings: [rect(30, 120, 170, 180)] }], bar: [footprint()] };
  const lintelControls = (): Control[] => [plyControl(lintel)];
  const xs = (paths: Point[][]) => paths.map((path) => path.map((p) => p.x));
  const ys = (paths: Point[][]) => paths.map((path) => path.map((p) => p.y));

  it('validateAssemblySpec accepts an onlay with no pens, and rejects an empty source or a signature on it', () => {
    expect(() => validateAssemblySpec(lintel, pens, lintelControls())).not.toThrow();
    const edit = (mutate: (s: AssemblySpec) => void) => () => { const copy = structuredClone(lintel); mutate(copy); validateAssemblySpec(copy, pens, lintelControls()); };
    expect(edit((s) => { s.plies[2].onlay = { from: '  ' }; })).toThrow(/onlay needs a nonempty from/);
    expect(edit((s) => { s.plies[2].onlay = {} as { from: string }; })).toThrow(/onlay needs a nonempty from/);
    expect(edit((s) => { s.signature = { ply: 'bar', pen: 'carbon', box: { x: 100, y: 100, width: 10, height: 5 } }; })).toThrow(/signature ply bar is an onlay/);
    expect(edit((s) => { s.signature = { ply: 'white', pen: 'carbon', box: { x: 100, y: 100, width: 10, height: 5 } }; })).not.toThrow();
  });

  it('validateCuts wants exactly one footprint cut on an onlay ply, and footprints only there', () => {
    expect(validateCuts(lintel, lintelCuts, page)).toEqual([]);
    expect(() => validateCuts(lintel, { white: lintelCuts.white }, page)).toThrow(/ply bar is an onlay and needs exactly one footprint cut \(it has 0\)/);
    expect(() => validateCuts(lintel, { ...lintelCuts, bar: [footprint(), { ...footprint([rect(100, 20, 150, 40)]), id: 'bar2' }] }, page)).toThrow(/needs exactly one footprint cut \(it has 2\)/);
    expect(() => validateCuts(lintel, { ...lintelCuts, bar: [{ ...footprint(), kind: 'part' }] }, page)).toThrow(/an onlay ply carries only its footprint, not a part cut/);
    expect(() => validateCuts(lintel, { ...lintelCuts, bar: [{ id: 'bar', rings: [BAR] }] }, page)).toThrow(/not a waste cut/);
    expect(() => validateCuts(lintel, { ...lintelCuts, white: [{ id: 'w', kind: 'footprint', rings: [rect(30, 120, 170, 180)] }] }, page)).toThrow(/ply white cut w: a footprint cut belongs on an onlay ply/);
    // The footprint is checked like any cut: inside the page margin, and wide enough to carry the marks.
    expect(() => validateCuts(lintel, { ...lintelCuts, bar: [footprint([rect(5, 80, 160, 92)])] }, page)).toThrow(/page margin/);
    expect(() => validateCuts(lintel, { ...lintelCuts, bar: [footprint([rect(40, 80, 160, 82.5)])] }, page)).toThrow(/the piece is nowhere 3 mm wide/);
    // An onlay is a cut for hiding purposes: it does not blanket the plies below.
    expect(validateCuts(lintel, { bar: [footprint()] }, page)).toEqual(['ply black is fully hidden: ply white above it has no cuts']);
  });

  it('shows lower art outside the footprint, and within the onlay’s bleed of its edge, exactly', () => {
    const region = plyRegion(lintel, lintelCuts, 'white');
    // Along y = 86 the piece covers x in 40..160; the paper shows within 1 mm of each end.
    expect(xs(clipToRegion([line(0, 86, 200, 86)], region))).toEqual([[0, 40 + BLEED], [160 - BLEED, 200]]);
    // Down x = 100 the piece covers y in 80..92, and white's own window (120..180) takes its margin band out of the art.
    expect(ys(clipToRegion([line(100, 0, 100, 200)], region)).map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)))
      .toEqual([[0, 80 + BLEED], [92 - BLEED, 120 - MARGIN], [180 + MARGIN, 200]]);
    // Just outside the piece, or within the bleed of its long edge, is all visible.
    expect(xs(clipToRegion([line(0, 79.5, 200, 79.5)], region))).toEqual([[0, 200]]);
    expect(xs(clipToRegion([line(0, 80.5, 200, 80.5)], region))).toEqual([[0, 200]]);
    // The onlay's own bleed overrides the assembly's, like any ply's.
    const wide = structuredClone(lintel);
    wide.plies[2].bleed = 2;
    expect(xs(clipToRegion([line(0, 86, 200, 86)], plyRegion(wide, lintelCuts, 'white')))).toEqual([[0, 42], [158, 200]]);
  });

  it('matches an independent oracle for the plies below an onlay', () => {
    const rng = mulberry32(44);
    const segments = Array.from({ length: 60 }, () => line(rng() * 200, rng() * 200, rng() * 200, rng() * 200));
    const bar = { x0: 40, y0: 80, x1: 160, y1: 92 };
    const white = { x0: 30, y0: 120, x1: 170, y1: 180 };
    const covered = (p: Point) => rectDist(p, bar) === 0 && Math.min(p.x - bar.x0, bar.x1 - p.x, p.y - bar.y0, bar.y1 - p.y) >= BLEED; // under the piece, past the bleed band
    // The black ply shows through white's window, grown by the assembly's bleed, and wherever the bar does not cover it.
    const { kept, total } = expectMatchesOracle(plyRegion(lintel, lintelCuts, 'black'), (p) => (rectDist(p, white) < BLEED + 1e-6) && !covered(p), segments);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(total * 0.5);
  });

  it('renderPly refuses an onlay ply, naming its source', () => {
    expect(() => renderPly(lintel, { params: { ply: 'bar' } }, pens, { cuts: lintelCuts, art: {} })).toThrow('ply bar is an onlay, plotted and cut on lintel-l/black/bar');
  });

  it('puts the footprint in every ply’s diagnostics like any other cut', () => {
    const world = { cuts: lintelCuts, art: {} };
    const diag = (ply: string) => renderPly(lintel, { params: { ply } }, pens, world).filter((p) => p.id.startsWith('asm-'));
    expect(diag('white').map((p) => p.id)).toEqual(['asm-white-w', 'asm-bar-bar']);
    expect(diag('white')[1].paths).toEqual([[...BAR, BAR[0]]]);
    expect(diag('black')).toEqual(diag('white'));
  });

  describe('placement marks', () => {
    const marksFor = (rings: Point[][], ply = 'white') => {
      const parts = renderPly(lintel, { params: { ply } }, pens, { cuts: { ...lintelCuts, bar: [footprint(rings)] }, art: {} });
      return parts.find((p) => p.id === 'place-bar');
    };
    const clear = (rings: Point[][], paths: Point[][]) => {
      for (const path of paths) for (const p of path) {
        expect(inRegion(p, { rings })).toBe(true);
        expect(distanceToRings(p, rings)).toBeGreaterThanOrEqual(1.5 - 1e-6);
      }
    };

    it('are L-shaped ticks with 3 mm arms at each corner of the footprint, inset 1.5 mm, on the cut pen', () => {
      const place = marksFor([BAR])!;
      expect(place.pen).toBe('black');
      expect(place.diagnostic).toBeUndefined();
      expect(place.paths).toHaveLength(4);
      const corners = place.paths.map((path) => path[1]);
      expect(corners).toEqual([P(41.5, 81.5), P(158.5, 81.5), P(158.5, 90.5), P(41.5, 90.5)]);
      for (const path of place.paths) {
        expect(path).toHaveLength(3);
        exact(Math.hypot(path[0].x - path[1].x, path[0].y - path[1].y), 3);
        exact(Math.hypot(path[2].x - path[1].x, path[2].y - path[1].y), 3);
      }
      expect(place.paths[0]).toEqual([P(44.5, 81.5), P(41.5, 81.5), P(41.5, 84.5)]);
      clear([BAR], place.paths);
    });

    it('are under the onlay on purpose: the onlay does not clip them, though it would', () => {
      const place = marksFor([BAR])!;
      const region = plyRegion(lintel, { ...lintelCuts, bar: [footprint()] }, 'white');
      for (const path of place.paths) expect(inRegion(path[1], region)).toBe(false); // clipped by the visible region they would vanish
      expect(clipToRegion(place.paths, region)).toEqual([]);
    });

    it('go on the ply directly below the onlay only', () => {
      expect(marksFor([BAR], 'black')).toBeUndefined();
      expect(marksFor([BAR], 'white')).toBeDefined();
    });

    it('skip the reflex corner of an L, and stay inside and 1.5 mm from every edge', () => {
      const ell = [P(40, 40), P(120, 40), P(120, 52), P(52, 52), P(52, 120), P(40, 120)];
      const place = marksFor([ell])!;
      expect(place.paths).toHaveLength(5); // six vertices, one of them reflex
      expect(place.paths.some((path) => Math.hypot(path[1].x - 52, path[1].y - 52) < 3)).toBe(false);
      clear([ell], place.paths);
    });

    it('shorten a tick rather than let it out of a sharp or thin piece', () => {
      const triangle = [P(40, 40), P(160, 40), P(100, 60)];
      const sharp = marksFor([triangle])!;
      expect(sharp.paths.length).toBeGreaterThanOrEqual(3);
      clear([triangle], sharp.paths);
      const thin = [P(40, 80), P(160, 80), P(160, 84), P(40, 84)]; // 4 mm tall: the 1.5 mm inset leaves 1 mm
      const strip = marksFor([thin])!;
      expect(strip.paths.length).toBeGreaterThanOrEqual(2);
      clear([thin], strip.paths);
    });

    it('fall back to the bounding-box corners for a smooth footprint', () => {
      const blob = Array.from({ length: 64 }, (_, i) => P(100 + 20 * Math.cos((i / 64) * 2 * Math.PI), 100 + 20 * Math.sin((i / 64) * 2 * Math.PI)));
      const place = marksFor([blob])!;
      expect(place.paths).toHaveLength(4);
      clear([blob], place.paths);
      // One tick in each quadrant.
      expect(new Set(place.paths.map((path) => `${path[1].x > 100}${path[1].y > 100}`)).size).toBe(4);
    });

    it('handle a footprint with a hole by keeping clear of it too', () => {
      const ring = [rect(40, 60, 160, 100), rect(80, 70, 120, 90)];
      const place = marksFor(ring)!;
      clear(ring, place.paths);
      expect(place.paths).toHaveLength(4); // the outer corners: the piece wraps 270 degrees round each corner of the hole
    });
  });
});

describe('sealed art', () => {
  const lintel: AssemblySpec = {
    control: 'ply', cutPen: 'black', margin: MARGIN, bleed: BLEED,
    plies: [
      { id: 'black', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold' },
      { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
      { id: 'bar', paper: { id: 'black', color: PAPERS.black.color }, pens: [], cutInk: 'gold', onlay: { from: 'lintel-l/black/bar' } },
    ],
    signature: { ply: 'white', pen: 'carbon', box: { x: 150, y: 20, width: 30, height: 10 } },
  };
  const cutsL: Cuts = { white: [{ id: 'w', rings: [rect(30, 120, 170, 180)] }], bar: [{ id: 'bar', kind: 'footprint', rings: [rect(40, 80, 160, 92)] }] };
  const word = (id: string, y = 86): Part => ({ id, pen: 'carbon', paths: [line(60, y, 140, y)] });
  const render = (world: { art: Record<string, Part[]>; sealed?: Record<string, Part[]> }) =>
    renderPly(lintel, { params: { ply: 'white' } }, pens, { cuts: cutsL, ...world });

  it('survives under an onlay on the lower ply, where the same part in art is clipped away', () => {
    const sealed = render({ art: {}, sealed: { white: [word('word')] } });
    expect(sealed.find((p) => p.id === 'word')!.paths).toEqual([line(60, 86, 140, 86)]);
    expect(render({ art: { white: [word('word')] } }).find((p) => p.id === 'word')).toBeUndefined();
  });

  it('is clipped by its own ply’s cuts and signature, but never by the plies above', () => {
    const across = (y: number) => render({ art: {}, sealed: { white: [{ id: 'across', pen: 'carbon', paths: [line(0, y, 200, y)] }] } }).find((p) => p.id === 'across')!.paths;
    // y = 150 crosses white's own window (30..170): the window and its margin band come out.
    const xs = (y: number) => across(y).map((path) => path.map((p) => Math.round(p.x * 1e9) / 1e9));
    expect(xs(150)).toEqual([[0, 30 - MARGIN], [170 + MARGIN, 200]]);
    // y = 25 crosses the signature box (150..180 wide).
    expect(xs(25)).toEqual([[0, 150], [180, 200]]);
    // y = 86 is under the onlay and outside every ply above's windows: all of it stays.
    expect(xs(86)).toEqual([[0, 200]]);
  });

  it('carries the other fields of a part, drops one that clips to nothing, and checks the pen', () => {
    const lettered: Part = { ...word('word'), boundary: [rect(60, 80, 140, 92)] };
    expect(render({ art: {}, sealed: { white: [lettered] } }).find((p) => p.id === 'word')!.boundary).toEqual(lettered.boundary);
    const gone: Part = { id: 'gone', pen: 'carbon', paths: [line(155, 25, 175, 25)] }; // inside the signature box
    expect(render({ art: {}, sealed: { white: [gone] } }).find((p) => p.id === 'gone')).toBeUndefined();
    expect(() => render({ art: {}, sealed: { white: [{ id: 'wrong', pen: 'gold', paths: [line(60, 86, 140, 86)] }] } })).toThrow(/pen gold, which ply white does not carry/);
  });

  it('is optional: a world without it renders as before', () => {
    expect(() => render({ art: { white: [word('word', 150)] } })).not.toThrow();
  });
});

describe('an assembly sketch end to end', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });
  const assemblyModule = resolve(import.meta.dirname, '../sketch/assembly.ts');
  const materialsModule = resolve(import.meta.dirname, '../sketch/materials.ts');

  async function fixture(withAssembly: boolean, options = ''): Promise<string> {
    dir ??= await mkdtemp(join(tmpdir(), 'hatch3d-assembly-'));
    const path = join(dir, `${withAssembly ? 'assembly' : 'plain'}${options ? '-bad' : ''}.ts`);
    await writeFile(path, `import { plyControl, renderPly } from ${JSON.stringify(assemblyModule)};
      import { inkPen } from ${JSON.stringify(materialsModule)};
      const pens = [inkPen('gold'), inkPen('black'), inkPen('carbon')];
      const ASSEMBLY = { control: 'ply', cutPen: 'black', margin: 1.5, bleed: 1, plies: [
        { id: 'bottom', paper: { id: 'black', color: '#141416' }, pens: ['gold'], cutInk: 'gold' },
        { id: 'top', paper: { id: 'white', color: '#f7f6f2' }, pens: ['carbon'], cutInk: 'black' } ] };
      const ring = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const lines = Array.from({ length: 30 }, (_, i) => [{ x: 0, y: 5 + i * 6 }, { x: 200, y: 5 + i * 6 }]);
      export default {
        name: 'assembly-fixture', page: { width: 200, height: 200, margin: 10, paper: '#ffffff' }, pens,
        controls: [${options || 'plyControl(ASSEMBLY)'}], ${withAssembly ? 'assembly: ASSEMBLY,' : ''}
        draw(ctx) {
          const world = { cuts: { top: [{ id: 'w', rings: [ring(50, 50, 150, 150)] }] }, art: { bottom: [{ id: 'gold-lines', pen: 'gold', paths: lines }], top: [{ id: 'carbon-lines', pen: 'carbon', paths: lines }] } };
          return renderPly(ASSEMBLY, ctx, pens, world);
        },
      };`);
    return path;
  }

  it('keeps assembly out of the metadata and the identity, and renders every ply', async () => {
    const [withAssembly, plain] = await Promise.all([fixture(true), fixture(false)]);
    const results = await Promise.all(['bottom', 'top'].map((ply) => renderSketch({ entry: withAssembly, params: { ply }, timeoutMs: 120_000 })));
    const [bottom, top] = results;
    expect(Object.keys(bottom.metadata)).not.toContain('assembly');
    expect(JSON.stringify(bottom.metadata)).not.toMatch(/plies|cutPen|margin":1.5/);
    const reference = await renderSketch({ entry: plain, params: { ply: 'bottom' }, timeoutMs: 120_000 });
    expect(bottom.identity).toBe(reference.identity);
    expect(bottom.svg).toBe(reference.svg);
    expect(top.identity).not.toBe(bottom.identity);
    // The diagnostics ride in result.json and are the same on every ply; the guides and art differ.
    const diag = (r: typeof top) => r.parts.filter((p) => p.id.startsWith('asm-'));
    expect(diag(top).map((p) => p.id)).toEqual(['asm-top-w']);
    expect(diag(top)).toEqual(diag(bottom));
    expect(top.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['carbon-lines', 'cut-w']));
    expect(bottom.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['gold-lines']));
    expect(bottom.parts.map((p) => p.id)).not.toContain('cut-w');
    expect(bottom.stats.partCount).toBe(bottom.parts.filter((p) => !p.diagnostic).length);
  }, 120_000);

  it('rejects a sketch whose assembly control does not match its plies', async () => {
    const entry = await fixture(true, `{ type: 'select', id: 'ply', label: 'Ply', default: 'top', options: ['top', 'bottom'] }`);
    await expect(renderSketch({ entry, timeoutMs: 120_000 })).rejects.toThrow(/options must be the ply ids/);
  }, 120_000);
});
