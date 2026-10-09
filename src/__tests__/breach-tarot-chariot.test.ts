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

const entry = resolve('sketches/breach-tarot/vii-chariot/sketch.ts');

describe('Breach Tarot: VII The Chariot', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the trails, the road, the unbuilt road, both forces, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'shadow-carbon', 'trail-carbon', 'road-carbon', 'unbuilt-carbon', 'pale-carbon', 'dark-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('leaves the ground and is still being built: the helix rides high in the sky, and dashed unbuilt road runs on above the front edge', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));
    // The chariot is up on the ramp, not down on the ground.
    expect(HORIZON_Y - Math.min(...ys(id => id.startsWith('helix-')))).toBeGreaterThanOrEqual(60);
    // The built road's front edge is its highest point; the road it is meant to become goes on above it, dashed.
    const front = Math.min(...ys(id => id === 'road-carbon'));
    const unbuilt = result.parts.find(p => p.id === 'unbuilt-carbon')!.paths;
    const lengths = unbuilt.map(path => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0)).sort((a, b) => a - b);
    expect(lengths[Math.floor(lengths.length / 2)]).toBeLessThan(3);
    const above = unbuilt.filter(path => Math.max(...path.map(q => q.y)) < front - 5);
    expect(above.length).toBeGreaterThanOrEqual(40);
    expect(front - Math.min(...above.flat().map(q => q.y))).toBeGreaterThanOrEqual(40);
  }, 60_000);
});

