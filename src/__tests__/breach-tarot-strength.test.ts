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

const entry = resolve('sketches/breach-tarot/viii-strength/sketch.ts');

type Parts = Awaited<ReturnType<typeof renderSketch>>['parts'];
const points = (parts: Parts, prefix: string) => parts.filter(p => p.id.startsWith(prefix)).flatMap(p => p.paths.flat());

/**
 * Where the helix's head hangs, on the sheet: the person's highest point, and the helix's lowest
 * stretch above it (within 60 mm either side). The head end is the centroid of that stretch's last
 * 6 mm, so a swelling ribbon's edge does not pull it sideways. On a smaller card those lengths are the
 * print's times the card's scale `s`.
 */
function headOverPerson(parts: Parts, s = 1) {
  const person = points(parts, 'figure-');
  const top = person.reduce((a, p) => (p.y < a.y ? p : a));
  const above = points(parts, 'helix-').filter(p => p.y < top.y - 3 * s && Math.abs(p.x - top.x) < 60 * s);
  if (!above.length) return null;
  const lowest = Math.max(...above.map(p => p.y));
  const end = above.filter(p => p.y > lowest - 6 * s);
  const x = end.reduce((a, p) => a + p.x, 0) / end.length;
  return { sideways: x - top.x, above: top.y - lowest };
}

describe('Breach Tarot: VIII Strength', () => {
  it('replays, stays inside the card, and draws the sky, the lake, the dam, the helix, the person, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'lake-carbon', 'dam-carbon', 'gorge-carbon', 'parapet-carbon', 'figure-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('hangs the helix head over whoever holds it: within 8 mm sideways of the person\'s highest point and 15 to 50 mm above it', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const head = headOverPerson(result.parts)!;
    expect(head).not.toBeNull();
    expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8);
    expect(head.above).toBeGreaterThanOrEqual(15);
    expect(head.above).toBeLessThanOrEqual(50);
  }, 60_000);

  it('draws the body-style person where the scratch figure stood: same height and place within 1 mm, the helix head still over it, the tail still ending at its hand', async () => {
    const box = (parts: Parts) => {
      const pts = points(parts, 'figure-');
      return { x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), y1: Math.max(...pts.map(p => p.y)) };
    };
    const scratch = await renderSketch({ entry, seed: 2, params: { figureStyle: 'scratch' } });
    const body = await renderSketch({ entry, seed: 2, params: { figureStyle: 'body' } });
    const a = box(scratch.parts), b = box(body.parts);
    for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(1);
    const head = headOverPerson(body.parts)!;
    expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8);
    expect(head.above).toBeGreaterThanOrEqual(15);
    expect(head.above).toBeLessThanOrEqual(50);
    // The hand is the figure's leftmost point; the helix's tail ends on it.
    const hand = points(body.parts, 'figure-').reduce((m, p) => (p.x < m.x ? p : m));
    const gap = Math.min(...points(body.parts, 'helix-').map(p => Math.hypot(p.x - hand.x, p.y - hand.y)));
    expect(gap).toBeLessThanOrEqual(1);
  }, 90_000);

  it('would notice the head moving: pushed aside, dropped onto the person, or lifted away, the measure fails', async () => {
    const aside = headOverPerson((await renderSketch({ entry, seed: 2, params: { headOffset: 30 } })).parts);
    expect(!aside || Math.abs(aside.sideways) > 8).toBe(true);
    const low = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 5 } })).parts)!;
    expect(low.above).toBeLessThan(15);
    const high = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 60 } })).parts)!;
    expect(high.above).toBeGreaterThan(50);
  }, 90_000);
});

