import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/iv-emperor/sketch.ts');

describe('Breach Tarot: IV The Emperor', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the avenue, the throne, the figure, the helix head, the bar, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 2 });
    const replay = await renderSketch({ entry, seed: 2 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(CARD.x0 - 0.01);
      expect(p.x).toBeLessThanOrEqual(CARD.x1 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['sky-carbon', 'ground-carbon', 'avenue-carbon', 'throne-carbon', 'figure-carbon', 'bar-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
    // Two full tabloid renders: 60 s ran out more than once with the whole suite running alongside.
  }, 180_000);

  it('is colossal by distance: the plinth stands just below the horizon and the head reaches the top quarter of the art window', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));
    const plinthFoot = Math.max(...ys(id => id === 'throne-carbon'));
    expect(plinthFoot - HORIZON_Y).toBeGreaterThan(2);
    expect(plinthFoot - HORIZON_Y).toBeLessThan(20);
    const crown = Math.min(...ys(id => id.startsWith('helix-')));
    expect(crown).toBeLessThan(CARD.y0 + 0.25 * (CARD.y1 - CARD.y0));
  }, 60_000);
});

describe('Breach Tarot: IV The Emperor at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  const mean = (ps: Point[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
  const xs = (ps: Point[]) => ps.map(p => p.x), ys = (ps: Point[]) => ps.map(p => p.y);
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same world at every size and fit: the colossus, its throne, the avenue and the censor bar’s turn', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-emperor-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { emperorWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/iv-emperor/geometry.ts'))};
      const slider = (id, value, min, max) => ({ type: 'slider', id, label: id, default: value, min, max, step: 0.5 });
      export default { name: 'emperor-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [slider('baseDrop', 10, 3, 40), slider('throneX', 46, 0, 100), slider('headTop', 80, 50, 140)],
        draw(ctx) {
          const w = emperorWorld(ctx), h = createHash('sha256');
          h.update([w.yaw, w.height, w.anchor.x, w.anchor.y, w.anchor.z, w.length, w.lane, w.c, w.pitch, w.tilt].join(','));
          h.update([w.av.origin.x, w.av.origin.z, w.av.x.x, w.av.x.z, w.av.z.x, w.av.z.z].join(','));
          h.update([w.fig.head.centre.x, w.fig.head.centre.y, w.fig.head.centre.z, w.fig.head.r].join(','));
          for (const s of [...w.fig.throne, ...w.cubes]) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.cubes.length / 10, y: 20 + w.fig.throne.length }]] }];
        } };`);
    // The default, and the throne moved, the head lower and the plinth's foot farther below the horizon (all three
    // tabloid millimetres that place the colossus).
    for (const params of [{}, { throneX: 80, headTop: 110, baseDrop: 25 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      // Dozens of cubes (73 by default) and the throne's seven blocks: the seat, two armrests, the back and three steps.
      expect(counts[1].x).toBeGreaterThan(20 + 40 / 10);
      expect(counts[1].y).toBe(20 + 7);
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
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(card.x0 - 0.01);
        expect(p.x).toBeLessThanOrEqual(card.x1 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(card.top - 0.01);
        expect(p.y).toBeLessThanOrEqual(card.bottom + 0.01);
      }
      // Paths wholly inside the art window, per part of the scene: the sky, the paving, the avenue, the throne, the
      // figure, the helix head and the censor bar.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 40, 'ground-': 12, 'avenue-': 200, 'throne-': 40, 'figure-': 100, 'helix-': 30, 'bar-': 15 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...ys(phrase))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Emperor: colossal by distance, enthroned right of centre, the bar across the helix head, the sky opening round it', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const sky = points(result, 'sky-'), ground = points(result, 'ground-'), avenue = points(result, 'avenue-');
      const throne = points(result, 'throne-'), figure = points(result, 'figure-'), helix = points(result, 'helix-'), bar = points(result, 'bar-');
      // The plinth's foot just below the horizon, as on the print (2 to 20 mm there), and the head in the top quarter.
      const foot = Math.max(...ys(throne)) - horizonY;
      expect(foot).toBeGreaterThan(2 * s);
      expect(foot).toBeLessThan(20 * s);
      expect(Math.min(...ys(helix))).toBeLessThan(card.y0 + 0.25 * (card.y1 - card.y0));
      // The throne and the figure stand right of centre; the avenue's rows run down both sides of the lane.
      expect(mean(throne, 'x')).toBeGreaterThan(centre + 5);
      expect(mean(figure, 'x')).toBeGreaterThan(centre);
      expect(avenue.filter(p => p.x < centre - 5).length).toBeGreaterThan(200);
      expect(avenue.filter(p => p.x > centre + 5).length).toBeGreaterThan(200);
      // The sky above the horizon; the paving and the cubes below it.
      expect(Math.max(...ys(sky))).toBeLessThan(horizonY);
      expect(Math.min(...ys(ground))).toBeGreaterThan(horizonY);
      expect(Math.min(...ys(avenue))).toBeGreaterThan(horizonY);
      // The censor bar lies across the helix head.
      const [bx, by] = [mean(bar, 'x'), mean(bar, 'y')];
      expect(bx).toBeGreaterThan(Math.min(...xs(helix)));
      expect(bx).toBeLessThan(Math.max(...xs(helix)));
      expect(by).toBeGreaterThan(Math.min(...ys(helix)));
      expect(by).toBeLessThan(Math.max(...ys(helix)));
      // The ruled sky opens round the head in the print's proportion (its 95 mm opening scaled with the card): no
      // ruling within about half the opening of the head, and ruling again inside it.
      const head = { x: (Math.min(...xs(helix)) + Math.max(...xs(helix))) / 2, y: (Math.min(...ys(helix)) + Math.max(...ys(helix))) / 2 };
      const nearest = Math.min(...sky.map(p => Math.hypot(p.x - head.x, p.y - head.y)));
      expect(nearest / (95 * s)).toBeGreaterThan(0.4);
      expect(nearest / (95 * s)).toBeLessThan(0.75);
      // The helix keeps off the censor bar by its knockout halo (1.4 mm in tabloid, scaled with the card, never under 0.5 mm):
      // its nearest stroke comes no nearer the bar than that, nor much further than the scaled halo plus four tenths of a millimetre.
      let nearBar = Infinity;
      for (const p of points(result, 'helix-')) for (const q of points(result, 'bar-')) nearBar = Math.min(nearBar, Math.hypot(p.x - q.x, p.y - q.y));
      expect(nearBar, `${fit} helix to bar`).toBeGreaterThan(0.45);
      expect(nearBar, `${fit} helix to bar`).toBeLessThan(Math.max(0.5, 1.4 * s) + 0.4);
    }
  }, 120_000);

  it('keeps the censor bar a flat mark scaled with the head: its outline and hatch, the inner rule too narrow to keep left out', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const closed = (result: RenderResult) => result.parts.filter(part => part.id === 'bar-carbon').flatMap(part => part.paths)
      .filter(path => path.length === 5 && Math.hypot(path[0].x - path[4].x, path[0].y - path[4].y) < 1e-6);
    const longest = (quad: Point[]) => Math.max(...[0, 1, 2, 3].map(i => Math.hypot(quad[i + 1].x - quad[i].x, quad[i + 1].y - quad[i].y)));
    // The print: the outline and its rule 1.1 mm inside.
    expect(closed(print).length).toBe(2);
    for (const [k, result] of small.entries()) {
      const { s } = formatOf(fits[k]);
      const quads = closed(result);
      expect(quads.length).toBe(1);
      expect(longest(quads[0]) / (s * longest(closed(print)[0]))).toBeCloseTo(1, 2);
      // Hatched inside, at the print's pitch.
      expect(result.parts.find(part => part.id === 'bar-carbon')!.paths.length).toBeGreaterThan(10);
    }
  }, 120_000);

  it('draws its preferred fit, the width, where the render names none', async () => {
    const [plain, width] = await Promise.all([
      renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }),
      render('width'),
    ]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const [k, result] of small.entries()) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // The throne's outline is trimmed on a small card (kit/slabs.ts' `SlabTrim`): untrimmed, its back edges and sliver faces
      // ran the throne to 707-714 mm of card; trimmed, it is 650-660 mm.
      const throne = result.parts.filter(part => part.id === 'throne-carbon').flatMap(part => part.paths)
        .reduce((sum, path) => sum + path.slice(1).reduce((l, q, i) => l + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0);
      expect(throne, `${fits[k]} throne outline`).toBeLessThan(685);
      // The suit is thinned where its lines crowd (thin.ts): unthinned, its planes, the pinstripe beside each plane
      // edge and the outline ran together over half its length (49-56%, against the print's 30%).
      const figure = report.parts.find(part => part.id === 'figure-carbon')!;
      expect(figure.share, describeDensity(report)).toBeLessThan(0.1);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky
    // ruling, facet hatch and pinstripes shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'avenue-carbon', 'throne-carbon', 'figure-carbon', 'bar-carbon']) expect(denser).toContain(id);
  }, 120_000);
});
