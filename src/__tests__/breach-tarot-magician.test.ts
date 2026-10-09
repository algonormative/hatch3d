import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { FIELD_FLOOR } from '../../sketches/breach-tarot/i-magician/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/i-magician/sketch.ts');

describe('Breach Tarot: I The Magician', () => {
  it('replays, stays inside the card, and draws the figure, its field, the helix, the blocks, the cracks, the mark, the phrase and the frame', async () => {
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
    for (const id of ['figure-carbon', 'cracks-carbon', 'mark-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['field-', 'helix-', 'blocks-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('keeps the figure on its own ground: with no veil, nothing else comes within a millimetre of its strokes', async () => {
    const veiled = await renderSketch({ entry, seed: 1, params: { veil: 0 } });
    const figure = veiled.parts.find(p => p.id === 'figure-carbon')!.paths.flat();
    const near = (q: { x: number; y: number }) => figure.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 1);
    const crossing = veiled.parts.filter(p => p.id !== 'figure-carbon').flatMap(p => p.paths.flat()).filter(near);
    expect(figure.length).toBeGreaterThan(50);
    expect(crossing).toEqual([]);
  }, 60_000);

  it('can draw the figure as a body: same height, ground and middle on the sheet as the scratch figure, and as clear of everything else', async () => {
    const box = (result: Awaited<ReturnType<typeof renderSketch>>) => {
      const pts = result.parts.find(p => p.id === 'figure-carbon')!.paths.flat();
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), pts };
    };
    const scratch = box(await renderSketch({ entry, seed: 1, params: { veil: 0, figureStyle: 'scratch' } }));
    const bodyResult = await renderSketch({ entry, seed: 1, params: { veil: 0, figureStyle: 'body' } });
    const body = box(bodyResult);
    expect(bodyResult.diagnostics).toEqual([]);
    expect(Math.abs(body.y0 - scratch.y0)).toBeLessThan(1);
    expect(Math.abs(body.y1 - scratch.y1)).toBeLessThan(1);
    expect(Math.abs((body.x0 + body.x1) / 2 - (scratch.x0 + scratch.x1) / 2)).toBeLessThan(1);
    const near = (q: { x: number; y: number }) => body.pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 1);
    expect(bodyResult.parts.filter(p => p.id !== 'figure-carbon').flatMap(p => p.paths.flat()).filter(near)).toEqual([]);
  }, 60_000);
});