describe('Breach Tarot: VIII Strength at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Renders are shared between the tests (they are deterministic): each fit named, since a card draws in its own
  // preferred fit where the render names none.
  const cache = new Map<string, Promise<RenderResult>>();
  const once = (key: string, run: () => Promise<RenderResult>) => { if (!cache.has(key)) cache.set(key, run()); return cache.get(key)!; };
  const render = (fit: Fit, params: Record<string, string | number> = {}) =>
    once(`${fit} ${JSON.stringify(params)}`, () => renderSketch({ entry, seed: 2, params, finishing: { page }, format: { fit }, timeoutMs: 120_000 }));
  const print = () => once('print', () => renderSketch({ entry, seed: 2, timeoutMs: 120_000 }));
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const length = (path: Point[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  /** Points every `step` mm along some paths. */
  const sampled = (ps: Point[][], step = 0.1) => ps.flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  /** The least distance from any of `from` to any of `to`. */
  const nearest = (from: Point[], to: Point[]) => {
    const grid = new Map<string, Point[]>();
    for (const q of to) { const key = `${Math.floor(q.x)},${Math.floor(q.y)}`; grid.set(key, [...(grid.get(key) ?? []), q]); }
    let least = Infinity;
    for (const p of from) for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      for (const q of grid.get(`${Math.floor(p.x) + i},${Math.floor(p.y) + j}`) ?? []) least = Math.min(least, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return least;
  };
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the dam, where the person stands and how tall, the hand, and the helix\'s course', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-strength-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { strengthWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/viii-strength/geometry.ts'))};
      export default { name: 'strength-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'coilAcross', label: 'Coil across', default: 100, min: 18, max: 261, step: 1 },
          { type: 'slider', id: 'figureAt', label: 'Person along the dam', default: 0.72, min: 0.05, max: 0.95, step: 0.01 },
        ],
        draw(ctx) {
          const w = strengthWorld(ctx), h = createHash('sha256');
          for (const s of [...w.dam.courses, ...w.dam.parapet]) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.tone, s.beat, ';'].join(','));
          h.update(w.dam.courseOf.join(','));
          for (const v of [w.stand, w.hand]) h.update([v.x, v.y, v.z, ';'].join(','));
          for (const j of w.skeleton.joints.values()) for (const v of [j.origin, j.end]) h.update([v.x, v.y, v.z, ';'].join(','));
          for (const v of w.course.curve.points) h.update([v.x, v.y, v.z, ';'].join(','));
          h.update([w.course.centre.x, w.course.centre.z, w.course.tube, w.course.topY, w.course.apexUp, w.k].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.dam.courses.length / 100, y: 20 + w.dam.parapet.length / 10 }, { x: 20 + w.course.curve.points.length / 10, y: 20 }]] }];
        } };`);
    // The default, and the coil and the person moved along the card.
    for (const params of [{}, { coilAcross: 40, figureAt: 0.4 }] as Record<string, number>[]) {
      const [printed, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = printed.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 50 / 100);
      expect(counts[1].y).toBeGreaterThan(20 + 5 / 10);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(printed.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([render(fit), renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 })]);
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
      // Paths wholly inside the art window, per part of the scene.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 20, 'lake-': 100, 'dam-': 100, 'gorge-': 20, 'parapet-': 12, 'helix-': 150, 'figure-': 10, 'horizon-': 1 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = paths(first, 'card-phrase').flat();
      expect(phrase.length).toBeGreaterThan(40);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as Strength: the lake under the sky, the dam across the foot, the coil on the water left of the person on its crest, the neck up into the sky and its head hanging over the person, the tail ending in the open hand', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const helix = paths(result, 'helix-').flat(), person = paths(result, 'figure-').flat(), dam = paths(result, 'dam-').flat();
      // The sky ruled above the horizon, the lake below it; the dam below the horizon, across the window.
      expect(Math.max(...paths(result, 'sky-').flat().map(p => p.y))).toBeLessThan(horizonY);
      expect(Math.min(...paths(result, 'lake-').flat().map(p => p.y))).toBeGreaterThan(horizonY);
      const wall = box(dam);
      expect(wall.y0).toBeGreaterThan(horizonY);
      expect((wall.x1 - wall.x0) / (card.x1 - card.x0)).toBeGreaterThan(0.85);
      // The person stands right of centre, below the horizon, in the window.
      const body = box(person);
      expect((body.x0 + body.x1) / 2).toBeGreaterThan(centre);
      expect(body.y0).toBeGreaterThan(horizonY);
      expect(body.y1).toBeLessThan(card.y1);
      // The coil lies on the water left of the person; the neck rises from it well up into the sky.
      const coil = helix.filter(p => p.y > horizonY);
      expect(coil.reduce((sum, p) => sum + p.x, 0) / coil.length).toBeLessThan(body.x0);
      expect(Math.min(...helix.map(p => p.y))).toBeLessThan(horizonY - 0.3 * (horizonY - card.y0));
      // The head hangs over the person as on the print, its distances scaled with the card: within 8 mm of the print sideways
      // of the person's highest point, 15 to 50 mm above it.
      const head = headOverPerson(result.parts, s)!;
      expect(head).not.toBeNull();
      expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8 * s);
      expect(head.above).toBeGreaterThanOrEqual(15 * s);
      expect(head.above).toBeLessThanOrEqual(50 * s);
      // The hand is the person's leftmost point; the tail ends on it (within the print's millimetre, scaled).
      const hand = person.reduce((m, p) => (p.x < m.x ? p : m));
      expect(Math.min(...helix.map(p => Math.hypot(p.x - hand.x, p.y - hand.y)))).toBeLessThanOrEqual(s);
    }
  }, 120_000);

  it('keeps the body-style person fitted to the scratch figure\'s box on a small card, the head over it and the tail in its hand', async () => {
    for (const fit of fits) {
      const [scratch, body] = await Promise.all([render(fit, { figureStyle: 'scratch' }), render(fit)]);
      const { s } = formatOf(fit);
      // Within the print's millimetre, scaled with the card.
      const a = box(paths(scratch, 'figure-').flat()), b = box(paths(body, 'figure-').flat());
      for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(s);
      for (const result of [scratch, body]) {
        const head = headOverPerson(result.parts, s)!;
        expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8 * s);
        expect(head.above).toBeGreaterThanOrEqual(15 * s);
      }
    }
  }, 120_000);

  it('draws the helix by its strands\' lines on a small card, twining unbroken, and the person by its outline', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      // Each ribbon is narrower on paper than the smallest feature: strand a is its acid spine, strand b the line down its
      // middle in its vermilion, and no lamination, rib or pulse is left.
      expect(result.parts.filter(part => part.id.startsWith('helix-')).map(part => part.pen).sort()).toEqual(['acid', 'vermilion']);
      // The lines run their whole length but where one strand passes behind the other or the coil: tested against the
      // coarse surfaces with the print's slack alone, they printed as dashes, a third shorter (about 1,100 of the print's
      // millimetres, to some 1,600 now).
      const total = paths(result, 'helix-').reduce((sum, path) => sum + length(path), 0);
      expect(total / s).toBeGreaterThan(1400);
      // The parapet runs along the crest: with the card's own depth raster (no finer pass) its top was lost to the faces
      // before it, and only some 70 mm of it was left.
      expect(paths(result, 'parapet-').reduce((sum, path) => sum + length(path), 0)).toBeGreaterThan(90);
      // A person a few millimetres tall is its outline and a band or two, no two of its lines closer than the pens hold
      // apart (unthinned, a fifth of it ran closer; with the print's bands too, over half).
      const person = probe(result).parts.find(part => part.id === 'figure-carbon')!;
      expect(person.share, describeDensity(probe(result))).toBeLessThan(0.1);
    }
  }, 120_000);

  it('lays the coil on the water as one heavy mass, its turns banded by their outline, not a tangle of loops', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { horizonY } = formatOf(fit);
      const person = box(paths(result, 'figure-').flat());
      // The coil's lines: the helix's paths wholly on the water, left of the person (the tail's last stretch excluded).
      const coil = paths(result, 'helix-').filter(path => path.every(p => p.y > horizonY && p.x < person.x0 - 3));
      const whole = box(coil.flat());
      const longest = Math.max(...coil.map(path => { const b = box(path); return b.x1 - b.x0; }));
      // A turn's outline runs on under the coil, its longest line over half the coil's width; drawn by its twining strands
      // alone, far halves showing through, its longest line was a loop of a tenth of it.
      expect(longest / (whole.x1 - whole.x0)).toBeGreaterThan(0.4);
    }
  }, 120_000);

  it('keeps its halos at the card\'s scale, never under the floor: the lake\'s knockout round the helix and the sky\'s clearing round the neck', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      const helix = sampled(paths(result, 'helix-'));
      // The knockout (1.1 mm on the print) scales under the 0.5 mm floor: no lake line comes nearer than the floor less a
      // mask cell and a step, and some come nearer than the print's knockout would let them.
      const lake = nearest(sampled(paths(result, 'lake-')), helix);
      expect(lake).toBeGreaterThan(0.3);
      expect(lake).toBeLessThan(0.8);
      // The clearing (2.6 mm on the print) is the card's scale of it, over the floor: the sky's rules stop that far from the
      // neck, not the print's distance.
      const sky = nearest(sampled(paths(result, 'sky-')), helix);
      expect(sky).toBeGreaterThan(2.6 * s - 0.2);
      expect(sky).toBeLessThan(1.5);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [printed, ...small] = await Promise.all([print(), ...fits.map(fit => render(fit))]);
    const master = probe(printed);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its rulings, the
    // dam's hatch and the gorge's rules shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...printed, parts: printed.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'lake-carbon', 'dam-carbon', 'dam-ultramarine', 'gorge-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
