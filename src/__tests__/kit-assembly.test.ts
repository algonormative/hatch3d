import { describe, expect, it } from 'vitest';
import { congruentFit, fitMatrix, fitRigid } from '../../cli/assembly-world.ts';
import { renderPly, validateCuts } from '../sketch/assembly.ts';
import { PAPERS, inkPen } from '../sketch/materials.ts';
import { signedArea } from '../sketch/region.ts';
import type { AssemblySpec, Cut, Part, Point } from '../sketch/types.ts';
import { barCut, footprintOf, routeParts, type PlyRoute } from '../../sketches/kit/assembly.ts';
import { hatchedBar } from '../../sketches/kit/fills.ts';

const P = (x: number, y: number): Point => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const line = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(x0, y0), P(x1, y1)];
const scene = (): Part[] => [
  { id: 'rays-carbon', pen: 'carbon', paths: [line(20, 62, 180, 62)] },
  { id: 'figure-carbon', pen: 'carbon', paths: [line(20, 60, 180, 60)] },
  { id: 'figure-vermilion', pen: 'vermilion', paths: [line(20, 100, 180, 100)] },
  { id: 'shadow-beam-ultramarine', pen: 'ultramarine', paths: [line(20, 140, 180, 140)] },
  { id: 'shadow-carbon', pen: 'carbon', paths: [line(20, 160, 180, 160)] },
];
const routes: Record<string, PlyRoute> = {
  black: { groups: ['rays', 'shadow-beam'], inks: { carbon: 'silver', ultramarine: 'gold' } },
  white: { groups: ['figure', 'shadow'], inks: { carbon: 'carbon', vermilion: 'vermilion' } },
};