describe('Breach Tarot: I The Magician at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit, params: Record<string, number | string> = {}) => renderSketch({ entry, seed: 1, params, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
  const box = (ps: Point[]) => {
    const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), cx: (Math.min(...xs) + Math.max(...xs)) / 2 };
  };
  const length = (path: Point[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

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
      // Paths wholly inside the art window, per part of the scene: the ground, its cracks, the blocks, the flame, the
      // helix, the figure and the lemniscate.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'ground-': 100, 'cracks-': 12, 'blocks-': 150, 'field-': 20, 'helix-': 90, 'figure-': 15, 'mark-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      // The phrase, all of it, at once: four short words.
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(50);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('builds the same seeded world at every size and fit: where it stands, every block, the flame and the cracks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-magician-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), its counts, and what the format draws
    // of it (the blocks shown, the flame's share), each as 20 + value inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { fieldShare, magicianCamera, magicianWorld, shownBlocks } from ${JSON.stringify(resolve('sketches/breach-tarot/i-magician/geometry.ts'))};
      export default { name: 'magician-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'figure', label: 'Figure', default: 40, min: 14, max: 100, step: 1 },
          { type: 'slider', id: 'figureX', label: 'Across', default: 0, min: -0.3, max: 0.3, step: 0.01 }],
        draw(ctx) {
          const w = magicianWorld(ctx), h = createHash('sha256');
          h.update([w.base.x, w.base.y, w.base.z, w.pocketPhase, w.paving].join(','));
          for (const s of w.blocks) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, s.tone, s.beat, ';'].join(','));
          for (const line of w.fieldLines) for (const p of line) h.update([p.x, p.y, p.z, ';'].join(','));
          for (const c of w.cracks) for (const p of c) h.update([p.x, p.y, ';'].join(','));
          const d = h.digest();
          const shown = shownBlocks(w.blocks, magicianCamera(ctx)).filter(Boolean).length;
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.blocks.length / 10, y: 20 + w.paving / 10 }, { x: 20 + w.fieldLines.length / 10, y: 20 + w.cracks.length / 10 }]] },
            { id: 'drawn', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + shown / 10, y: 20 + 10 * fieldShare(w.fieldLines.length) }]] }];
        } };`);
    const path = (result: RenderResult, id: string) => result.parts.find(part => part.id === id)!.paths[0];
    // The default; the figure off to one side (placed by tabloid's card, which a fit that crops the sides does not
    // keep); and the figure at its smallest, where the paving at its feet is a speck on a small card.
    for (const params of [{}, { figureX: 0.3 }, { figure: 14 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, format: { fit } })),
      ]);
      const [, blocks, lines] = path(print, 'counts');
      expect(blocks.x).toBeGreaterThan(20 + 40 / 10);
      expect(lines.x).toBeCloseTo(20 + 6.4, 6);
      // The print draws every block and every line of the flame.
      expect(path(print, 'drawn')[1]).toEqual({ x: blocks.x, y: 30 });
      for (const [k, result] of small.entries()) {
        for (const id of ['digest', 'counts']) expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${fits[k]} ${id}`).toEqual(print.parts.find(part => part.id === id)!.paths);
        // A small card keeps two in five of the flame's lines (the scale alone would keep a quarter)...
        const drawn = path(result, 'drawn')[1];
        expect((drawn.y - 20) / 10).toBeGreaterThanOrEqual(FIELD_FLOOR);
        expect((drawn.y - 20) / 10).toBeLessThan(FIELD_FLOOR + 0.02);
        // ...and every block but a speck: all of them at the default, the paving at its feet not at its smallest.
        if (params.figure === 14) expect(drawn.x).toBeLessThan(blocks.x - 0.5);
        else expect(drawn.x).toBeCloseTo(blocks.x, 6);
      }
    }
  }, 120_000);

  it('still reads as the Magician: the figure on the horizon under its lemniscate, the flame round it, the helix climbing out of the card, the ground cracking from its feet', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const figure = box(points(result, 'figure-')), mark = box(points(result, 'mark-')), field = box(points(result, 'field-'));
      const helix = box(points(result, 'helix-')), ground = box(points(result, 'ground-')), cracks = box(points(result, 'cracks-'));
      const blocks = points(result, 'blocks-');
      // It stands in the middle of the card, its feet on the ground just below the horizon, its head above it.
      expect(Math.abs(figure.cx - centre)).toBeLessThan(2);
      expect(figure.y1).toBeGreaterThan(horizonY + 2);
      expect(figure.y0).toBeLessThan(horizonY - 4);
      // The lemniscate over its head, clear of it and centred on it.
      expect(mark.y1).toBeLessThan(figure.y0 - 2);
      expect(Math.abs(mark.cx - figure.cx)).toBeLessThan(1);
      // The flame flares wide on both sides of it and rises past the lemniscate.
      expect(field.x0).toBeLessThan(figure.x0 - 5);
      expect(field.x1).toBeGreaterThan(figure.x1 + 5);
      expect(field.y0).toBeLessThan(mark.y0);
      // The helix from its feet up out of the top of the window.
      expect(helix.y1).toBeGreaterThan(horizonY);
      expect(helix.y0).toBeLessThan(card.y0 + 1);
      // The ground below the horizon, the cracks starting just under its feet.
      expect(ground.y0).toBeGreaterThan(horizonY);
      expect(cracks.y0).toBeGreaterThan(figure.y1);
      expect(cracks.y0).toBeLessThan(figure.y1 + 3);
      // The blocks lift on both sides of it, the slabs over the top left among them.
      expect(blocks.some(p => p.x < figure.x0 - 10)).toBe(true);
      expect(blocks.some(p => p.x > figure.x1 + 10)).toBe(true);
      expect(blocks.some(p => p.x < centre - 10 && p.y < card.y0 + 0.25 * (card.y1 - card.y0))).toBe(true);
    }
  }, 120_000);

  it('fits the body to the scratch figure’s box at the card’s scale, holds it together, and keeps it on its own ground', async () => {
    const print = await renderSketch({ entry, seed: 1, params: { veil: 0 } });
    const printFigure = box(points(print, 'figure-carbon'));
    for (const fit of fits) {
      const { s } = formatOf(fit);
      const [scratchResult, bodyResult] = await Promise.all([render(fit, { veil: 0, figureStyle: 'scratch' }), render(fit, { veil: 0 })]);
      const scratch = box(points(scratchResult, 'figure-carbon')), body = box(points(bodyResult, 'figure-carbon'));
      // The print's figure, scaled with the card (its head's loop too)...
      expect((body.y1 - body.y0) / (printFigure.y1 - printFigure.y0) / s).toBeGreaterThan(0.95);
      expect((body.y1 - body.y0) / (printFigure.y1 - printFigure.y0) / s).toBeLessThan(1.05);
      // ...fitted to the scratch figure's box as on the print, to a millimetre there and the card's share of one here.
      expect(Math.abs(body.y0 - scratch.y0)).toBeLessThan(s);
      expect(Math.abs(body.y1 - scratch.y1)).toBeLessThan(s);
      expect(Math.abs(body.cx - scratch.cx)).toBeLessThan(s);
      // Its strokes hold together: tested for hidden lines at the card's raster (a limb four pixels across), its outline
      // broke into pieces of about half this length.
      const lengths = bodyResult.parts.find(part => part.id === 'figure-carbon')!.paths.map(length).sort((a, b) => a - b);
      expect(lengths[lengths.length >> 1]).toBeGreaterThan(2.2);
      expect(lengths.filter(l => l >= 3).reduce((sum, l) => sum + l, 0)).toBeGreaterThan(38);
      // Nothing else within the card's share of a millimetre of it.
      const figure = points(bodyResult, 'figure-carbon');
      const near = (q: Point) => figure.some(p => Math.hypot(p.x - q.x, p.y - q.y) < s);
      expect(bodyResult.parts.filter(part => part.id !== 'figure-carbon').flatMap(part => part.paths.flat()).filter(near)).toEqual([]);
    }
  }, 120_000);

  it('draws the lemniscate as one smooth line, nothing in its eyes, and keeps the flame’s curves', async () => {
    // The sharpest turn between two segments of a path, in degrees.
    const sharpest = (path: Point[]) => {
      let worst = 0;
      for (let i = 2; i < path.length; i++) {
        const a = Math.atan2(path[i - 1].y - path[i - 2].y, path[i - 1].x - path[i - 2].x), b = Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x);
        worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) * 180 / Math.PI);
      }
      return worst;
    };
    const inside = (ring: Point[], p: Point) => {
      let odd = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        if ((ring[a].y > p.y) !== (ring[b].y > p.y) && p.x < (ring[b].x - ring[a].x) * (p.y - ring[a].y) / (ring[b].y - ring[a].y) + ring[a].x) odd = !odd;
      }
      return odd;
    };
    const print = await renderSketch({ entry, seed: 1 });
    // The print hatches its band: two rules and the hatch between.
    expect(print.parts.find(part => part.id === 'mark-carbon')!.paths.length).toBeGreaterThan(20);
    for (const result of await Promise.all(fits.map(fit => render(fit)))) {
      // A band too narrow for its two rules is its line: one path, its curve kept (the reducer's tabloid stride made
      // it a polygon, turning 56° at its tips).
      const mark = result.parts.find(part => part.id === 'mark-carbon')!.paths;
      expect(mark).toHaveLength(1);
      expect(sharpest(mark[0])).toBeLessThan(25);
      for (const path of result.parts.filter(part => part.id.startsWith('field-')).flatMap(part => part.paths)) expect(sharpest(path)).toBeLessThan(20);
      // Nothing else in the eyes of its loops.
      const others = result.parts.filter(part => part.id !== 'mark-carbon' && !part.id.startsWith('card-')).flatMap(part => part.paths.flat());
      expect(others.filter(p => inside(mark[0], p))).toEqual([]);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(fit => render(fit))]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its ruling,
    // hatch, flame and figure shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['ground-carbon', 'blocks-carbon', 'field-acid', 'figure-carbon', 'mark-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, the width, where a render names none', async () => {
    const [plain, width] = await Promise.all([
      renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }),
      render('width'),
    ]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
