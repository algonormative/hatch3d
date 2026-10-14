import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/ix-hermit/sketch.ts');

type Pt = { x: number; y: number };
type PartLike = { id: string; pen: string; paths: Pt[][] };
const paths = (parts: PartLike[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Points along every path, a quarter millimetre apart, so a long ruling stroke counts where it passes and not only at its ends. */
const sampled = (list: Pt[][]): Pt[] => list.flatMap(path => path.slice(1).flatMap((p, i) => {
  const a = path[i], k = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 0.25));
  return Array.from({ length: k + 1 }, (_, j) => ({ x: a.x + (p.x - a.x) * j / k, y: a.y + (p.y - a.y) * j / k }));
}));
/** The middle of the helix: the middle of the box round everything it draws. */
const helixCentre = (parts: PartLike[]): Pt => {
  const pts = parts.filter(p => p.id.startsWith('helix-')).flatMap(p => p.paths.flat());
  return { x: (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2, y: (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2 };
};
/** The night ruling: the sky's rules and the rules that follow the mountain's slope. */
const night = (parts: PartLike[]): Pt[] => sampled([...paths(parts, 'night-carbon'), ...paths(parts, 'slope-carbon')]);
const within = (pts: Pt[], c: Pt, r: number) => pts.filter(p => Math.hypot(p.x - c.x, p.y - c.y) < r);

describe('Breach Tarot: IX The Hermit', () => {
  it('replays, stays inside the card, and draws the night, the mountain, the hermit, the lantern, the helix, the network, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['night-carbon', 'slope-carbon', 'ground-carbon', 'peak-carbon', 'figure-carbon', 'lantern-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('has no light but the lantern\'s: no night ruling lies in its clear core, and the helix\'s inks are the only ones besides carbon and the lettering', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const meta = await inspectSketch({ entry });
    const lit = meta.controls.find(c => c.id === 'lit');
    expect(lit?.type).toBe('slider');
    const core = (lit as { default: number }).default;
    // The core is a real one (the lantern and the helix inside it fit in 8 mm); lowering the control is the mutation this catches.
    expect(core).toBeGreaterThanOrEqual(8);
    const centre = helixCentre(result.parts);
    // The clear core: nothing of the night's ruling inside it. A millimetre or two of margin for the helix's box being
    // only close to its middle.
    const ruling = night(result.parts);
    expect(ruling.length).toBeGreaterThan(100_000);
    expect(within(ruling, centre, core - 2).length).toBe(0);
    // And the night is really there round the core: ruling in the ring just past the light and plenty of it in the open sky.
    expect(within(ruling, centre, core + 40).length).toBeGreaterThan(200);
    expect(within(ruling, { x: CARD.x0 + 40, y: CARD.y0 + 40 }, 30).length).toBeGreaterThan(500);
    // The ink: every part is carbon or lettering, except the helix, which draws in its own inks and nothing else does.
    const helix = result.parts.filter(p => p.id.startsWith('helix-'));
    expect(helix.length).toBeGreaterThanOrEqual(3);
    for (const part of helix) {
      expect(part.id).toBe(`helix-${part.pen}`);
      expect(['ultramarine', 'vermilion', 'acid', 'violet']).toContain(part.pen);
    }
    for (const part of result.parts.filter(p => !p.id.startsWith('helix-'))) expect(['carbon', 'lettering']).toContain(part.pen);
  }, 60_000);

  it('would fail without its core: with no clear core the ruling runs through the lantern', async () => {
    const result = await renderSketch({ entry, seed: 1, params: { lit: 0 } });
    const centre = helixCentre(result.parts);
    expect(within(night(result.parts), centre, 8).length).toBeGreaterThan(50);
  }, 60_000);
});

describe('Breach Tarot: IX The Hermit at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  const timeoutMs = 120_000;
  const print = () => renderSketch({ entry, seed: 1, timeoutMs });
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const parts = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix));
  const points = (result: RenderResult, prefix: string) => parts(result, prefix).flatMap(part => part.paths.flat());
  const box = (ps: Pt[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const mean = (ps: Pt[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
  const length = (path: Pt[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  /** The nearest distance from any of `from` to any of `to`, through a grid of `to` (millimetre cells). */
  const nearest = (from: Pt[], to: Pt[]) => {
    const grid = new Map<string, Pt[]>();
    for (const q of to) { const key = `${Math.floor(q.x)},${Math.floor(q.y)}`; grid.set(key, [...(grid.get(key) ?? []), q]); }
    return from.map(p => {
      let best = Infinity;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const q of grid.get(`${Math.floor(p.x) + i},${Math.floor(p.y) + j}`) ?? []) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      return best;
    });
  };
  /**
   * The city's lit points, as the holes they cut: in each ruled row of the plain, the gaps between its pieces narrower
   * than the widest dot (wider ones are what stands in front). Their y, and the share of the rows' length they take in a
   * band below the horizon, `from` to `to` tabloid millimetres (`s` the card's scale).
   */
  const lit = (result: RenderResult, horizonY: number, s: number) => {
    const rows = new Map<number, [number, number][]>();
    for (const path of parts(result, 'ground-').flatMap(part => part.paths)) {
      if (Math.abs(path[0].y - path.at(-1)!.y) > 1e-6) continue;
      const y = Math.round(path[0].y * 1e4) / 1e4, xs = path.map(p => p.x);
      rows.set(y, [...(rows.get(y) ?? []), [Math.min(...xs), Math.max(...xs)]]);
    }
    const holes: { y: number; width: number }[] = [];
    const ink = new Map<number, number>();
    for (const [y, spans] of rows) {
      spans.sort((a, b) => a[0] - b[0]);
      ink.set(y, spans.reduce((sum, [a, b]) => sum + b - a, 0));
      for (let i = 1; i < spans.length; i++) { const gap = spans[i][0] - spans[i - 1][1]; if (gap > 0 && gap < 2.6) holes.push({ y, width: gap }); }
    }
    const share = (from: number, to: number) => {
      const inBand = (y: number) => (y - horizonY) / s >= from && (y - horizonY) / s < to;
      const open = holes.filter(h => inBand(h.y)).reduce((sum, h) => sum + h.width, 0);
      const drawn = [...ink].filter(([y]) => inBand(y)).reduce((sum, [, v]) => sum + v, 0);
      return open / (open + drawn);
    };
    return { holes, share };
  };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the mountain, where the hermit stands and how, his lantern, his body and cloak, and the city\'s lit points', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-hermit-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { hermitWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/ix-hermit/geometry.ts'))};
      import { buildLantern, hermitFigure, lanternHand } from ${JSON.stringify(resolve('sketches/breach-tarot/ix-hermit/hermit.ts'))};
      import { hermitCamera } from ${JSON.stringify(resolve('sketches/breach-tarot/ix-hermit/peak.ts'))};
      export default { name: 'hermit-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 40, max: 75, step: 1 },
          { type: 'slider', id: 'summitX', label: 'Summit across', default: 192, min: 120, max: 235, step: 1 },
          { type: 'slider', id: 'gridBelt', label: 'Lit belt', default: 46, min: 20, max: 100, step: 1 },
        ],
        draw(ctx) {
          const w = hermitWorld(ctx), h = createHash('sha256'), v = p => h.update([p.x, p.y, p.z, ';'].join(','));
          for (const s of w.peak.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, ';'].join(','));
          for (const p of [w.peak.summit, w.peak.along, w.peak.across, w.stand]) v(p);
          h.update(String(w.figH));
          for (const name of w.skeleton.joints.keys()) { v(w.skeleton.at(name)); v(w.skeleton.at(name, true)); }
          for (const q of w.lights) h.update([q.x, q.y, q.hx, q.hy, q.index, ';'].join(','));
          const view = hermitCamera(ctx);
          const lantern = buildLantern(ctx, view, w.sc, lanternHand(w.skeleton));
          v(lantern.centre);
          for (const s of lantern.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, ';'].join(','));
          for (const line of lantern.lines) for (const p of line) v(p);
          const figure = hermitFigure(ctx, view, w.skeleton, lantern.centre, w.stand);
          for (const g of figure.meshes) { h.update(new Float64Array(g.getAttribute('position').array)); g.dispose(); }
          for (const g of lantern.meshes) g.dispose();
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.peak.slabs.length / 10, y: 20 + w.lights.length / 100 }, { x: 20 + figure.meshes.length, y: 20 }]] }];
        } };`);
    // The default, and a wider lens, a summit nearer the middle and a deeper lit belt (the lens widens again in fit width).
    for (const params of [{}, { fov: 62, summitX: 150, gridBelt: 70 }] as Record<string, number>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params, timeoutMs }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}), timeoutMs })),
      ]);
      const counts = tabloid.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 100 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 300 / 100);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(tabloid.parts.find(part => part.id === id)!.paths);
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
      // Paths wholly inside the art window, per part of the scene: the night, the ruling on the slope, the plain, the slabs,
      // the hermit, the lantern, the helix, the horizon.
      const inWindow = (prefix: string) => parts(first, prefix).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'night-': 60, 'slope-': 25, 'ground-': 35, 'peak-': 120, 'figure-': 25, 'lantern-': 6, 'helix-': 4, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Hermit: on the summit far above the eye line he holds his lantern up beside him, the stair falls away to the left to a foot just under the horizon, the night above and the lit city below', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const figure = box(points(result, 'figure-')), peak = points(result, 'peak-'), helix = box(points(result, 'helix-'));
      const lamp = { x: (helix.x0 + helix.x1) / 2, y: (helix.y0 + helix.y1) / 2 };
      // He stands on the summit, right of the middle, his feet far above the eye line: the highest stone is under his feet.
      expect(figure.y1).toBeLessThan(horizonY - 0.4 * (horizonY - card.y0));
      expect(Math.abs(box(peak).y0 - figure.y1)).toBeLessThan(1.5);
      expect(mean(points(result, 'figure-'), 'x')).toBeGreaterThan((card.x0 + card.x1) / 2);
      // The lantern is held up beside him, out to the left he looks to, in the upper half of his height.
      expect(lamp.x).toBeLessThan(mean(points(result, 'figure-'), 'x'));
      expect(lamp.y).toBeLessThan(figure.y0 + 0.55 * (figure.y1 - figure.y0));
      // The stair falls away from the summit to the left, and the ruling on its slope comes down to just under the horizon.
      const peakBox = box(peak), third = (peakBox.x1 - peakBox.x0) / 3;
      expect(mean(peak.filter(p => p.x < peakBox.x0 + third), 'y') - mean(peak.filter(p => p.x > peakBox.x1 - third), 'y')).toBeGreaterThan(3);
      expect(peakBox.x0).toBeLessThan(figure.x0 - 15);
      const slope = box(points(result, 'slope-'));
      expect(slope.y1).toBeGreaterThan(horizonY);
      expect(slope.y1).toBeLessThan(horizonY + 6);
      // The night above the horizon, the plain below it; the city's lights all in the belt along the horizon.
      expect(box(points(result, 'night-')).y1).toBeLessThan(horizonY);
      expect(box(points(result, 'ground-')).y0).toBeGreaterThan(horizonY);
      const { holes } = lit(result, horizonY, s);
      expect(holes.length).toBeGreaterThan(10);
      expect(Math.max(...holes.map(h => h.y))).toBeLessThan(horizonY + s * 46 + 2);
    }
  }, 120_000);

  it('has no light but the lantern\'s on a small card too: a clear core round it the size of the print\'s scaled, the pool spilling down, and only the helix in colour', async () => {
    const [printed, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const above = (result: RenderResult) => {
      const centre = helixCentre(result.parts), rules = night(result.parts);
      const up = rules.filter(p => Math.abs(p.x - centre.x) < 1 && p.y < centre.y).map(p => centre.y - p.y);
      const down = rules.filter(p => Math.abs(p.x - centre.x) < 1 && p.y > centre.y).map(p => p.y - centre.y);
      return { centre, rules, up: Math.min(...up), down: Math.min(...down) };
    };
    const tabloid = above(printed);
    for (const [k, result] of small.entries()) {
      const { s } = formatOf(fits[k]);
      const { centre, rules, up, down } = above(result);
      // The core, 10 mm on the print, is the card's scale of it: no ruling inside it, and ruling a few millimetres off,
      // where on the print (and on a card that left it at the print's size) there is none.
      expect(within(rules, centre, 0.9 * 10 * s).length).toBe(0);
      expect(within(rules, centre, 6).length).toBeGreaterThan(50);
      // The clear stretch straight above the lamp is the print's, scaled; the pool reaches farther down, onto the stones.
      expect(up / (s * tabloid.up)).toBeGreaterThan(0.7);
      expect(up / (s * tabloid.up)).toBeLessThan(1.4);
      expect(down).toBeGreaterThan(1.5 * up);
      // The ink: every part is carbon or lettering, except the helix, which draws in its own inks and nothing else does.
      const helix = parts(result, 'helix-');
      expect(helix.length).toBeGreaterThanOrEqual(2);
      for (const part of helix) {
        expect(part.id).toBe(`helix-${part.pen}`);
        expect(['ultramarine', 'vermilion', 'acid', 'violet']).toContain(part.pen);
      }
      for (const part of result.parts.filter(p => !p.id.startsWith('helix-'))) expect(['carbon', 'lettering']).toContain(part.pen);
    }
  }, 120_000);

  it('keeps its halos at the card\'s scale, never under the floor: the night\'s knockout round all that stands, and the pocket of paper round the hermit', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const figure = sampled([...paths(result.parts, 'figure-carbon'), ...paths(result.parts, 'lantern-carbon')]);
      const rules = sampled(paths(result.parts, 'night-carbon'));
      const fromPeak = nearest(rules, sampled(paths(result.parts, 'peak-carbon'))), fromFigure = nearest(rules, figure);
      // The knockout, 0.8 mm on the print, is the card's scale of it, which is under the 0.5 mm floor: no rule comes nearer
      // the slabs or the hermit than the floor less a coverage pixel, and many come nearer than the print's 0.8.
      expect(Math.min(...fromPeak)).toBeGreaterThan(0.3);
      expect(Math.min(...fromFigure)).toBeGreaterThan(0.35);
      expect(fromPeak.filter(d => d < 0.65).length).toBeGreaterThan(5);
      expect(fromFigure.filter(d => d < 1).length).toBeGreaterThan(20);
      // The pocket, 1.3 mm on the print, keeps the stones and the slope's ruling off the hermit and his lantern: by its floor,
      // and not by the print's 1.3 mm.
      const stones = nearest(sampled([...paths(result.parts, 'peak-carbon'), ...paths(result.parts, 'slope-carbon')]), figure);
      expect(Math.min(...stones)).toBeGreaterThan(0.52);
      expect(stones.filter(d => d < 1).length).toBeGreaterThan(4);
    }
  }, 120_000);

  it('keeps the print\'s tones: the night\'s pitch on paper, the summit\'s outlines whole, and the city\'s lights as bright as the print\'s', async () => {
    const [printed, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const printLit = lit(printed, CARD.y0 + 0.6 * (CARD.y1 - CARD.y0), 1).share(10, 46);
    expect(printLit).toBeGreaterThan(0.05);
    for (const [k, result] of small.entries()) {
      const { horizonY, s } = formatOf(fits[k]);
      // The night's rules keep the print's 0.65 mm on paper (scaled with the card they would run under 0.2 mm apart).
      const ys = [...new Set(paths(result.parts, 'night-carbon').filter(path => Math.abs(path[0].y - path.at(-1)!.y) < 1e-6).map(path => Math.round(path[0].y * 1e3) / 1e3))].sort((a, b) => a - b);
      const steps = ys.slice(1).map((y, i) => y - ys[i]);
      expect(Math.min(...steps)).toBeGreaterThan(0.6);
      expect(steps.filter(d => d < 0.7).length).toBeGreaterThan(30);
      // The summit's slabs are trimmed to their outlines (kit/slabs.ts), which keeps them whole where the print draws every
      // edge, near the lamp: untrimmed, their back edges' scraps rank ahead of the front edges and thin them out.
      const centre = helixCentre(result.parts);
      const near = paths(result.parts, 'peak-carbon').filter(path => path.every(p => Math.hypot(p.x - centre.x, p.y - centre.y) < (36.8 + 6) * s));
      expect(near.reduce((sum, path) => sum + length(path), 0) / s).toBeGreaterThan(115);
      // The lit points keep their size on paper and thin to keep the print's light in the belt along the horizon: the holes'
      // share of the rows there, against the print's (by the window's area alone it fell under three quarters).
      const share = lit(result, horizonY, s).share(10, 46) / printLit;
      expect(share).toBeGreaterThan(0.8);
      expect(share).toBeLessThan(1.5);
    }
  }, 120_000);

  it('reads the city as the print\'s band at the card\'s size: many small lights, packed into the rules below the horizon and thinning toward the eye at least as fast as the print\'s', async () => {
    const [printed, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const printLit = lit(printed, CARD.y0 + 0.6 * (CARD.y1 - CARD.y0), 1);
    const printPack = printLit.share(10, 20) / printLit.share(20, 46);
    for (const [k, result] of small.entries()) {
      const { horizonY, s } = formatOf(fits[k]);
      const { holes, share } = lit(result, horizonY, s);
      const widths = holes.map(h => h.width).sort((a, b) => a - b);
      // Notches in single rules, narrower than the print's dots (1.1 mm and up), and many of them; with the print's dots kept
      // at their size, a few dozen cut two or three rules each and the band read as a scatter of separate lights.
      expect(holes.length, fits[k]).toBeGreaterThan(70);
      expect(widths[widths.length >> 1], fits[k]).toBeLessThan(1.1);
      // Their light gathers in the first rows below the mountain's foot, falling off across the belt as fast as the print's.
      expect(share(10, 20) / share(20, 46), fits[k]).toBeGreaterThan(printPack);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [printed, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const master = probe(printed);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThanOrEqual(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its night, slope and
    // plain rulings, the hermit's cloak and the lantern shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...printed, parts: printed.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['night-carbon', 'slope-carbon', 'ground-carbon', 'figure-carbon', 'lantern-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, height, where the render names none', async () => {
    const [plain, height] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs }), render('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(height.parts);
  }, 120_000);
});
