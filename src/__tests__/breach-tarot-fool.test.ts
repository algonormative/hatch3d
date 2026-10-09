import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { foolCamera, maze, walls } from '../../sketches/breach-tarot/0-fool/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { onGround } from '../../sketches/kit/perspective.ts';
import type { Slab } from '../../sketches/kit/slabs.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const entry = resolve('sketches/breach-tarot/0-fool/sketch.ts');

describe('Breach Tarot: 0 The Fool', () => {
  it('replays, stays inside the card, and draws the maze, its collapse, the undecided walls, the figure, the tie, the sun, the phrase and the frame', async () => {
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
    for (const id of ['undecided-carbon', 'sun-acid', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['maze-', 'collapse-', 'figure-', 'figure-edge-', 'helix-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('keeps the print identities of configs the small-card port reached: him far left, and a maze whose way in is a tie', async () => {
    // As recorded at 0e887c6, before the port. The first once lost its empty horizon part; at depth 7 the farthest
    // cells tie, and the print's pick is the left one.
    const [left, tie] = await Promise.all([renderSketch({ entry, seed: 1, params: { foolX: 0.3 } }), renderSketch({ entry, seed: 1, params: { depth: 7 } })]);
    expect(left.identity).toBe('da7ca30bf7fbc94f78dd1d32bb5abf6d28293b700102a89eb7172fd892929612');
    expect(tie.identity).toBe('16a4cc8e4e44b10cd2096e8affb1954cf8489254d6c91c769625e6d3965047fe');
  }, 60_000);

  it('frays the grown walls without moving the maze: footprints and standing blocks stay put, only more blocks rise', () => {
    const build = (fray: number) => {
      const ctx = sketchContext(1, { fray });
      const view = foolCamera(ctx);
      const foot = onGround(view, { x: CARD.x0 + (CARD.x1 - CARD.x0) * 0.6, y: CARD.y1 - 32 });
      return walls(ctx, view, maze(ctx, view, foot));
    };
    const still = build(0), frayed = build(1);
    expect(JSON.stringify(frayed.undecided)).toBe(JSON.stringify(still.undecided));
    const at = (sl: Slab) => `${sl.x.toFixed(5)},${sl.y.toFixed(5)},${sl.z.toFixed(5)}`;
    const standing = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'stack' || sl.role === 'pier');
    const before = new Set(standing(still).map(at));
    for (const sl of standing(frayed)) expect(before.has(at(sl))).toBe(true);
    const rising = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'debris').length;
    expect(rising(frayed)).toBeGreaterThan(rising(still));
  });
});

describe('Breach Tarot: 0 The Fool at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: where he stands, the maze and every block of its walls', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-fool-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { foolWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/0-fool/geometry.ts'))};
      export default { name: 'fool-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'depth', label: 'Maze rows', default: 12, min: 6, max: 24, step: 1 }],
        draw(ctx) {
          const w = foolWorld(ctx), h = createHash('sha256');
          h.update([w.foot.x, w.foot.y, w.foot.z].join(','));
          for (const c of w.maze.cells.values()) h.update([c.c, c.r, c.x, c.z, c.t, ';'].join(','));
          for (const wall of w.walls) for (const s of wall.slabs) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, ';'].join(','));
          for (const f of w.undecided) for (const p of f) h.update([p.x, p.y, p.z, ';'].join(','));
          const d = h.digest();
          const slabs = w.walls.reduce((n, wall) => n + wall.slabs.length, 0);
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.maze.cells.size / 10, y: 20 + w.walls.length / 10 }, { x: 20 + slabs / 1000, y: 20 }]] }];
        } };`);
    // The default, and two depths where the farthest cells tie (the print breaks one tie each way).
    for (const params of [{}, { depth: 7 }, { depth: 14 }] as Record<string, number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 20 / 10);
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
      // Paths wholly inside the art window, per part of the scene: the maze, its collapse, the figure, the tie, the
      // undecided footprints, the sun, the shadows.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'maze-': 1000, 'collapse-': 120, 'figure-': 150, 'helix-': 70, 'undecided-': 15, 'sun-': 20, 'shadow-': 10 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Fool: the sun a mark up in the sky to the right, the undecided footprints on the ground, the tie streaming up past his head', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      const mean = (ps: { x: number; y: number }[], k: 'x' | 'y') => ps.reduce((sum, p) => sum + p[k], 0) / ps.length;
      const ys = (ps: { y: number }[]) => ps.map(p => p.y);
      const sun = points(result, 'sun-'), footprints = points(result, 'undecided-'), figure = points(result, 'figure'), tie = points(result, 'helix-');
      // The sun is a mark in the upper right of the sky, its rays and all: right of the centre line, in the upper half.
      expect(Math.min(...sun.map(p => p.x))).toBeGreaterThan(centre - 2);
      expect(Math.max(...ys(sun))).toBeLessThan(card.y0 + (card.y1 - card.y0) / 2);
      expect(mean(sun, 'y')).toBeLessThan(card.y0 + (card.y1 - card.y0) / 3);
      expect(Math.min(...ys(footprints))).toBeGreaterThan(horizonY);
      // He stands on the near ground right of centre, his head up above the horizon.
      expect(Math.max(...ys(figure))).toBeGreaterThan(horizonY + 20);
      expect(Math.min(...ys(figure))).toBeLessThan(horizonY - 15);
      expect(mean(figure, 'x')).toBeGreaterThan(centre);
      // The tie leaves his throat and climbs out of the top of the window, far above his head.
      expect(Math.max(...ys(tie))).toBeGreaterThan(Math.min(...ys(figure)));
      expect(Math.min(...ys(tie))).toBeLessThan(Math.min(...ys(figure)) - 25);
      expect(Math.min(...ys(tie))).toBeLessThan(card.y0 + 2);
    }
  }, 120_000);

  it('keeps the print’s tones where the port scaled them: the collapse thinned, the shadow rows opening as on the print, the sun up to the tie’s halo', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    const count = (r: RenderResult, prefix: string) => r.parts.filter(part => part.id.startsWith(prefix)).reduce((n, part) => n + part.paths.length, 0);
    // Points every `step` mm along a part's paths.
    const along = (r: RenderResult, prefix: string, step: number) => r.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flatMap(path => path.flatMap((b, i) => {
      if (!i) return [b];
      const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
      return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
    })));
    for (const [k, result] of small.entries()) {
      const { card, horizonY } = formatOf(fits[k]);
      // The loose blocks are kept in proportion to the scale (about 0.28 of them, each now mostly an outline): a
      // tenth or so of the print's collapse marks, not the three in ten that all of them make.
      expect(count(result, 'collapse-')).toBeLessThan(0.15 * count(print, 'collapse-'));
      expect(count(result, 'collapse-')).toBeGreaterThan(0.03 * count(print, 'collapse-'));
      // Shadow rows start 0.62 mm apart at the horizon and open toward the foot as on the print: more than 0.85 mm
      // apart in the nearer half of the ground (measured in the card's own millimetres they would stay under 0.8).
      const rows = [...new Set(result.parts.filter(part => part.id.startsWith('shadow-')).flatMap(part => part.paths)
        .filter(path => Math.abs(path[0].y - path.at(-1)!.y) < 0.01).map(path => Math.round(path[0].y * 1000) / 1000))].sort((a, b) => a - b);
      const near = rows.filter(y => y > horizonY + 0.5 * (card.y1 - horizonY));
      expect(near.length).toBeGreaterThan(2);
      for (let i = 1; i < near.length; i++) expect(near[i] - near[i - 1]).toBeGreaterThan(0.85);
      // The sun's fine rays stop at a halo round the tie that scales with the card: they come within 2 mm of it.
      const tie = along(result, 'helix-', 0.2);
      let nearest = Infinity;
      for (const p of along(result, 'sun-', 0.1)) for (const q of tie) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      expect(nearest).toBeLessThan(2);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card without its pitch scaling is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its
    // hatch and cloth pitches shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['maze-ultramarine', 'figure-ultramarine', 'figure-carbon']) expect(denser).toContain(id);
  }, 120_000);
});