describe('Breach Tarot: VII The Chariot at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, shared.
  const renders = new Map<Fit, Promise<RenderResult>>();
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const rendered = (fit: Fit) => { if (!renders.has(fit)) renders.set(fit, render(fit)); return renders.get(fit)!; };
  const print = () => renderSketch({ entry, seed: 2, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const length = (path: Point[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const drawn = (result: RenderResult, prefix: string) => paths(result, prefix).reduce((sum, path) => sum + length(path), 0);
  const mean = (ps: Point[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  // Points every `step` mm along a part's paths.
  const along = (result: RenderResult, prefix: string, step: number) => paths(result, prefix).flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the road and its slabs, the two just landed, the slabs in flight, the helix', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-chariot-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { chariotCamera, chariotWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/vii-chariot/geometry.ts'))};
      export default { name: 'chariot-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'flyers', label: 'Slabs in flight', default: 4, min: 2, max: 6, step: 1 },
          { type: 'slider', id: 'liftX', label: 'Lift-off at page x', default: 100, min: 40, max: 200, step: 1 },
          { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1 },
        ],
        draw(ctx) {
          const w = chariotWorld(ctx, chariotCamera(ctx)), h = createHash('sha256');
          const v = (p) => [p.x, p.y, p.z].join(',');
          h.update([w.path.length, w.path.sLift, w.path.sEnd].join(','));
          for (let k = 0; k <= 200; k++) h.update(v(w.path.at(w.path.length * k / 200)));
          for (const pc of w.build.pieces) {
            const s = pc.slab;
            h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, s.tone, pc.kind, pc.side, pc.row, pc.ramp, pc.sub, pc.span, ';'].join(','));
            if (pc.flight) h.update([v(pc.flight.from), v(pc.flight.to), pc.flight.h, pc.flight.u].join(','));
          }
          for (const c of w.build.cells) h.update([c.s0, c.s1, ';'].join(','));
          for (const u of w.build.unbuilt) h.update([u.ci, u.lane, ';'].join(','));
          for (const p of w.track.ramp) h.update(v(p));
          let vertices = 0;
          for (const mesh of w.helix.meshes) { const at = mesh.getAttribute('position'); vertices += at.count; h.update(Array.from(at.array).join(',')); }
          const d = h.digest();
          const flying = w.build.pieces.filter(pc => pc.kind === 'flying').length;
          for (const g of [...w.helix.meshes, ...w.cellBoxes]) g.dispose();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.build.pieces.length / 10, y: 20 + flying }, { x: 20 + vertices / 1000, y: 20 + w.build.unbuilt.length / 10 }]] }];
        } };`);
    for (const params of [{}, { flyers: 6 }, { liftX: 140, fov: 62 }] as Record<string, number>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params, timeoutMs: 120_000 }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, format: { fit }, timeoutMs: 120_000 })),
      ]);
      // Not an empty world: the road's slabs and the slabs in flight are there.
      const counts = tabloid.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 50 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 1);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(tabloid.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 300_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([rendered(fit), render(fit)]);
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
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      // Paths wholly inside the art window, per part of the scene.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 30, 'shadow-': 20, 'trail-': 4, 'road-': 150, 'unbuilt-': 30, 'pale-': 6, 'dark-': 20, 'helix-': 300 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 300_000);

  it('still reads as the Chariot: the road curls in along the ground from the left and lifts into a ramp, the helix high up it with its head at the edge, the unbuilt road dashed on above, dark slabs from the left and pale from the right, the shadow on the ground', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const ys = (prefix: string) => points(result, prefix).map(p => p.y);
      // The road comes in along the ground from the left side of the window, and its front edge is high in the sky.
      const ground = points(result, 'road-').filter(p => p.y > horizonY);
      expect(Math.min(...ground.map(p => p.x))).toBeLessThan(card.x0 + 0.25 * (card.x1 - card.x0));
      const front = Math.min(...ys('road-'));
      expect(horizonY - front).toBeGreaterThan(80 * s);
      // The chariot is up on the ramp, its head at the edge of what is built: just below the front edge, never past it
      // (the strands' ends are laid out past the head and cut, as on the print).
      const head = Math.min(...ys('helix-'));
      expect(horizonY - head).toBeGreaterThanOrEqual(60 * s);
      expect(head - front).toBeGreaterThan(10 * s);
      expect(head - front).toBeLessThan(30 * s);
      // The road it is meant to become goes on above the front edge, dashed.
      const unbuilt = paths(result, 'unbuilt-');
      const lengths = unbuilt.map(length).sort((a, b) => a - b);
      expect(lengths[Math.floor(lengths.length / 2)]).toBeLessThan(3);
      const above = unbuilt.filter(path => Math.max(...path.map(q => q.y)) < front - 5 * s);
      expect(above.length).toBeGreaterThanOrEqual(20);
      expect(front - Math.min(...above.flat().map(q => q.y))).toBeGreaterThanOrEqual(40 * s);
      // The two forces: the dark slabs from the left, the pale from the right, all of them up in the sky.
      expect(mean(points(result, 'dark-'), 'x')).toBeLessThan(centre);
      expect(mean(points(result, 'pale-'), 'x')).toBeGreaterThan(centre);
      expect(Math.max(...ys('dark-'), ...ys('pale-'))).toBeLessThan(horizonY);
      // The ramp's shadow lies on the open ground.
      expect(Math.min(...ys('shadow-'))).toBeGreaterThan(horizonY);
    }
  }, 300_000);

  it('keeps the print’s tones on paper: the shadow and sky ruled at the print’s pitch, the dark slabs dark, the climb up the ramp solid', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { horizonY } = formatOf(fit);
      const rows = (prefix: string) => [...new Set(paths(result, prefix).filter(path => Math.abs(path[0].y - path[path.length - 1].y) < 0.01)
        .map(path => Math.round(path[0].y * 1000) / 1000))].sort((a, b) => a - b);
      const gap = (ys: number[]) => Math.min(...ys.slice(1).map((y, i) => y - ys[i]));
      // Held in real millimetres (0.7 and 1.2): scaled with the card they would be under a third of that.
      expect(gap(rows('shadow-'))).toBeGreaterThan(0.69);
      expect(gap(rows('sky-'))).toBeGreaterThan(1.19);
      // The print's hatch on a dark slab fits a ring at most on the small card; there the dark slabs are striped, and carry
      // well over twice the pale ones' ink.
      expect(drawn(result, 'dark-')).toBeGreaterThan(2.5 * drawn(result, 'pale-'));
      // The helix's laminations hold all the way up the ramp: the strand's centre is set on its first rest below the head,
      // so no open bar falls on the climb. In each sixth of the height from the head down to the horizon, the strands carry
      // at least 1.8 times as much lamination as edge (an open bar there drops it to about 1.3).
      const head = Math.min(...points(result, 'helix-').map(p => p.y));
      const within = (ids: string[], y0: number, y1: number) => result.parts.filter(part => ids.includes(part.id)).reduce((sum, part) => sum + part.paths.reduce((t, path) => {
        for (let i = 1; i < path.length; i++) if ((path[i].y + path[i - 1].y) / 2 >= y0 && (path[i].y + path[i - 1].y) / 2 < y1) t += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        return t;
      }, 0), 0);
      for (let k = 0; k < 6; k++) {
        const y0 = head + (horizonY - head) * k / 6, y1 = head + (horizonY - head) * (k + 1) / 6;
        expect(within(['helix-violet', 'helix-ultramarine'], y0, y1) / within(['helix-vermilion'], y0, y1), `${fit} sixth ${k}`).toBeGreaterThan(1.8);
      }
    }
  }, 300_000);

  it('scales its halos with the card: the sky gives way to the flight trails by half a millimetre, not the print’s 1.4', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const sky = along(result, 'sky-', 0.1), trail = along(result, 'trail-', 0.1);
      let nearest = Infinity;
      for (const p of sky) for (const q of trail) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      // At least the 0.5 mm floor (less the mask's sampling), and no wider than that plus a little.
      expect(nearest).toBeGreaterThan(0.3);
      expect(nearest).toBeLessThan(0.8);
    }
  }, 300_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is; its slabs trimmed and whole', async () => {
    const [tabloid, ...small] = await Promise.all([print(), ...fits.map(rendered)]);
    const master = probe(tabloid);
    for (const [k, result] of small.entries()) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // The slabs in flight are trimmed to their outlines (kit/slabs.ts): untrimmed, their back edges and thin sides
      // double them, and a third of their lines run too close.
      for (const id of ['pale-carbon', 'dark-carbon']) expect(report.parts.find(part => part.id === id)!.share, `${fits[k]} ${id}`).toBeLessThan(0.1);
      // The helix's laminations are spaced on this card's paper, through the stand-in camera with the card's own lens:
      // well under the print's 71% of its violet crowds (spaced as the bent strand looks to the card's camera itself, 76%).
      expect(report.parts.find(part => part.id === 'helix-violet')!.share, fits[k]).toBeLessThan(0.6);
      // And whole: tested for hidden lines at the print's resolution, their outlines keep over 45% of the print's length
      // in proportion (at the card's own 0.25 mm raster the depth test frays them to about a third).
      expect(drawn(result, 'pale-') / formatOf(fits[k]).s).toBeGreaterThan(0.45 * drawn(tabloid, 'pale-'));
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its pitches
    // shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...tabloid, parts: tabloid.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-carbon', 'road-carbon', 'helix-violet']) expect(denser).toContain(id);
  }, 300_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, named] = await Promise.all([renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }), rendered('width')]);
    expect(plain.parts).toEqual(named.parts);
  }, 300_000);
});
