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

const entry = resolve('sketches/breach-tarot/iii-empress/sketch.ts');

describe('Breach Tarot: III The Empress', () => {
  it('replays, stays inside the card, and draws the sky, the ground rules, the far field, the crop, the wind, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['sky-carbon', 'ground-carbon', 'far-carbon', 'crop-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    // The wind keeps the helix's own inks: it is not remapped to one pen.
    expect(ids).toContain('wind-vermilion');
  }, 60_000);

  it('draws the wind as a wave across the card: its strokes span 60% of the art window across and 15% of it up and down', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const wind = result.parts.filter(p => p.id.startsWith('wind-')).flatMap(p => p.paths).flat();
    expect(wind.length).toBeGreaterThan(0);
    const xs = wind.map(p => p.x), ys = wind.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(0.6 * (CARD.x1 - CARD.x0));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(0.15 * (CARD.y1 - CARD.y0));
  }, 60_000);
});

describe('Breach Tarot: III The Empress at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  const length = (path: Point[]) => path.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) : 0), 0);
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('plants the same seeded world at every size and fit: every plant, block and tick, and the wind', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-empress-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { empressCamera, empressWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/iii-empress/geometry.ts'))};
      export default { name: 'empress-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1 },
          { type: 'slider', id: 'eye', label: 'Eye height', default: 6, min: 3, max: 12, step: 0.5 }],
        draw(ctx) {
          const w = empressWorld(ctx, empressCamera(ctx)), h = createHash('sha256');
          for (const p of w.plants) {
            h.update([p.base.x, p.base.y, p.base.z, p.top.x, p.top.y, p.top.z, p.depth, p.outline, ';'].join(','));
            for (const s of p.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.tone, s.beat, s.role, ';'].join(','));
          }
          for (const t of w.ticks) for (const q of t) h.update([q.x, q.y, q.z, ';'].join(','));
          for (const q of w.wind.curve.points) h.update([q.x, q.y, q.z, ';'].join(','));
          for (const g of w.wind.meshes) { const a = g.getAttribute('position').array; h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
          const d = h.digest();
          const slabs = w.plants.reduce((n, p) => n + p.slabs.length, 0), outlined = w.plants.filter(p => p.outline).length;
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.plants.length / 10, y: 20 + outlined / 10 }, { x: 20 + slabs / 1000, y: 20 + w.ticks.length / 10 }]] }];
        } };`);
    // The default, and a wider, higher view (the plants' culls and course counts are measured on the paper).
    for (const params of [{}, { fov: 70, eye: 9 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 100 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 20 / 10);
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
      // Paths wholly inside the art window, per part of the scene: the sky, the ground rules, the far field, the crop,
      // the wind and the horizon.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 15, 'ground-': 3, 'far-': 3, 'crop-': 400, 'wind-': 60, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Empress: towers on the ground rising high into the sky, furrows meeting at one point on the horizon, the wind one S across the sky, the sky ruled at the print’s pitch', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY } = formatOf(fit);
      const width = card.x1 - card.x0, height = card.y1 - card.y0, centre = (card.x0 + card.x1) / 2;
      const ys = (ps: Point[]) => ps.map(p => p.y), xs = (ps: Point[]) => ps.map(p => p.x);
      // The crop stands on the near ground and its ripe towers rise into the top third of the window.
      const crop = points(result, 'crop-');
      expect(Math.max(...ys(crop))).toBeGreaterThan(horizonY + 0.5 * (card.y1 - horizonY));
      expect(Math.min(...ys(crop))).toBeLessThan(card.y0 + height / 3);
      // The ridges between the furrows lie on the ground and, run on, meet at one point on the horizon, right of the
      // centre line (the furrows aim right by default), in the middle third of the card.
      const ridges = paths(result, 'ground-');
      expect(Math.min(...ys(ridges.flat()))).toBeGreaterThan(horizonY);
      const meets = ridges.map(path => {
        const low = path.reduce((a, b) => (b.y > a.y ? b : a)), high = path.reduce((a, b) => (b.y < a.y ? b : a));
        return low.x + (high.x - low.x) * (horizonY - low.y) / (high.y - low.y);
      });
      expect(meets.length).toBeGreaterThan(2);
      expect(Math.max(...meets) - Math.min(...meets)).toBeLessThan(0.5);
      expect(meets[0]).toBeGreaterThan(centre);
      expect(meets[0]).toBeLessThan(centre + width / 6);
      // The wind runs edge to edge in the sky, a wave a sixth of the window deep, wholly above the horizon.
      const wind = points(result, 'wind-');
      expect(Math.min(...xs(wind))).toBeLessThan(card.x0 + 0.05 * width);
      expect(Math.max(...xs(wind))).toBeGreaterThan(card.x1 - 0.05 * width);
      expect(Math.max(...ys(wind)) - Math.min(...ys(wind))).toBeGreaterThan(0.15 * height);
      expect(Math.max(...ys(wind))).toBeLessThan(horizonY);
      // The sky is ruled above the horizon, 1.2 mm apart at the top as on the print (a pitch scaled with the card would
      // be a third of a millimetre).
      const sky = paths(result, 'sky-');
      expect(Math.max(...ys(sky.flat()))).toBeLessThan(horizonY);
      const rows = [...new Set(sky.map(path => Math.round(path[0].y * 1000) / 1000))].sort((a, b) => a - b);
      expect(rows.length).toBeGreaterThan(5);
      for (let i = 1; i < 5; i++) expect(rows[i] - rows[i - 1]).toBeCloseTo(1.2, 2);
    }
  }, 120_000);

  it('draws its preferred fit, the width, where the render names none', async () => {
    const [plain, width] = await Promise.all([
      renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }),
      render('width'),
    ]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is; the far field clears what stands in front of it, the crop keeps no specks', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const [k, result] of small.entries()) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // A far plant a row behind another gives way to it (`Clearance`, kit/page.ts): drawn as on the print, its sliver of outline
      // ran beside the nearer one closer than the pens hold apart, on four seeds of five well past the print's share.
      const far = report.parts.find(part => part.id === 'far-carbon')!;
      expect(far.drawn).toBeGreaterThan(20);
      expect(far.violations, describeDensity(report)).toBe(0);
      // No piece of the crop is shorter than the smallest feature: hatch specks and the stubs of cut edges are gone.
      const { minFeature } = formatOf(fits[k]);
      for (const path of paths(result, 'crop-')) expect(length(path)).toBeGreaterThanOrEqual(minFeature - 0.01);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling,
    // facet hatch and wind laminations shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'crop-carbon', 'wind-violet']) expect(denser).toContain(id);
  }, 120_000);
});
