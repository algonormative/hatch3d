import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xii-hanged-man/sketch.ts');

describe('Breach Tarot: XII The Hanged Man', () => {
  it('replays, stays inside the card, and draws the sky, the leaning city, the bob, the line, the ring, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 3 });
    const replay = await renderSketch({ entry, seed: 3 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['ring-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['sky-', 'city-', 'bob-', 'line-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('hangs the bob on one true vertical: the bare thread is a single straight page-vertical stroke', async () => {
    const result = await renderSketch({ entry, seed: 3 });
    const carbon = result.parts.find(p => p.id === 'line-carbon')!.paths;
    const vertical = carbon.filter(path => path.length >= 2 && Math.abs(path[0].x - path[path.length - 1].x) < 0.05 && Math.abs(path[0].y - path[path.length - 1].y) > 20);
    expect(vertical.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('Breach Tarot: XII The Hanged Man at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 3, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const length = (path: Point[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the foot, the bob, the line and every course of the city', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-hanged-man-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { plumbWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/xii-hanged-man/geometry.ts'))};
      export default { name: 'plumb-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'footDrop', label: 'Foot below the horizon', default: 112, min: 15, max: 140, step: 1 }],
        draw(ctx) {
          const w = plumbWorld(ctx), h = createHash('sha256');
          for (const v of [w.foot, w.bobTop, w.skyTop, w.unravel]) h.update([v.x, v.y, v.z, ';'].join(','));
          for (const s of [...w.bob, ...w.city]) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, s.tone, ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.city.length / 100, y: 20 + w.bob.length }]] }];
        } };`);
    // The default, and a foot nearer the horizon.
    for (const params of [{}, { footDrop: 40 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 3, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 3, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 100 / 100);
      expect(counts[1].y).toBe(20 + 8);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(print.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

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
      // Paths wholly inside the art window, per part of the scene: the sky, the city, the bob, the line, the ring, the horizon.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 150, 'city-': 700, 'bob-': 40, 'line-': 12, 'ring-': 0, 'horizon-': 1 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Hanged Man: one true vertical down the middle to the bob, its point in the ring, the towers standing on the horizon either side under a ruled sky', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const mean = (ps: Point[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
      const bob = box(points(result, 'bob-')), ring = box(points(result, 'ring-')), helix = box(points(result, 'line-vermilion'));
      // The line hangs down the middle of the window, the helix on it from the top of the window to just above the bob.
      expect(Math.abs(mean(points(result, 'line-'), 'x') - centre)).toBeLessThan(1);
      expect(helix.y0).toBeLessThan(card.y0 + 1);
      expect(helix.y1).toBeLessThan(bob.y0);
      // The bare thread: one page-vertical stroke ending on the bob's top.
      const thread = paths(result, 'line-carbon').filter(path => Math.abs(path[0].x - path.at(-1)!.x) < 0.05 && Math.abs(path[0].y - path.at(-1)!.y) > 6
        && Math.abs(Math.max(path[0].y, path.at(-1)!.y) - bob.y0) < 0.5);
      expect(thread.length).toBe(1);
      // The bob below the horizon, as wide on the card as on the print (over a third of the window), centred on the line.
      expect(bob.y0).toBeGreaterThan(horizonY);
      expect((bob.x1 - bob.x0) / (card.x1 - card.x0)).toBeGreaterThan(0.35);
      expect(Math.abs((bob.x0 + bob.x1) / 2 - centre)).toBeLessThan(1);
      // Its point in the ring: the ring round the line, below the bob's top, reaching past the point, inside the window.
      expect(Math.abs((ring.x0 + ring.x1) / 2 - centre)).toBeLessThan(1);
      expect(ring.y0).toBeGreaterThan(bob.y0);
      expect(ring.y0).toBeLessThan(bob.y1);
      expect(ring.y1).toBeGreaterThan(bob.y1);
      expect(ring.y1).toBeLessThan(card.y1);
      // The towers stand on the horizon, either side of the line; the sky is ruled above the horizon only.
      const city = points(result, 'city-');
      expect(city.filter(p => p.y < horizonY).length / city.length).toBeGreaterThan(0.9);
      expect(city.filter(p => p.x < centre).length / city.length).toBeGreaterThan(0.3);
      expect(city.filter(p => p.x > centre).length / city.length).toBeGreaterThan(0.3);
      expect(Math.max(...points(result, 'sky-').map(p => p.y))).toBeLessThan(horizonY);
      // The sky stops short of the towers and the bob by their knockout halo (1.1 mm in tabloid, scaled with the card, never
      // under 0.5 mm). The halo is measured on a raster, so a clean ruling stands a little under the floor: no ruling comes
      // nearer than about 0.35 mm, nor further than the scaled halo and a tenth of a millimetre.
      let nearSolid = Infinity;
      for (const p of points(result, 'sky-')) for (const q of [...points(result, 'city-'), ...points(result, 'bob-')]) nearSolid = Math.min(nearSolid, Math.hypot(p.x - q.x, p.y - q.y));
      expect(nearSolid, `${fit} sky to towers and bob`).toBeGreaterThan(0.35);
      expect(nearSolid, `${fit} sky to towers and bob`).toBeLessThan(Math.max(0.5, 1.1 * s) + 0.1);
    }
  }, 120_000);

  it('keeps the bob heavy and clean on a small card: its dark faces ruled near the print’s weight, its courses outlined without dashes', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 3 }), ...fits.map(render)]);
    // The bob's field ink (ultramarine) per square millimetre of its box, against the print's.
    const field = (result: RenderResult) => {
      const b = box(points(result, 'bob-'));
      return paths(result, 'bob-ultramarine').reduce((sum, path) => sum + length(path), 0) / ((b.x1 - b.x0) * (b.y1 - b.y0));
    };
    for (const result of small) {
      // The raking-light hatch fits one ring in a course a few millimetres tall and leaves the field paper (none); ruled,
      // the faces carry over half the print's field.
      expect(field(result) / field(print)).toBeGreaterThan(0.5);
      // The courses' outlines unbroken: few scraps under 1.5 mm (the flickering far top edges and doubled joints made a
      // third of them that).
      const outline = paths(result, 'bob-carbon');
      expect(outline.filter(path => length(path) < 1.5).length / outline.length).toBeLessThan(0.15);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 3 }), ...fits.map(render)]);
    const master = probe(print);
    for (const [k, result] of small.entries()) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // The towers' outlines are trimmed on a small card (kit/slabs.ts' `SlabTrim`): untrimmed, their back edges and sliver
      // faces ran the outline to 4,900-5,300 mm of card; trimmed, it is 3,400-3,600 mm.
      const outline = result.parts.filter(part => part.id === 'city-carbon').flatMap(part => part.paths)
        .reduce((sum, path) => sum + path.slice(1).reduce((l, q, i) => l + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0);
      expect(outline, `${fits[k]} tower outlines`).toBeLessThan(4300);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling,
    // the bob's hatch and the ring's band shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'bob-carbon', 'ring-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, height, where the render names none', async () => {
    const [plain, height] = await Promise.all([renderSketch({ entry, seed: 3, finishing: { page }, timeoutMs: 120_000 }), render('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(height.parts);
  }, 120_000);
});
