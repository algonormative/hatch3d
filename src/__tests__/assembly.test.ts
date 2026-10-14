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
    const need = 4 / Math.SQRT2 + half + GUIDE_DEFAULTS.guard;
    const key = (c: Point) => `${c.x.toFixed(6)},${c.y.toFixed(6)}`;
    const expected: string[] = [];
    for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) {
      const c = P(100 + i * 12, 100 + j * 12);
      if (Math.min(c.x - 48, 152 - c.x, c.y - 48, 152 - c.y) >= need) expected.push(key(c));
    }
    expect(centres.map(key).sort()).toEqual(expected.sort());
    expect(expected).toContain(key(P(100, 100)));
    expect(expected).not.toContain(key(P(148, 100))); // 4 mm in from the edge: inside the guard
    // Each X is two strokes of length `size`, and the ink stays a guard clear of the cut.
    for (const stroke of strokes) {
      exact(Math.hypot(stroke[1].x - stroke[0].x, stroke[1].y - stroke[0].y), GUIDE_DEFAULTS.size);
      for (const end of stroke) expect(distanceToRings(end, big.rings) - half).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.guard - 1e-9);
    }
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
      for (const stroke of strokes) for (const end of stroke) expect(distanceToRings(end, cut.rings) - half).toBeGreaterThanOrEqual(0.75 - 1e-9);
    }
    const small = marks({ id: 's', rings: [rect(100, 100, 108, 108)] });
    expect(small.centres).toHaveLength(1);
    expect(Math.abs(small.centres[0].x - 104)).toBeLessThan(1e-9);
  });

  it('throws when a window is too narrow for any X, or finer than the guide pen', () => {
    expect(() => cutGuides({ id: 'slot', rings: [rect(100, 50, 103.5, 110)] }, 'black', options)).toThrow(/slot: no room for an X mark/);
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
