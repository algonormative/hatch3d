import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { foolCamera, maze, walls } from '../../sketches/breach-tarot/0-fool/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { onGround } from '../../sketches/kit/perspective.ts';
import type { Slab } from '../../sketches/kit/slabs.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const entry = resolve('sketches/breach-tarot/0-fool/sketch.ts');

describe('Breach Tarot: 0 The Fool', () => {
  it('replays, stays inside the card, and draws the maze, its collapse, the undecided walls, the figure, the tie, the sun, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['undecided-carbon', 'sun-acid', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['maze-', 'collapse-', 'figure-', 'figure-edge-', 'helix-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('frays the grown walls without moving the maze: footprints and standing blocks stay put, only more blocks rise', () => {
    const build = (fray: number) => {
      const ctx = sketchContext(1, { fray });
      const view = foolCamera(ctx);
      const foot = onGround(view, { x: CARD.x0 + (CARD.x1 - CARD.x0) * 0.6, y: CARD.y1 - 32 });
      return walls(ctx, view, maze(ctx, view, foot));
    };
    const still = build(0), frayed = build(1);
    expect(JSON.stringify(frayed.undecided)).toBe(JSON.stringify(still.undecided));
    const at = (sl: Slab) => `${sl.x.toFixed(5)},${sl.y.toFixed(5)},${sl.z.toFixed(5)}`;
    const standing = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'stack' || sl.role === 'pier');
    const before = new Set(standing(still).map(at));
    for (const sl of standing(frayed)) expect(before.has(at(sl))).toBe(true);
    const rising = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'debris').length;
    expect(rising(frayed)).toBeGreaterThan(rising(still));
  });
});

describe('Breach Tarot: 0 The Fool at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}), timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([render(fit), render(fit)]);
      expect(replay.identity).toBe(first.identity);
      expect(first.diagnostics).toEqual([]);
      expect(first.metadata.page).toMatchObject(page);
      const { card, frame } = formatOf(fit);
      for (const part of first.parts) for (const path of part.paths) for (const p of path) {
        expect(p.x).toBeGreaterThanOrEqual(card.x0 - 0.01);
        expect(p.x).toBeLessThanOrEqual(card.x1 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(card.top - 0.01);
        expect(p.y).toBeLessThanOrEqual(card.bottom + 0.01);
      }
      // Paths wholly inside the art window, per part of the scene: the maze, its collapse, the figure, the tie, the
      // undecided footprints, the sun, the shadows.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'maze-': 1000, 'collapse-': 120, 'figure-': 150, 'helix-': 70, 'undecided-': 15, 'sun-': 20, 'shadow-': 10 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Fool: the sun a mark up in the sky to the right, the undecided footprints on the ground, the tie streaming up past his head', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const mean = (ps: { x: number; y: number }[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
      const ys = (ps: { y: number }[]) => ps.map(p => p.y);
      const sun = points(result, 'sun-'), footprints = points(result, 'undecided-'), figure = points(result, 'figure'), tie = points(result, 'helix-');
      // The sun is a mark in the upper right of the sky, its rays and all: right of the centre line, in the upper half.
      expect(Math.min(...sun.map(p => p.x))).toBeGreaterThan(centre - 2);
      expect(Math.max(...ys(sun))).toBeLessThan(card.y0 + (card.y1 - card.y0) / 2);
      expect(mean(sun, 'y')).toBeLessThan(card.y0 + (card.y1 - card.y0) / 3);
      expect(Math.min(...ys(footprints))).toBeGreaterThan(horizonY);
      // He stands on the near ground right of centre, his head up above the horizon.
      expect(Math.max(...ys(figure))).toBeGreaterThan(horizonY + 20);
      expect(Math.min(...ys(figure))).toBeLessThan(horizonY - 15);
      expect(mean(figure, 'x')).toBeGreaterThan(centre);
      // The tie leaves his throat and climbs out of the top of the window, far above his head.
      expect(Math.max(...ys(tie))).toBeGreaterThan(Math.min(...ys(figure)));
      expect(Math.min(...ys(tie))).toBeLessThan(Math.min(...ys(figure)) - 25);
      expect(Math.min(...ys(tie))).toBeLessThan(card.y0 + 2);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card without its pitch scaling is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its
    // hatch and cloth pitches shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['maze-ultramarine', 'figure-ultramarine', 'figure-carbon']) expect(denser).toContain(id);
  }, 120_000);
});