describe('kit assembly: routeParts', () => {
  it('sends each scene part to the ply that draws its group, in the ply’s own pen and the scene’s order', () => {
    const art = routeParts(scene(), routes);
    expect(Object.keys(art)).toEqual(['black', 'white']);
    expect(art.black.map((p) => [p.id, p.pen])).toEqual([['rays-carbon', 'silver'], ['shadow-beam-ultramarine', 'gold']]);
    expect(art.white.map((p) => [p.id, p.pen])).toEqual([['figure-carbon', 'carbon'], ['figure-vermilion', 'vermilion'], ['shadow-carbon', 'carbon']]);
    // The paths and the scene's parts are untouched.
    expect(art.white[0].paths).toEqual([line(20, 60, 180, 60)]);
    expect(scene()[0].pen).toBe('carbon');
    // A group with a hyphen is one group: shadow-beam is not shadow.
    expect(routeParts([{ id: 'shadow-beam-carbon', pen: 'carbon', paths: [] }], { a: { groups: ['shadow'], inks: { carbon: 'x' } }, b: { groups: ['shadow-beam'], inks: { carbon: 'y' } } }).b.map((p) => p.pen)).toEqual(['y']);
  });

  it('has an entry for every ply, empty when it draws nothing of this scene', () => {
    expect(routeParts([], routes)).toEqual({ black: [], white: [] });
    expect(routeParts([{ id: 'rays-carbon', pen: 'carbon', paths: [] }], routes).white).toEqual([]);
  });

  it('keeps the part ids unique on a ply when two inks share a pen', () => {
    const art = routeParts(scene(), { ...routes, white: { ...routes.white, inks: { carbon: 'carbon', vermilion: 'carbon' } } });
    expect(art.white.map((p) => p.pen)).toEqual(['carbon', 'carbon', 'carbon']);
    expect(new Set(art.white.map((p) => p.id)).size).toBe(3);
  });

  it('throws, naming the part, rather than drop one: a group no ply draws, an ink with no pen on its ply, a group on two plies, an id not <group>-<ink>', () => {
    expect(() => routeParts([{ id: 'sky-carbon', pen: 'carbon', paths: [] }], routes)).toThrow(/part sky-carbon: its group sky is drawn on no ply/);
    expect(() => routeParts([{ id: 'figure-acid', pen: 'acid', paths: [] }], routes)).toThrow(/part figure-acid: ink acid has no pen on ply white \(it has carbon, vermilion\)/);
    expect(() => routeParts([{ id: 'rays-vermilion', pen: 'vermilion', paths: [] }], routes)).toThrow(/part rays-vermilion: ink vermilion has no pen on ply black/);
    expect(() => routeParts(scene(), { ...routes, black: { ...routes.black, groups: ['rays', 'figure'] } })).toThrow(/part figure-carbon: its group figure is claimed by more than one ply \(black, white\)/);
    expect(() => routeParts([{ id: 'figure-carbon', pen: 'vermilion', paths: [] }], routes)).toThrow(/part figure-carbon is not named <group>-<ink> for its pen vermilion/);
    expect(() => routeParts([{ id: '-carbon', pen: 'carbon', paths: [] }], routes)).toThrow(/is not named <group>-<ink>/);
    expect(() => routeParts([{ id: 'figure-toString', pen: 'toString', paths: [] }], routes)).toThrow(/ink toString has no pen on ply white/);
    expect(() => routeParts([{ id: 'figure-carbon', pen: 'carbon', paths: [] }], { white: { groups: ['figure'], inks: { carbon: '' } } })).toThrow(/ink carbon has no pen/);
  });

  it('feeds renderPly: the routed scene is clipped to what each ply shows, and a censor bar window shows the ply below', () => {
    const spec: AssemblySpec = {
      control: 'ply', cutPen: 'carbon', margin: 1, bleed: 1,
      plies: [
        { id: 'black', paper: { id: 'black', color: PAPERS.black.color }, pens: ['silver', 'gold'], cutInk: 'silver' },
        { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon', 'vermilion'], cutInk: 'carbon' },
      ],
    };
    const pens = [inkPen('silver'), inkPen('gold'), inkPen('carbon'), inkPen('vermilion')];
    const bar = hatchedBar({ cx: 100, cy: 60, l: 60, h: 14 }, 0.2, [[Math.PI / 3, 0.9]]);
    const cuts = { white: [barCut('eyes', bar.quad)] };
    const world = { cuts, art: routeParts(scene(), routes) };
    const page = { width: 200, height: 200, margin: 10 };
    const ply = (id: string) => renderPly(spec, { params: { ply: id }, page }, pens, world);
    // The figure line at y = 60 runs through the bar on the white ply, so it is cut at the bar; the black ply shows through it.
    const figure = ply('white').find((p) => p.id === 'figure-carbon')!;
    expect(figure.paths.length).toBe(2);
    expect(ply('white').some((p) => p.id === 'cut-eyes' && p.pen === 'carbon')).toBe(true);
    const rays = ply('black').find((p) => p.id === 'rays-carbon')!;
    expect(rays.pen).toBe('silver');
    const xs = rays.paths.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThan(60); // only the stretch seen through the bar (and its bleed) survives
    expect(Math.max(...xs)).toBeLessThan(140);
    expect(ply('black').find((p) => p.id === 'shadow-beam-ultramarine')).toBeUndefined(); // hidden under the white paper: nothing of it is in view
  });
});

describe('kit assembly: barCut', () => {
  const tilted = hatchedBar({ cx: 90, cy: 70, l: 50, h: 12 }, 0.3, [[Math.PI / 3, 0.9]]).quad;

  it('is the censor bar’s quad as a window, or as a part to keep, and a copy', () => {
    const cut = barCut('eyes', tilted);
    expect(cut).toEqual({ id: 'eyes', kind: 'waste', rings: [tilted] });
    expect(barCut('eyes', tilted, 'part').kind).toBe('part');
    cut.rings[0][0].x += 5;
    expect(tilted[0].x).not.toBe(cut.rings[0][0].x);
  });

  it('is a cut renderPly accepts, and a bad quad throws', () => {
    const spec: AssemblySpec = { control: 'ply', cutPen: 'carbon', margin: 1, bleed: 1, plies: [{ id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'carbon' }] };
    expect(() => validateCuts(spec, { white: [barCut('eyes', tilted), barCut('keep', rect(20, 20, 40, 30), 'part')] }, { width: 200, height: 200, margin: 10 }, [inkPen('carbon')])).not.toThrow();
    expect(() => barCut('x', [P(0, 0), P(1, 1)])).toThrow(/bar x: the quad needs at least three finite points/);
    expect(() => barCut('x', [P(0, 0), P(1, 1), P(Number.NaN, 2)])).toThrow(/finite/);
  });
});

describe('kit assembly: footprintOf', () => {
  const bar = barCut('bar', rect(22, 76, 78, 90), 'part');
  const L: Cut = { id: 'ell', kind: 'part', rings: [[P(0, 0), P(30, 0), P(30, 10), P(10, 10), P(10, 40), P(0, 40)]] };
  const centreOf = (ring: Point[]): Point => {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const c = ring[j].x * ring[i].y - ring[i].x * ring[j].y; a += c; cx += (ring[j].x + ring[i].x) * c; cy += (ring[j].y + ring[i].y) * c; }
    return P(cx / (3 * a), cy / (3 * a));
  };

  it('moves a part by (dx, dy) and turns it about its centroid, keeping the vertex order and the part’s id', () => {
    const moved = footprintOf(bar, { dx: 10, dy: -5, rotate: 0 });
    expect(moved).toEqual({ id: 'bar', kind: 'footprint', rings: [rect(32, 71, 88, 85)] });
    // A quarter turn about the centre (50, 83) leaves a 14 x 56 bar standing on that centre, vertex 0 first.
    const turned = footprintOf(bar, { dx: 0, dy: 0, rotate: 90 }).rings[0];
    turned.forEach((p, i) => { expect(p.x).toBeCloseTo([57, 57, 43, 43][i], 9); expect(p.y).toBeCloseTo([55, 111, 111, 55][i], 9); });
    expect(footprintOf(bar, { dx: 0, dy: 0, rotate: 90 }).rings[0][0]).not.toEqual(bar.rings[0][0]);
  });

  it('turns about the area centroid, not the mean of the vertices, so (dx, dy) moves the centroid', () => {
    const before = centreOf(L.rings[0]);
    const after = centreOf(footprintOf(L, { dx: 0, dy: 0, rotate: 37 }).rings[0]);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    const moved = centreOf(footprintOf(L, { dx: 3, dy: -4, rotate: 37 }).rings[0]);
    expect(moved.x).toBeCloseTo(before.x + 3, 9);
    expect(moved.y).toBeCloseTo(before.y - 4, 9);
    const mean = P(L.rings[0].reduce((s, p) => s + p.x, 0) / 6, L.rings[0].reduce((s, p) => s + p.y, 0) / 6);
    expect(Math.hypot(mean.x - before.x, mean.y - before.y)).toBeGreaterThan(1); // the two centres differ for an L
  });

  it('is congruent to the part by finalize’s own check: a rigid fit with the residual near zero, at the angle asked', () => {
    for (const [cut, t] of [[bar, { dx: 0, dy: 0, rotate: 0 }], [bar, { dx: 12.5, dy: -33, rotate: 90 }], [L, { dx: -7, dy: 21, rotate: -143.5 }], [L, { dx: 0, dy: 0, rotate: 360 }]] as const) {
      const foot = footprintOf(cut, t);
      const fit = fitRigid(cut.rings, foot.rings);
      expect(fit.rms).toBeLessThan(1e-9);
      expect(() => congruentFit(cut.rings, foot.rings, 'onlay test')).not.toThrow();
      const turn = Math.atan2(fit.sin, fit.cos), want = (t.rotate * Math.PI) / 180;
      expect(Math.abs(Math.atan2(Math.sin(turn - want), Math.cos(turn - want)))).toBeLessThan(1e-9);
      expect(signedArea(foot.rings[0])).toBeCloseTo(signedArea(cut.rings[0]), 6); // not mirrored
    }
    expect(fitMatrix(fitRigid(bar.rings, footprintOf(bar, { dx: 3, dy: 4, rotate: 90 }).rings))).toMatch(/^matrix\(/);
    // The check bites: a footprint with a vertex out of place is not congruent.
    const bad = footprintOf(L, { dx: 0, dy: 0, rotate: 20 });
    bad.rings[0][3].x += 1;
    expect(() => congruentFit(L.rings, bad.rings, 'onlay test')).toThrow(/not congruent/);
  });

  it('keeps every ring of a cut with a hole, and refuses what it cannot turn', () => {
    const shaped: Cut = { id: 'frame', kind: 'part', rings: [rect(0, 0, 40, 30), rect(10, 10, 30, 20)] };
    const foot = footprintOf(shaped, { dx: 5, dy: 5, rotate: 15 });
    expect(foot.rings.map((r) => r.length)).toEqual([4, 4]);
    expect(fitRigid(shaped.rings, foot.rings).rms).toBeLessThan(1e-9);
    expect(() => footprintOf(bar, { dx: Number.NaN, dy: 0, rotate: 0 })).toThrow(/finite/);
    expect(() => footprintOf({ id: 'x', rings: [] }, { dx: 0, dy: 0, rotate: 0 })).toThrow(/at least three points/);
  });

  it('is a footprint validateCuts takes on an onlay ply', () => {
    const spec: AssemblySpec = {
      control: 'ply', cutPen: 'carbon', margin: 1, bleed: 1,
      plies: [
        { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'carbon' },
        { id: 'bar', paper: { id: 'black', color: PAPERS.black.color }, pens: [], cutInk: 'silver', onlay: { from: 'panel/black/bar' } },
      ],
    };
    expect(() => validateCuts(spec, { bar: [footprintOf(bar, { dx: 0, dy: 20, rotate: 90 })] }, { width: 200, height: 200, margin: 10 })).not.toThrow();
  });
});
