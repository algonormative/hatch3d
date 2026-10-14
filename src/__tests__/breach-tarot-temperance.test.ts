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
import type { RenderResult } from '../sketch/types.ts';
import { nearestDistance } from './helpers/nearest.ts';

const entry = resolve('sketches/breach-tarot/xiv-temperance/sketch.ts');

type Pt = { x: number; y: number };
const box = (pts: Pt[]) => ({ top: Math.min(...pts.map(p => p.y)), base: Math.max(...pts.map(p => p.y)), left: Math.min(...pts.map(p => p.x)), right: Math.max(...pts.map(p => p.x)) });

describe('Breach Tarot: XIV Temperance', () => {
  it('replays, stays inside the card, and draws the sky, the water and its reflection, the paving, the shore, both vessels, the helix, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
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
    for (const id of ['sky-carbon', 'water-carbon', 'reflect-carbon', 'land-carbon', 'shore-carbon', 'near-carbon', 'far-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('pours uphill and both ways: the helix rises above both rims between the vessels, arrives at each rim, and the far vessel stands in the water', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const ink = (match: (id: string) => boolean): Pt[] => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const near = box(ink(id => id.startsWith('near-'))), far = box(ink(id => id.startsWith('far-')));
    const helix = ink(id => id.startsWith('helix-'));
    const water = ink(id => id.startsWith('water-'));

    // It climbs: the far vessel's rim is the lower one, and between the two vessels the helix rises
    // at least 20 mm above the higher rim (a pour that fell would sag below it).
    expect(far.top).toBeGreaterThan(near.top + 60);
    const between = helix.filter(p => p.x > near.right && p.x < far.left);
    expect(between.length).toBeGreaterThan(200);
    expect(Math.min(near.top, far.top) - Math.min(...between.map(p => p.y))).toBeGreaterThan(20);

    // It goes both ways: at each rim the helix arrives, and a strand spills over it and hangs below the rim
    // line, one at each end (nothing of it below either rim means the pour stops short of that vessel).
    for (const vessel of [near, far]) {
      const spill = helix.filter(p => p.x > vessel.left - 30 && p.x < vessel.right + 30 && p.y > vessel.top + 8 && p.y < vessel.top + 80);
      expect(spill.length).toBeGreaterThan(20);
    }

    // The far vessel stands in the water, the near one on the land: at each base the water ruling either
    // runs on both sides of the vessel (far) or starts clear to its right (near).
    const waterAt = (y: number) => water.filter(p => Math.abs(p.y - y) < 1.2);
    const atFar = waterAt(far.base), atNear = waterAt(near.base);
    expect(atFar.length).toBeGreaterThan(50);
    expect(Math.min(...atFar.map(p => p.x))).toBeLessThan(far.left - 4);
    expect(Math.max(...atFar.map(p => p.x))).toBeGreaterThan(far.right + 4);
    expect(atNear.length === 0 || Math.min(...atNear.map(p => p.x)) > near.right + 4).toBe(true);
  }, 60_000);
});

describe('Breach Tarot: XIV Temperance at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const length = (path: Pt[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: both vessels course by course, the helix\'s course from rim to rim, the shore and the paving', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-temperance-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { temperanceWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/xiv-temperance/geometry.ts'))};
      export default { name: 'temperance-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'nearX', label: 'Near vessel: page x', default: 74, min: 30, max: 120, step: 1 },
          { type: 'slider', id: 'farRim', label: 'Far vessel: rim at page y', default: 190, min: 120, max: 240, step: 1 },
          { type: 'slider', id: 'arcX', label: 'Arc shifted across', default: 0, min: -40, max: 40, step: 1 },
          { type: 'slider', id: 'shoreFoot', label: 'Shore meets the bottom at page x', default: 250, min: 150, max: 330, step: 1 },
        ],
        draw(ctx) {
          const w = temperanceWorld(ctx), h = createHash('sha256');
          const v3 = v => [v.x, v.y, v.z].join(',');
          for (const v of [w.near, w.far]) {
            h.update([v3(v.axis), v.yaw, v.rim, v.lipHalf, v3(v.right), v3(v.front), ';'].join(','));
            for (const s of v.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.beat, s.role, s.tone, ';'].join(','));
          }
          for (const plan of w.plans) {
            h.update([plan.index, plan.ref, plan.tipStart, plan.tipEnd, ...plan.points.map(v3), ...plan.points.map(w.scaleAt), ';'].join(','));
            if (plan.reroute) h.update([plan.reroute.from, ...plan.reroute.points.map(v3), ';'].join(','));
          }
          for (const t of [12, 20, 40, 80, 160, 320, 640, 1280]) h.update(w.shoreX(t) + ';');
          h.update([...w.paving.rows, w.paving.course, ...w.paving.joints.flatMap(j => [j.sp, j.off]), ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.near.slabs.length + w.far.slabs.length / 100, y: 20 + w.paving.rows.length }]] }];
        } };`);
    // The default, and the vessels, the arc and the shore moved.
    for (const params of [{}, { nearX: 50, farRim: 160, arcX: 20, shoreFoot: 200 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeCloseTo(20 + 17 + 13 / 100, 6);
      expect(counts[1].y).toBeGreaterThan(20 + 10);
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
      // Paths wholly inside the art window, per part of the scene: the sky, the water and its reflection, the paving, the
      // shore, both vessels, the helix and the horizon.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 25, 'water-': 50, 'reflect-': 25, 'land-': 12, 'shore-': 0, 'near-': 100, 'far-': 40, 'helix-': 150, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(50);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as Temperance: the pour climbs from the far rim over the near one and spills at both, the far vessel stands in the water and is mirrored there, the near one on paved land', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { horizonY, s } = formatOf(fit);
      const near = box(points(result, 'near-')), far = box(points(result, 'far-'));
      const helix = points(result, 'helix-'), water = points(result, 'water-');
      // It climbs: the far rim is the lower one, and between the vessels the helix rises above the higher rim by what the
      // print's does, scaled with the card (20 mm there), all of it in the sky.
      expect(far.top, fit).toBeGreaterThan(near.top + 60 * s);
      const between = helix.filter(p => p.x > near.right && p.x < far.left);
      expect(between.length, fit).toBeGreaterThan(100);
      expect(Math.min(near.top, far.top) - Math.min(...between.map(p => p.y)), fit).toBeGreaterThan(20 * s);
      expect(Math.max(...helix.map(p => p.y)), fit).toBeLessThan(horizonY);
      // It goes both ways: at each rim a strand spills over and hangs below the rim line.
      for (const [name, vessel] of [['near', near], ['far', far]] as const) {
        const spill = helix.filter(p => p.x > vessel.left - 30 * s && p.x < vessel.right + 30 * s && p.y > vessel.top + 8 * s && p.y < vessel.top + 80 * s);
        expect(spill.length, `${fit} ${name} spill`).toBeGreaterThan(20);
      }
      // The far vessel stands in the water: the ruling within a millimetre of its foot runs past the foot on both sides; the
      // near one stands on land, the water at its foot starting clear to its right.
      const foot = (prefix: string) => {
        const ps = points(result, prefix), base = Math.max(...ps.map(p => p.y));
        return box(ps.filter(p => p.y > base - 3 * s));
      };
      const farFoot = foot('far-'), nearFoot = foot('near-');
      const waterAt = (y: number) => water.filter(p => Math.abs(p.y - y) < 1);
      const atFar = waterAt(farFoot.base), atNear = waterAt(nearFoot.base);
      expect(atFar.length, fit).toBeGreaterThan(20);
      expect(Math.min(...atFar.map(p => p.x)), fit).toBeLessThan(farFoot.left - 4 * s);
      expect(Math.max(...atFar.map(p => p.x)), fit).toBeGreaterThan(farFoot.right + 4 * s);
      expect(atNear.length === 0 || Math.min(...atNear.map(p => p.x)) > nearFoot.right + 4 * s, fit).toBe(true);
      // Mirrored: the reflection hangs under the far vessel, inside its width.
      const reflection = points(result, 'reflect-');
      expect(reflection.length, fit).toBeGreaterThan(50);
      expect(reflection.filter(p => p.y > farFoot.base - 0.1 && p.x > far.left - 1 && p.x < far.right + 1).length / reflection.length, fit).toBeGreaterThan(0.95);
      // The land is paved in courses: rows across it, below the horizon, and the joints between them.
      const land = paths(result, 'land-');
      const rows = land.filter(path => Math.abs(path[0].y - path.at(-1)!.y) < 0.01);
      expect(rows.length, fit).toBeGreaterThan(5);
      expect(land.length - rows.length, fit).toBeGreaterThan(5);
      expect(Math.min(...land.flat().map(p => p.y)), fit).toBeGreaterThan(horizonY);
    }
  }, 120_000);

  it('keeps the paper round the vessels and the helix at the card\'s scale: no ruling nearer than the halo\'s floor, none further than the halo scaled', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      const sky = points(result, 'sky-'), water = points(result, 'water-');
      const vessels = [...points(result, 'near-'), ...points(result, 'far-')], helix = points(result, 'helix-');
      // The sky and the water stop short of the vessels by the knockout (1.1 mm on the print, scaled with the card, never
      // under 0.5 mm), and the sky short of the helix by its clearing (2.6 mm on the print). The halo is measured on a
      // raster, so a clean ruling stands a little under the floor: none nearer than about 0.35 mm, nor further than the
      // scaled halo and a little more (the water's breaks and the sky's pitch leave a few tenths).
      const skyToVessels = nearestDistance(sky, vessels), waterToVessels = nearestDistance(water, vessels), skyToHelix = nearestDistance(sky, helix);
      expect(skyToVessels, `${fit} sky to vessels`).toBeGreaterThan(0.35);
      expect(skyToVessels, `${fit} sky to vessels`).toBeLessThan(Math.max(0.5, 1.1 * s) + 0.15);
      expect(waterToVessels, `${fit} water to vessels`).toBeGreaterThan(0.35);
      expect(waterToVessels, `${fit} water to vessels`).toBeLessThan(Math.max(0.5, 1.1 * s) + 0.3);
      expect(skyToHelix, `${fit} sky to helix`).toBeGreaterThan(0.4);
      expect(skyToHelix, `${fit} sky to helix`).toBeLessThan(Math.max(0.5, 2.6 * s) + 0.3);
    }
  }, 120_000);

  it('keeps the vessels clean and their shaded sides dark on a small card: the outlines trimmed, the dark faces ruled near the print\'s weight', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    // The near vessel's field ink (ultramarine and violet) per square millimetre of its box, against the print's.
    const field = (result: RenderResult) => {
      const b = box(points(result, 'near-'));
      return [...paths(result, 'near-ultramarine'), ...paths(result, 'near-violet')].reduce((sum, path) => sum + length(path), 0) / ((b.right - b.left) * (b.base - b.top));
    };
    for (const [k, result] of small.entries()) {
      // The raking-light hatch fits a ring in a course two or three millimetres tall and leaves the face paper (a tenth of
      // the print's field or less); ruled, the shaded sides carry about the print's.
      expect(field(result) / field(print), `${fits[k]} near field`).toBeGreaterThan(0.5);
      // The outlines are trimmed (kit/slabs.ts' `SlabTrim`): untrimmed, the back edges and sliver faces crowd 45-47% of the far
      // vessel's outline and a third of its reflection; trimmed, 12-19% and a tenth or less.
      const report = probe(result);
      const share = (id: string) => report.parts.find(part => part.id === id)?.share ?? 0;
      expect(share('far-carbon'), `${fits[k]} far outline`).toBeLessThan(0.3);
      expect(share('reflect-carbon'), `${fits[k]} reflection`).toBeLessThan(0.2);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky and water
    // rulings, the shore's beach, the vessels' hatch and the helix's laminations shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'water-carbon', 'shore-carbon', 'near-carbon', 'helix-violet']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
