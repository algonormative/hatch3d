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

const entry = resolve('sketches/breach-tarot/x-wheel/sketch.ts');

describe('Breach Tarot: X Wheel of Fortune', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the rim, the towers, the hub, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'ground-carbon', 'rim-carbon', 'tower-carbon', 'hub-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('stands half sunk with one upright tower on top', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const points = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const ys = (match: (id: string) => boolean) => points(match).map(q => q.y);

    // The rim goes into the ground: it comes down among the broken paving round its crossings, and
    // nothing of it is drawn below that paving.
    const rimLow = Math.max(...ys(id => id.startsWith('rim-')));
    expect(rimLow).toBeLessThanOrEqual(Math.max(...ys(id => id.startsWith('ground-'))) - 2);
    expect(rimLow).toBeGreaterThan(Math.min(...ys(id => id.startsWith('ground-'))) + 10);

    // The highest mark of the wheel is a tower, and that tower stands upright on the sheet: its marks
    // at the top and 30 mm further down are centred within 5 degrees of one vertical.
    const top = Math.min(...ys(id => /^(rim|tower|hub)-/.test(id)));
    expect(Math.min(...ys(id => id.startsWith('tower-')))).toBeCloseTo(top, 3);
    const centreAt = (y0: number) => {
      const xs = points(id => id.startsWith('tower-')).filter(q => q.y >= y0 && q.y <= y0 + 8).map(q => q.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const lean = Math.atan2(Math.abs(centreAt(top) - centreAt(top + 30)), 30) * 180 / Math.PI;
    expect(lean).toBeLessThan(5);
  }, 60_000);
});

