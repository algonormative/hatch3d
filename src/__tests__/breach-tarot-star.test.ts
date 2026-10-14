import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { CONSTELLATION_FLOOR } from '../../sketches/breach-tarot/xvii-star/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { TABLOID_FORMAT, formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xvii-star/sketch.ts');

describe('Breach Tarot: XVII The Star', () => {
  it('replays, stays inside the card, and carries night, star, water, frame and phrase', async () => {
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
    for (const id of ['night-carbon', 'star-carbon', 'water-ultramarine', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('keeps the night above the horizon and the reflections below it', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const night = result.parts.filter(p => p.id.startsWith('night-')).flatMap(p => p.paths.flat());
    const water = result.parts.filter(p => p.id.startsWith('water-') || p.id.startsWith('glitter-')).flatMap(p => p.paths.flat());
    expect(night.length).toBeGreaterThan(100);
    expect(water.length).toBeGreaterThan(100);
    expect(Math.max(...night.map(p => p.y))).toBeLessThan(HORIZON_Y);
    expect(Math.min(...water.map(p => p.y))).toBeGreaterThan(HORIZON_Y);
  }, 30_000);
});

describe('Breach Tarot: XVII The Star at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
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
      // Paths wholly inside the art window, per part of the scene: the night, the star, the fragments, their links, the
      // streams, the water rows and the glitter path.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'night-': 250, 'star-': 40, 'pieces-': 80, 'constellation-': 8, 'helix-': 70, 'water-': 40, 'glitter-': 20 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('keeps its seeded sky at every size: the same star, word fragments and debris, the debris thinned to a constellation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-star-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: each of the sky's solids as a short path that encodes its world centre, from (42 + x, 20 + y)
    // to (43 + x, 110 + z), inside the margin of either page; and the debris the format draws.
    await writeFile(probeEntry, `import { hatchMin } from ${JSON.stringify(resolve('sketches/kit/format.ts'))};
      import { shownDebris, sky, starCamera } from ${JSON.stringify(resolve('sketches/breach-tarot/xvii-star/geometry.ts'))};
      const at = s => [{ x: 42 + s.x, y: 20 + s.y }, { x: 43 + s.x, y: 110 + s.z }];
      export default { name: 'star-sky', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'constellation', label: 'Constellation', default: 0.5, min: 0, max: 1, step: 0.01 }],
        draw(ctx) {
          const view = starCamera(ctx), s = sky(ctx, view);
          return [{ id: 'star', pen: 'ink', paths: s.star.map(at) }, { id: 'words', pen: 'ink', paths: s.words.map(at) },
            { id: 'debris', pen: 'ink', paths: s.debris.map(at) }, { id: 'shown', pen: 'ink', paths: shownDebris(s.debris, view).map(at) },
            { id: 'speck', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 21, y: 20 + 10 * (hatchMin('hatch') ?? 0) }]] }];
        } };`);
    const solids = (result: RenderResult, id: string) => result.parts.find(part => part.id === id)?.paths ?? [];
    const a5 = { width: 148, height: 210 };
    const [print, larger, sparse, full, ...small] = await Promise.all([
      renderSketch({ entry: probeEntry, seed: 2 }),
      renderSketch({ entry: probeEntry, seed: 2, finishing: { page: a5 } }),
      ...[0, 1].map(constellation => renderSketch({ entry: probeEntry, seed: 2, params: { constellation }, finishing: { page } })),
      ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
    ]);
    expect(solids(print, 'debris').length).toBeGreaterThan(40);
    // The print keeps every scrap of hatch; a small card drops what is shorter than the smallest feature (1 mm).
    const speck = (result: RenderResult) => solids(result, 'speck')[0].at(-1)!.y - 20;
    expect(speck(print)).toBe(0);
    for (const result of small) expect(speck(result)).toBeCloseTo(10, 3);
    expect(solids(print, 'shown')).toEqual(solids(print, 'debris'));
    const near = (a: Point[], b: Point[]) => a.every((p, i) => Math.abs(p.x - b[i].x) < 0.01 && Math.abs(p.y - b[i].y) < 0.01);
    for (const result of small) {
      for (const id of ['star', 'words', 'debris']) {
        const here = solids(result, id), there = solids(print, id);
        expect(here.length, id).toBe(there.length);
        here.forEach((path, i) => expect(near(path, there[i]), `${id} ${i}`).toBe(true));
      }
      // A constellation, not the print's crowd: the format's share of the fragments the print seeded, less any too
      // small or outside the sky; and a subset of what a larger card (A5) shows.
      const shown = solids(result, 'shown');
      expect(shown.length).toBeGreaterThanOrEqual(CONSTELLATION_FLOOR - 4);
      expect(shown.length).toBeLessThanOrEqual(CONSTELLATION_FLOOR + 2);
      for (const path of shown) expect(solids(result, 'debris').some(seeded => near(path, seeded))).toBe(true);
      for (const path of shown) expect(solids(larger, 'shown').some(kept => near(path, kept))).toBe(true);
    }
    expect(solids(larger, 'shown').length).toBeGreaterThan(solids(small[0], 'shown').length);
    // The constellation control still sets how many show on a small card.
    expect(solids(sparse, 'shown').length).toBeLessThan(solids(small[0], 'shown').length);
    expect(solids(full, 'shown').length).toBeGreaterThan(solids(small[0], 'shown').length);
  }, 120_000);

  it('still reads as the Star: the star where the print has it, the streams pouring from under it to the water, the glitter path beneath it, every fragment haloed', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
    const printStar = box(points(print, 'star-'));
    // The nearest a night stroke comes to a fragment's or the star's outline (points every 0.1 mm), by a grid.
    const along = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flatMap(path => path.flatMap((b, i) => {
      if (!i) return [b];
      const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1);
      return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
    })));
    const clearance = (result: RenderResult) => {
      const cells = new Map<string, Point[]>();
      for (const p of [...along(result, 'star-'), ...along(result, 'pieces-')]) {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)}`;
        cells.set(key, [...cells.get(key) ?? [], p]);
      }
      let nearest = Infinity;
      for (const p of along(result, 'night-')) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const q of cells.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? []) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      }
      return nearest;
    };
    // The glitter path, from the gap it leaves in each water row: whether every row is parted, and its mean width in the
    // far and near halves of the water.
    const path = (result: RenderResult, bottom: number, horizonY: number) => {
      const rows = new Map<number, number[][]>();
      for (const part of result.parts.filter(p => p.id.startsWith('water-'))) for (const row of part.paths) {
        rows.set(row[0].y, [...rows.get(row[0].y) ?? [], [Math.min(row[0].x, row.at(-1)!.x), Math.max(row[0].x, row.at(-1)!.x)]]);
      }
      const halves: number[][] = [[], []];
      for (const [y, segments] of rows) if (segments.length === 2) {
        const [left, right] = segments.sort((a, b) => a[0] - b[0]);
        halves[(y - horizonY) / (bottom - horizonY) < 0.5 ? 0 : 1].push(right[0] - left[1]);
      }
      const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
      return { parted: halves[0].length + halves[1].length === rows.size, widths: [mean(halves[0]), mean(halves[1])] as const };
    };
    for (const [i, result] of small.entries()) {
      const { card, horizonY, s } = formatOf(fits[i]);
      // Back in tabloid's frame (from the window's centre line and the horizon), the star is the print's: its hub in the
      // same place, as wide and as tall.
      const star = box(points(result, 'star-'));
      const tabloid = (x: number, y: number) => ({ x: TABLOID_PAGE.width / 2 + (x - page.width / 2) / s, y: TABLOID_FORMAT.horizonY + (y - horizonY) / s });
      const hub = tabloid((star.x0 + star.x1) / 2, (star.y0 + star.y1) / 2);
      expect(Math.abs(hub.x - (printStar.x0 + printStar.x1) / 2)).toBeLessThan(1);
      expect(Math.abs(hub.y - (printStar.y0 + printStar.y1) / 2)).toBeLessThan(1);
      expect((star.x1 - star.x0) / s / (printStar.x1 - printStar.x0)).toBeCloseTo(1, 1);
      expect((star.y1 - star.y0) / s / (printStar.y1 - printStar.y0)).toBeCloseTo(1, 1);
      // The streams pour from under the star's hub to the horizon.
      const streams = box(points(result, 'helix-'));
      expect(streams.y0).toBeGreaterThan((star.y0 + star.y1) / 2);
      expect(streams.y0).toBeLessThan(card.y0 + 0.6 * (horizonY - card.y0));
      expect(streams.y1).toBeGreaterThan(horizonY - 1);
      // Night above the horizon, the water and its glitter below; the glitter path runs down beneath the star.
      expect(Math.max(...points(result, 'night-').map(p => p.y))).toBeLessThan(horizonY);
      const water = [...points(result, 'water-'), ...points(result, 'glitter-')];
      expect(Math.min(...water.map(p => p.y))).toBeGreaterThan(horizonY);
      const sparkle = points(result, 'glitter-acid');
      // Sparkle in proportion: fewer rows, each holding as many dashes as its narrower path does (the print's count
      // scaled twice, about S squared), not the print's count on every row.
      const dashes = (r: RenderResult) => r.parts.filter(part => part.id === 'glitter-acid').reduce((n, part) => n + part.paths.length, 0);
      expect(dashes(result)).toBeLessThan(0.15 * dashes(print));
      expect(dashes(result)).toBeGreaterThan(0.03 * dashes(print));
      expect(Math.abs(sparkle.reduce((sum, p) => sum + p.x, 0) / sparkle.length - (star.x0 + star.x1) / 2)).toBeLessThan(1.5);
      // It parts every row, and widens toward the viewer as the print's does: in tabloid's millimetres, its mean width in
      // the near and the far half of the water is within a quarter of the print's.
      const here = path(result, card.y1, horizonY), there = path(print, TABLOID_FORMAT.card.y1, TABLOID_FORMAT.horizonY);
      expect(here.parted).toBe(true);
      for (const half of [0, 1] as const) {
        expect(here.widths[half] / s / there.widths[half], `half ${half}`).toBeGreaterThan(0.75);
        expect(here.widths[half] / s / there.widths[half], `half ${half}`).toBeLessThan(1.25);
      }
      // The night keeps clear of every fragment and the star by more than its own ruling (1.025 mm at the default): a
      // paper halo round each that reads as glow, not as a cut-out.
      expect(clearance(result)).toBeGreaterThan(1.025);
      // Each of the eight arms keeps its shaded side, too narrow to hatch: a line of the hatch's ink down its length, one
      // to an arm, on the side in shade only (its lit sides are as narrow, but the print leaves them paper).
      const length = (line: Point[]) => line.slice(1).reduce((sum, q, k) => sum + Math.hypot(q.x - line[k].x, q.y - line[k].y), 0);
      const shaded = result.parts.filter(part => part.id === 'star-ultramarine').flatMap(part => part.paths).filter(line => length(line) > 5);
      expect(shaded.length).toBe(8);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its night
    // ruling, water rows and facet hatch shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['night-carbon', 'night-ultramarine', 'water-ultramarine', 'star-carbon']) expect(denser).toContain(id);
  }, 120_000);
});
