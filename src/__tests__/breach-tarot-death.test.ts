import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { SINGULARITY, unrenderEdge, unrenderHatch } from '../../sketches/breach-tarot/xiii-death/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xiii-death/sketch.ts');
const PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const len = (paths: { x: number; y: number }[][]) => paths.reduce((t, p) => t + p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0), 0);

describe('Breach Tarot: XIII Death', () => {
  it('replays, keeps every path finite and inside the card, and carries frame, threshold and phrase', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    expect(first.stats.pathCount).toBeLessThanOrEqual(8000);
    for (const pen of PENS) expect(first.parts.some(p => p.pen === pen && p.paths.length > 0)).toBe(true);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    expect(first.parts.find(p => p.id === 'threshold-carbon')!.paths[0][0].y).toBeCloseTo(HORIZON_Y, 6);
    expect(first.parts.find(p => p.id === 'card-frame')!.paths.length).toBeGreaterThan(10);
    expect(first.parts.some(p => p.id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('converges on the singularity: the drawing thins toward the point and is empty at it', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const system = result.parts.filter(p => p.id.startsWith('system-')).flatMap(p => p.paths);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y);
    const ink = (lo: number, hi: number) => len(system.flatMap(path => path.every(p => r(p) >= lo && r(p) < hi) ? [path] : []));
    // Ink per unit area falls toward the point, and nothing of the system reaches the void.
    const area = (lo: number, hi: number) => Math.PI * (hi * hi - lo * lo);
    expect(ink(20, 40) / area(20, 40)).toBeLessThan(ink(90, 130) / area(90, 130));
    // Nothing of the system crosses into the event horizon.
    const core = 6 + 14 * 0.5;
    // (The default helix stands in front of everything, so it alone may cross the disc.)
    expect(result.parts.filter(p => !/^(singularity|threshold|helix)/.test(p.id)).some(p => p.paths.some(path => path.some(q => r(q) < core)))).toBe(false);
    expect(result.parts.find(p => p.id === 'singularity-carbon')!.paths.length).toBeGreaterThan(30);
  }, 30_000);

  it('undoes edges with closeness to the point and keeps hatch only at the periphery', () => {
    const u = { core: 3, void: 5, dots: 18, dashes: 38, edges: 72 };
    const at = (d: number) => [{ x: SINGULARITY.x - 50, y: SINGULARITY.y - d }, { x: SINGULARITY.x + 50, y: SINGULARITY.y - d }];
    expect(len(unrenderEdge(at(45), u))).toBeCloseTo(100, 3);
    const near = len(unrenderEdge(at(10), u));
    expect(near).toBeGreaterThan(5);
    expect(near).toBeLessThan(80);
    expect(len(unrenderHatch(at(80), u))).toBeCloseTo(100, 3);
    expect(len(unrenderHatch(at(10), u))).toBeLessThan(len(unrenderHatch(at(60), u)));
  });

  it('offers three helix readings: bent with the world, whole in front, torn at the ends', async () => {
    const render = (helixMode: string) => renderSketch({ entry, seed: 1, params: { helixMode } } as never);
    const [world, apart, torn] = await Promise.all(['world', 'apart', 'torn'].map(render));
    const helix = (r: typeof world) => r.parts.filter(p => p.id.startsWith('helix-')).flatMap(p => p.paths);
    const disc = (r: typeof world) => len(r.parts.find(p => p.id === 'singularity-carbon')!.paths);
    // Whole and in front: the most helix ink, and it covers part of the event horizon.
    expect(len(helix(apart))).toBeGreaterThan(len(helix(world)));
    expect(len(helix(apart))).toBeGreaterThan(len(helix(torn)));
    expect(disc(apart)).toBeLessThan(disc(world));
    expect(new Set([world.identity, apart.identity, torn.identity]).size).toBe(3);
  }, 60_000);
});

describe('Breach Tarot: XIII Death at 70 x 120 mm', () => {
  type P = { x: number; y: number };
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit and params, shared.
  const renders = new Map<string, Promise<RenderResult>>();
  const rendered = (fit: Fit, params: Record<string, unknown> = {}) => {
    const key = `${fit} ${JSON.stringify(params)}`;
    if (!renders.has(key)) renders.set(key, renderSketch({ entry, seed: 1, params, finishing: { page }, format: { fit }, timeoutMs: 120_000 } as never));
    return renders.get(key)!;
  };
  let printed: Promise<RenderResult> | undefined;
  const print = () => printed ??= renderSketch({ entry, seed: 1, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  // The singularity: on the card's centre line, on the horizon (where the threshold rule runs).
  const centreOf = (fit: Fit): P => ({ x: page.width / 2, y: formatOf(fit).horizonY });
  const from = (c: P) => (p: P) => Math.hypot(p.x - c.x, p.y - c.y);
  /** The disc's rim and the halo ring, measured on the render: the ring is the singularity's outermost mark, the rim the next one in. */
  const marks = (result: RenderResult, fit: Fit) => {
    const r = from(centreOf(fit));
    const radii = points(result, 'singularity-').map(r).sort((a, b) => a - b);
    const ring = radii.at(-1)!;
    return { ring, rim: Math.max(...radii.filter(x => x < ring - 0.2)) };
  };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the nave, the infall, the torn column', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-death-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { column, infall, nave, worldCamera } from ${JSON.stringify(resolve('sketches/breach-tarot/xiii-death/geometry.ts'))};
      export default { name: 'death-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'fov', label: 'Field of view', default: 64, min: 40, max: 90, step: 1 },
          { type: 'slider', id: 'infall', label: 'Fragments falling in', default: 0.5, min: 0, max: 1, step: 0.01 },
        ],
        draw(ctx) {
          const world = worldCamera(ctx), h = createHash('sha256');
          const slab = s => [s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, s.tone, ';'].join(',');
          const walls = nave(ctx), fragments = infall(ctx, world), torn = column(ctx, world, 'torn');
          for (const s of walls) h.update(slab(s));
          for (const s of fragments) h.update(slab(s));
          for (const s of torn) h.update([s.id, s.x, s.y, s.z, s.y0, s.y1, s.radius, s.width, ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + walls.length / 100, y: 20 + fragments.length / 10 }, { x: 20 + Math.abs(torn[0].x), y: 20 }]] }];
        } };`);
    for (const params of [{}, { fov: 80, infall: 1 }] as Record<string, number>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      // Not vacuous: a nave of hundreds of slabs, a seeded infall, a torn column set off the centre line.
      const counts = tabloid.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 1);
      expect(counts[1].y).toBeGreaterThan(20 + 2);
      expect(counts[2].x).toBeGreaterThan(20 + 1);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(tabloid.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 240_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([rendered(fit), renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 })]);
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
      // Paths wholly inside the art window, per part of the scene: the nave, the helix, the disc and its ring, the horizon rule.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'system-': 1000, 'helix-': 100, 'singularity-': 15, 'threshold-': 3 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 240_000);

  it('still reads as Death: the nave thinning toward a singularity on the horizon, the disc solid, the helix coming down onto its top edge', async () => {
    const tabloid = await print();
    const at = from(SINGULARITY);
    const tone = (result: RenderResult, r: (p: P) => number, lo: number, hi: number) =>
      len(paths(result, 'system-').filter(path => path.every(p => r(p) >= lo && r(p) < hi))) / (Math.PI * (hi * hi - lo * lo));
    for (const fit of fits) {
      const result = await rendered(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = centreOf(fit), r = from(centre);
      // The broken horizon rule runs on the horizon, either side of the point.
      const rule = paths(result, 'threshold-');
      expect(rule.length).toBe(4);
      expect(Math.min(...rule.map(path => path[0].y))).toBeCloseTo(horizonY, 2);
      expect(rule.filter(path => path.every(p => p.x < centre.x)).length).toBe(2);
      // The pull thins the nave toward the point, at the print's radii scaled with the card; out at the edges it keeps the
      // print's tone (its hatch pitch held on paper), not a tone scaled down with the card.
      expect(tone(result, r, 20 * s, 40 * s)).toBeLessThan(0.6 * tone(result, r, 90 * s, 130 * s));
      expect(tone(result, r, 90 * s, 130 * s)).toBeGreaterThan(0.7 * tone(tabloid, at, 90, 130));
      // Nothing of the system crosses into the event horizon; the disc is drawn.
      const { rim } = marks(result, fit);
      expect(result.parts.filter(part => !/^(singularity|threshold|helix)/.test(part.id)).some(part => part.paths.some(path => path.some(q => r(q) < rim)))).toBe(false);
      expect(paths(result, 'singularity-').length).toBeGreaterThan(15);
      // The helix stands on the line through the point and rises far up the sky, inside the window; its foot comes
      // down over the top of the disc (enveloping its top edge), hardly below it.
      const helix = points(result, 'helix-');
      expect(Math.abs(helix.reduce((sum, p) => sum + p.x, 0) / helix.length - centre.x)).toBeLessThan(2);
      expect(horizonY - Math.min(...helix.map(p => p.y))).toBeGreaterThan(0.6 * (horizonY - card.y0));
      expect(Math.min(...helix.map(p => p.y))).toBeGreaterThanOrEqual(card.y0 - 0.01);
      const over = helix.filter(p => r(p) < rim && p.y < centre.y).length, under = helix.filter(p => r(p) < rim && p.y > centre.y).length;
      expect(over).toBeGreaterThan(40);
      expect(under).toBeLessThan(over / 5);
    }
  }, 240_000);

  it('keeps its halos scaled with the card, never under the floor: paper round the disc, the horizon broken short of the ring, the ghost image off the rim', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      const centre = centreOf(fit), r = from(centre);
      const { ring, rim } = marks(result, fit);
      // The Einstein halo: 3 + 6 × lensing (6 mm at the default) of paper between the disc and its ring on the print.
      expect(ring - rim, `${fit} halo`).toBeGreaterThanOrEqual(0.5);
      expect(ring - rim, `${fit} halo`).toBeLessThan(6 * s + 0.05);
      // The horizon rule stops 2 mm short of the ring on the print.
      const gap = Math.min(...paths(result, 'threshold-').flat().map(p => Math.abs(p.x - centre.x))) - ring;
      expect(gap, `${fit} rule`).toBeGreaterThan(0.49);
      expect(gap, `${fit} rule`).toBeLessThan(Math.max(0.5, 2 * s) + 0.05);
      // The faint secondary image keeps 0.6 mm off the disc on the print; its nearest dashes come right up to that halo.
      const ghost = Math.min(...points(result, 'system-').map(r)) - rim;
      expect(ghost, `${fit} ghost`).toBeGreaterThan(0.49);
      expect(ghost, `${fit} ghost`).toBeLessThan(Math.max(0.5, 0.6 * s) + 0.06);
    }
  }, 240_000);

  it('comes undone as calmly as the print: no more dashes and dots per square centimetre round the disc than the print draws', async () => {
    const tabloid = await print();
    // Marks of the nave wholly inside a ring band, per square centimetre.
    const perCm2 = (result: RenderResult, r: (p: P) => number, lo: number, hi: number) =>
      100 * paths(result, 'system-').filter(path => path.every(p => r(p) >= lo && r(p) < hi)).length / (Math.PI * (hi * hi - lo * lo));
    // The print's registers at the defaults: the halo ring at 13 + 3 + 3 mm, dots out to 16 mm beyond it, dashes to 36.
    const printed = { dots: perCm2(tabloid, from(SINGULARITY), 19, 35), dashes: perCm2(tabloid, from(SINGULARITY), 35, 55) };
    expect(printed.dashes).toBeGreaterThan(20);
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      const { ring } = marks(result, fit), r = from(centreOf(fit));
      // The same lines crowd into a band a quarter as wide: kept whole, their real-millimetre dashes ran twice as thick on
      // the ground as the print's (70-78 per cm², against 32) and the dots nearly three times (31, against 11).
      const dots = perCm2(result, r, ring, ring + 16 * s), dashes = perCm2(result, r, ring + 16 * s, ring + 36 * s);
      expect(dashes, `${fit} dashes`).toBeLessThan(1.2 * printed.dashes);
      expect(dots, `${fit} dots`).toBeLessThan(1.2 * printed.dots);
      // Every stage still there: dots before the void, as on the print.
      expect(dots, `${fit} dots`).toBeGreaterThan(0.3 * printed.dots);
    }
  }, 240_000);

  it('is no denser than its tabloid print, part by part, its slabs trimmed; the print shrunk onto the card is', async () => {
    const tabloid = await print();
    const master = probe(tabloid);
    for (const fit of fits) {
      const report = probe(await rendered(fit));
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // Every slab is outlined as a small card draws it (kit/slabs.ts' `slabEdges`, by hand, since `slabStrokes` has no
      // trim): untrimmed, the back edges and sliver faces doubled the nave's outlines, and 44-46% of it ran too close in
      // either fit, against the print's 34%; trimmed, 23-28%.
      const nave = report.parts.find(part => part.id === 'system-carbon')!;
      expect(nave.share, describeDensity(report)).toBeLessThan(0.36);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its hatch, its
    // disc's crossing families and the horizon's double rule shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...tabloid, parts: tabloid.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['system-carbon', 'helix-violet', 'singularity-carbon', 'threshold-carbon']) expect(denser).toContain(id);
  }, 240_000);

  it('offers the three helix readings on a small card too: bent with the world, whole in front, torn at the ends', async () => {
    const [world, apart, torn] = await Promise.all(['world', 'apart', 'torn'].map(helixMode => rendered('height', helixMode === 'apart' ? {} : { helixMode })));
    const helix = (r: RenderResult) => len(paths(r, 'helix-'));
    const disc = (r: RenderResult) => len(paths(r, 'singularity-'));
    for (const r of [world, torn]) expect(r.diagnostics).toEqual([]);
    expect(helix(apart)).toBeGreaterThan(helix(world));
    expect(helix(apart)).toBeGreaterThan(helix(torn));
    expect(disc(apart)).toBeLessThan(disc(world));
    // Torn stands off to the left of the point, where the print stands it.
    const tornX = points(torn, 'helix-').reduce((sum, p) => sum + p.x, 0) / points(torn, 'helix-').length;
    expect(tornX).toBeLessThan(page.width / 2 - 8);
    expect(new Set([world.identity, apart.identity, torn.identity]).size).toBe(3);
  }, 240_000);

  it('draws its preferred fit, the height, where the render names none', async () => {
    const [plain, height] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), rendered('height')]);
    expect(plain.parts).toEqual(height.parts);
  }, 240_000);
});