describe('Breach Tarot: X Wheel of Fortune at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, match: (id: string) => boolean) => result.parts.filter(part => match(part.id)).flatMap(part => part.paths);
  const points = (result: RenderResult, match: (id: string) => boolean) => paths(result, match).flat();
  const starts = (prefix: string) => (id: string) => id.startsWith(prefix);
  const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const length = (path: Point[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  // Points every `step` mm along some paths.
  const along = (ps: Point[][], step: number) => ps.flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  const wheel = (id: string) => /^(rim|tower|hub)-/.test(id);
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the hub, the axle and its helix, every rim segment, course, spoke and paving block', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-wheel-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { wheelWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/x-wheel/geometry.ts'))};
      export default { name: 'wheel-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'hubX', label: 'Hub across the sheet', default: 118, min: 100, max: 200, step: 1 },
          { type: 'slider', id: 'topY', label: 'Top tower tip down the sheet', default: 107, min: 60, max: 200, step: 1 },
        ],
        draw(ctx) {
          const w = wheelWorld(ctx), h = createHash('sha256');
          const at = p => h.update([p.x, p.y, p.z, ';'].join(','));
          at(w.L.C);
          h.update([w.L.hubY, w.L.D, w.tNear, w.tFar, w.bore, ';'].join(','));
          for (const p of w.axleCurve.points) at(p);
          for (const s of w.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.kind, s.tone, s.psi, s.tower, ';'].join(','));
          for (const g of w.helix.full) { const a = g.getAttribute('position').array; h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); }
          const d = h.digest(), count = kind => w.slabs.filter(s => s.kind === kind).length;
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + count('paver'), y: 20 + count('tower') / 10 }]] }];
        } };`);
    // The default, and the hub further right with the top tower's tip lower.
    for (const params of [{}, { hubX: 160, topY: 140 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      // Some paving kept round the crossings, and the towers' courses.
      expect(counts[1].x, JSON.stringify(params)).toBeGreaterThan(20 + 2);
      expect(counts[1].y, JSON.stringify(params)).toBeGreaterThan(20 + 3);
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
      // Paths wholly inside the art window, per part of the scene: the sky, the paving, the rim, the towers, the hub, the helix, the horizon.
      const inWindow = (prefix: string) => paths(first, starts(prefix))
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 30, 'ground-': 15, 'rim-': 120, 'tower-': 120, 'hub-': 50, 'helix-': 15, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      // Nor at the smallest lettering, whose words would fit a tower's course on this card.
      const smallest = await renderSketch({ entry, seed: 2, params: { sloganSize: 1.6 }, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
      expect(smallest.parts.some(part => part.id.startsWith('slogan-'))).toBe(false);
      const phrase = points(first, id => id === 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Wheel: half sunk among its paving, the proud capped tower upright on top, the rising towers short and pale, the falling ones plunging dark into the ground, the axle through the hub toward the horizon', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const ys = (match: (id: string) => boolean) => points(result, match).map(q => q.y);
      // The rim goes into the ground among the broken paving round its crossings, and nothing of it is drawn below that
      // paving: the print's test, its millimetres scaled with the card. The paving lies below the horizon.
      const rimLow = Math.max(...ys(starts('rim-'))), ground = box(points(result, starts('ground-')));
      expect(rimLow).toBeLessThanOrEqual(ground.y1 - 2 * s);
      expect(rimLow).toBeGreaterThan(ground.y0 + 10 * s);
      expect(ground.y0).toBeGreaterThan(horizonY);
      // The highest mark of the wheel is a tower, above the horizon and well inside the window, standing upright: its
      // marks at the top and 30 print millimetres down are centred within 5 degrees of one vertical.
      const tower = points(result, starts('tower-'));
      const top = Math.min(...ys(wheel));
      expect(Math.min(...tower.map(q => q.y))).toBeCloseTo(top, 3);
      expect(top).toBeGreaterThan(card.y0 + 10 * s);
      expect(top).toBeLessThan(horizonY - 100 * s);
      const band = (y0: number, y1: number, near?: number) => {
        const xs = tower.filter(q => q.y >= top + y0 * s && q.y <= top + y1 * s && (near === undefined || Math.abs(q.x - near) < 25 * s)).map(q => q.x);
        return { centre: (Math.min(...xs) + Math.max(...xs)) / 2, width: Math.max(...xs) - Math.min(...xs) };
      };
      const lean = Math.atan2(Math.abs(band(0, 8).centre - band(30, 38).centre), 30 * s) * 180 / Math.PI;
      expect(lean).toBeLessThan(5);
      // Its cap: the top course stands wider than the shaft under it (by a fifth, as the print's does).
      const shaft = band(16, 30, band(16, 30, band(0, 8).centre).centre);
      expect(band(4, 10, shaft.centre).width / shaft.width).toBeGreaterThan(1.12);
      // The hub sits below the horizon, and the axle runs through it: in from the window's left edge low in the
      // foreground, out at its right edge between the hub and the horizon.
      const hub = box(points(result, starts('hub-'))), hubY = (hub.y0 + hub.y1) / 2;
      expect(hubY).toBeGreaterThan(horizonY);
      const helix = points(result, starts('helix-'));
      const left = helix.reduce((a, b) => (b.x < a.x ? b : a)), right = helix.reduce((a, b) => (b.x > a.x ? b : a));
      expect(left.x).toBeLessThan(card.x0 + 0.5);
      expect(left.y).toBeGreaterThan(hub.y1);
      expect(right.x).toBeGreaterThan(card.x1 - 0.5);
      expect(right.y).toBeGreaterThan(horizonY);
      expect(right.y).toBeLessThan(hubY);
      expect(helix.filter(q => q.x > hub.x0 && q.x < hub.x1 && q.y > hub.y0 && q.y < hub.y1).length).toBeGreaterThan(10);
      // The towers on the rising side (left of the hub) stop short of the ground; on the falling side they go into it.
      const hubX = (hub.x0 + hub.x1) / 2;
      const lowest = (side: number) => Math.max(...tower.filter(q => Math.sign(q.x - hubX) === side).map(q => q.y));
      expect(lowest(1)).toBeGreaterThan(lowest(-1) + 10 * s);
      expect(lowest(1)).toBeGreaterThan(ground.y0);
      // The sky is ruled above the horizon only.
      expect(Math.max(...ys(starts('sky-')))).toBeLessThan(horizonY);
    }
  }, 120_000);

  it('keeps the falling towers dark and the rising ones pale: their dark faces ruled along their length, which the facet hatch’s ticks are not', async () => {
    for (const result of await Promise.all(fits.map(render))) {
      const hub = box(points(result, starts('hub-'))), hubX = (hub.x0 + hub.x1) / 2;
      // A ruled line runs a face's length (several millimetres); the facet hatch fits ticks of a millimetre or two.
      const ruled = (side: number) => paths(result, id => id === 'tower-ultramarine').filter(path => Math.sign(path[0].x - hubX) === side && length(path) > 2.5).length;
      expect(ruled(1)).toBeGreaterThanOrEqual(4);
      expect(ruled(-1)).toBe(0);
    }
  }, 120_000);

  it('draws the slabs’ edges whole and the helix by its lines on a small card', async () => {
    for (const result of await Promise.all(fits.map(render))) {
      // The depth test runs finer than the card's raster: against it, the edges of faces seen nearly edge-on broke into
      // dashes, and over a dozen scraps under half a millimetre (15 and 22) printed among the stone's outlines.
      const outlines = paths(result, id => /^(rim|tower|hub|ground)-carbon$/.test(id));
      expect(outlines.filter(path => length(path) < 0.5).length).toBeLessThan(13);
      // Every strand is narrower than a feature on this paper, so the helix is two lines: strand a's spine (acid) and
      // strand b's middle (vermilion), with none of its laminations, ribs or pulses (300 mm of ink in four inks).
      expect(result.parts.filter(part => part.id.startsWith('helix-')).map(part => part.id).sort()).toEqual(['helix-acid', 'helix-vermilion']);
      expect(paths(result, starts('helix-')).reduce((sum, path) => sum + length(path), 0)).toBeLessThan(150);
    }
  }, 120_000);

  it('holds the knockout round what stands at its floor: the sky stops half a millimetre or so from the wheel, not the print’s millimetre', async () => {
    for (const [k, result] of (await Promise.all(fits.map(render))).entries()) {
      const { card } = formatOf(fits[k]);
      // Each end of a sky rule inside the window, within 1.6 mm of a mark of the wheel, the ground or the helix: its gap to it.
      const solid = along(paths(result, id => /^(rim|tower|hub|ground|helix)-/.test(id)), 0.05);
      const gaps: number[] = [];
      for (const path of paths(result, id => id === 'sky-carbon')) for (const end of [path[0], path.at(-1)!]) {
        if (end.x < card.x0 + 0.2 || end.x > card.x1 - 0.2) continue;
        let nearest = Infinity;
        for (const q of solid) nearest = Math.min(nearest, Math.hypot(q.x - end.x, q.y - end.y));
        if (nearest < 1.6) gaps.push(nearest);
      }
      gaps.sort((a, b) => a - b);
      expect(gaps.length).toBeGreaterThan(10);
      // At least the floor (0.5 mm, less the coverage grid's third of a millimetre): the card's scale alone (a quarter of
      // a millimetre) cuts the sky into the stone. No wider than the floor plus that grid: the print's millimetre left
      // a cut-out round the wheel.
      expect(gaps[0]).toBeGreaterThan(0.4);
      expect(gaps[gaps.length >> 1]).toBeLessThan(0.9);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // The slabs are trimmed for the small card (kit/slabs.ts' `SlabTrim`): untrimmed, their back edges and sliver
      // faces doubled the towers' outlines, and over a third of them ran too close (36-38%, in either fit).
      const towers = report.parts.find(part => part.id === 'tower-carbon')!;
      expect(towers.share, describeDensity(report)).toBeLessThan(0.25);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling and
    // the stone's facet hatch shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'rim-carbon', 'tower-carbon', 'hub-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
