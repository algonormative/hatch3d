import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { arcs, axisTable, chartresPlan, CHARTRES } from '../../sketches/breach-tarot/xxi-world/labyrinth.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { TABLOID_CARD, TABLOID_HORIZON_Y, formatFor, type Fit } from '../../sketches/kit/format.ts';
import { facetStrokes, slabGeometry, solid } from '../../sketches/kit/slabs.ts';
import { fitDepthRange } from '../../sketches/kit/perspective.ts';
import { projectStrokes } from '../../sketches/kit/strokes.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';
import { nearestDistance } from './helpers/nearest.ts';

const entry = resolve('sketches/breach-tarot/xxi-world/sketch.ts');
const sorted = (s?: Set<number>) => [...(s ?? [])].sort((a, b) => a - b);

describe('Breach Tarot: XXI The World', () => {
  it('replays, stays inside the card, and draws the walls, the shadows, the figure, the helix, the corner marks, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 3 });
    const replay = await renderSketch({ entry, seed: 3 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['emblem-carbon', 'emblem-ultramarine', 'emblem-vermilion', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['walls-', 'shadow-', 'figure-', 'helix-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('lays out the Chartres labyrinth: 44 arcs, the turns stacked on the axes, two lanes up the entrance', () => {
    expect(CHARTRES).toHaveLength(44);
    const table = axisTable(arcs());
    expect(sorted(table.L.straight)).toEqual([1, 4, 7, 10, 11]);
    expect(sorted(table.T.straight)).toEqual([3, 6, 9]);
    expect(sorted(table.R.straight)).toEqual([1, 2, 5, 8, 11]);
    expect(sorted(table.B.straight)).toEqual([]);
    expect(sorted(table.B.lanes.get('LL'))).toEqual([5, 6, 11]);
    expect(sorted(table.B.lanes.get('LR'))).toEqual([1, 6, 7]);
  });

  it('walks its one path from outside the rim to the centre without crossing a wall', () => {
    const pitch = 10;
    const plan = chartresPlan(pitch);
    const walk = plan.walk;
    expect(Math.hypot(walk[0].x, walk[0].y)).toBeGreaterThan(plan.wall(0));
    expect(Math.hypot(walk[walk.length - 1].x, walk[walk.length - 1].y)).toBeLessThan(plan.wall(11));
    // Every wall stays half a path's width from the walk (allowing for the sampling of both).
    const wallPts = plan.walls.flatMap(w => w.flatMap((p, i) => i === 0 ? [p] : Array.from({ length: 6 }, (_, k) => ({
      x: w[i - 1].x + (p.x - w[i - 1].x) * (k + 1) / 6, y: w[i - 1].y + (p.y - w[i - 1].y) * (k + 1) / 6,
    }))));
    let nearest = Infinity;
    for (let i = 1; i < walk.length; i++) {
      const a = walk[i - 1], b = walk[i];
      if (Math.hypot(a.x, a.y) < plan.wall(11) - pitch) continue;
      for (const q of wallPts) {
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
        nearest = Math.min(nearest, Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)));
      }
    }
    expect(nearest).toBeGreaterThan(0.4 * pitch);
    // Every walk segment against every wall point: slow on a loaded machine, where it has timed out at the default.
  }, 60_000);

  it('opens the helix at the top to between a third and a half of the card, and keeps paper round the figure', async () => {
    const result = await renderSketch({ entry, seed: 3 });
    const xs = result.parts.filter(p => p.id.startsWith('helix-')).flatMap(p => p.paths.flat()).filter(p => p.y < CARD.y0 + 60).map(p => p.x);
    const share = (Math.max(...xs) - Math.min(...xs)) / (CARD.x1 - CARD.x0);
    expect(share).toBeGreaterThan(1 / 3);
    expect(share).toBeLessThan(1 / 2);
    const figure = result.parts.filter(p => p.id.startsWith('figure')).flatMap(p => p.paths.flat());
    const walls = result.parts.filter(p => p.id.startsWith('walls-') || p.id.startsWith('shadow-')).flatMap(p => p.paths.flat());
    const box = { x0: Math.min(...figure.map(p => p.x)) - 3, x1: Math.max(...figure.map(p => p.x)) + 3, y0: Math.min(...figure.map(p => p.y)) - 3, y1: Math.max(...figure.map(p => p.y)) + 3 };
    let nearest = Infinity;
    for (const w of walls) {
      if (w.x < box.x0 || w.x > box.x1 || w.y < box.y0 || w.y > box.y1) continue;
      for (const f of figure) nearest = Math.min(nearest, Math.hypot(w.x - f.x, w.y - f.y));
    }
    expect(nearest).toBeGreaterThan(1.0);
  }, 60_000);

  it('fits the depth range to the scene, so a small block far off hides its own back edges', () => {
    const W = 400, H = 400;
    const block = solid(0, 0, -700, 4, 2.2, 2, 0, 'stack');
    block.ry = 0.5;
    const eye = new THREE.Vector3(0, 300, -260);
    const visible = (near: number, far: number, fit: boolean) => {
      const view = new THREE.PerspectiveCamera(8, 1, near, far);
      view.position.copy(eye);
      view.lookAt(0, 0, -700);
      view.updateMatrixWorld();
      const geometry = slabGeometry(block);
      if (fit) fitDepthRange(view, [geometry]);
      const depth = renderDepthBufferCPU([geometry], view, W, H);
      let length = 0;
      projectStrokes(facetStrokes(block, new THREE.Vector3(0, 1, 0), eye, true), { view, depth, width: W, height: H }, {
        begin: () => runs => { for (const run of runs) for (let i = 1; i < run.length; i++) length += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y); },
      });
      geometry.dispose();
      return length;
    };
    const loose = visible(2, 6000, false), fitted = visible(2, 6000, true);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(0.85 * loose);
  });
});

describe('Breach Tarot: XXI The World at 70 x 120 mm', () => {
  type Pt = { x: number; y: number };
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  const T = 120_000;
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, and one print, shared.
  const render = (fit: Fit) => renderSketch({ entry, seed: 3, finishing: { page }, format: { fit }, timeoutMs: T });
  const renders = new Map<Fit, Promise<RenderResult>>();
  const rendered = (fit: Fit) => { if (!renders.has(fit)) renders.set(fit, render(fit)); return renders.get(fit)!; };
  let printed: Promise<RenderResult> | undefined;
  const print = () => (printed ??= renderSketch({ entry, seed: 3, timeoutMs: T }));
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const all = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => all(result, prefix).flat();
  const length = (path: Pt[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  /** Where the labyrinth's centre lands on a small card: the print's, 0.64 of the way down its window, as a layout position. */
  const centreOf = (fit: Fit) => {
    const { card, horizonY, s } = formatOf(fit);
    return { x: (card.x0 + card.x1) / 2, y: horizonY + (TABLOID_CARD.y0 + 0.64 * (TABLOID_CARD.y1 - TABLOID_CARD.y0) - TABLOID_HORIZON_Y) * s };
  };
  /** Points every `step` mm along a list of paths. */
  const sampled = (paths: Pt[][], step = 0.05): Pt[] => paths.flatMap(path => path.slice(1).flatMap((b, i) => {
    const a = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    return Array.from({ length: k }, (_, j) => ({ x: a.x + (b.x - a.x) * (j + 1) / k, y: a.y + (b.y - a.y) * (j + 1) / k }));
  }));
  /** The least distance from any of `a` to any of `b`. */
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the walls, the blocks settling, his tie and where the print draws every brick', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-world-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { worldOf } from ${JSON.stringify(resolve('sketches/breach-tarot/xxi-world/geometry.ts'))};
      export default { name: 'world-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'settling', label: 'Settling', default: 6, min: 0, max: 24, step: 1 },
          { type: 'slider', id: 'quietTo', label: 'Quiet to', default: 48, min: -40, max: 140, step: 1 },
          { type: 'select', id: 'figure', label: 'Figure', default: 'arrived', options: ['arrived', 'fool', 'dancer'] },
        ],
        draw(ctx) {
          const w = worldOf(ctx), h = createHash('sha256');
          let drawn = 0, settling = 0;
          w.slabs.forEach((s, i) => {
            const d = w.drawn(s, i);
            if (d) drawn++;
            if (s.role === 'debris') settling++;
            h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, d, ';'].join(','));
          });
          for (const p of w.curve.points) h.update([p.x, p.y, p.z, ';'].join(','));
          h.update([w.centre.z, w.glow.y, w.lunationStart, w.walls.map(x => x.from).join(' ')].join(','));
          for (const g of [...w.figureMeshes, ...w.helix.meshes]) g.dispose();
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.slabs.length / 1000, y: 20 + drawn / 1000 }, { x: 20 + settling, y: 20 + w.curve.points.length }]] }];
        } };`);
    // The default; every coping that may settle; the bricks drawn everywhere (quiet from the top); the bare dancer, whose hand lets the tie go.
    for (const params of [{}, { settling: 24 }, { quietTo: -40 }, { figure: 'dancer' }] as Record<string, number | string>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 3, params, timeoutMs: T }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 3, params, finishing: { page }, format: { fit }, timeoutMs: T })),
      ]);
      const counts = tabloid.parts.find(part => part.id === 'counts')!.paths[0];
      // Thousands of blocks, some drawn brick by brick, a few settling.
      expect(counts[1].x, JSON.stringify(params)).toBeGreaterThan(20 + 3);
      expect(counts[1].y, JSON.stringify(params)).toBeGreaterThan(20 + 0.3);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(tabloid.parts.find(part => part.id === id)!.paths);
      }
    }
  }, T);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([rendered(fit), render(fit)]);
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
      // Paths wholly inside the art window, per part of the scene: the walls, their shadows, the figure and his outline,
      // the tie, the corner marks.
      const inWindow = (prefix: string) => all(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'walls-': 300, 'shadow-': 400, 'figure-': 60, 'figure-edge-': 25, 'helix-': 150, 'emblem-': 25 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(40);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, T);

  it('still reads as the World: the rings round the centre, the Fool at it, his tie climbing out of the top, brick detail where his light falls off, a mark in each corner', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { card, s } = formatOf(fit);
      const c = centreOf(fit);
      const walls = all(result, 'walls-'), figure = points(result, 'figure'), tie = points(result, 'helix-');
      const xs = walls.flat().map(p => p.x);
      expect((Math.min(...xs) + Math.max(...xs)) / 2, fit).toBeCloseTo(c.x, 0);
      // The path is the reading: from the centre out along each diagonal all twelve ring walls cross, each one line, a
      // millimetre or more apart (crest lines, not courses).
      for (const [dx, dy] of [[-1, 1], [1, 1], [-1, -0.6], [1, -0.6]]) {
        const k = Math.hypot(dx, dy), ux = dx / k, uy = dy / k;
        const hits: number[] = [];
        for (const path of walls) {
          if (length(path) < 2) continue;
          for (let i = 1; i < path.length; i++) {
            const a = path[i - 1], ex = path[i].x - a.x, ey = path[i].y - a.y, den = ux * ey - uy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((a.x - c.x) * ey - (a.y - c.y) * ex) / den, u = ((a.x - c.x) * uy - (a.y - c.y) * ux) / den;
            if (u >= 0 && u <= 1 && t >= 0 && t <= 40) hits.push(t);
          }
        }
        hits.sort((a, b) => a - b);
        expect(hits.length, `${fit} along (${dx}, ${dy})`).toBe(12);
        for (let i = 1; i < hits.length; i++) expect(hits[i] - hits[i - 1], `${fit} along (${dx}, ${dy})`).toBeGreaterThan(1);
      }
      // He stands at the centre, his feet on its floor, his head and open arms up over the far rings.
      const mean = (ps: Pt[], key: 'x' | 'y') => ps.reduce((sum, p) => sum + p[key], 0) / ps.length;
      expect(Math.abs(mean(figure, 'x') - c.x), fit).toBeLessThan(1);
      expect(Math.abs(Math.max(...figure.map(p => p.y)) - c.y), fit).toBeLessThan(1.5);
      expect(Math.min(...figure.map(p => p.y)), fit).toBeLessThan(c.y - 25 * s);
      // His tie leaves his throat and climbs out of the top of the window, opening there to a third to a half of the card.
      expect(Math.max(...tie.map(p => p.y)), fit).toBeGreaterThan(Math.min(...figure.map(p => p.y)));
      expect(Math.min(...tie.map(p => p.y)), fit).toBeLessThan(card.y0 + 0.1);
      const high = tie.filter(p => p.y < card.y0 + 60 * s).map(p => p.x);
      const share = (Math.max(...high) - Math.min(...high)) / (card.x1 - card.x0);
      expect(share, fit).toBeGreaterThan(1 / 3);
      expect(share, fit).toBeLessThan(1 / 2);
      // Brick detail gathers where his light falls off: the joints (short marks down the walls' faces) stand mostly in the
      // outer rings, few in the inner half round him: over four and a half times as many outside it (5.4 to 6.3), where
      // joints kept along every wall, not where the print draws its bricks, stood 3.3 to 3.5 times.
      const joints = walls.filter(path => length(path) < 1.3 && Math.abs(path.at(-1)!.y - path[0].y) > 0.8 * length(path));
      const half = (Math.max(...xs) - Math.min(...xs)) / 4;
      const inner = joints.filter(path => ((path[0].x - c.x) / half) ** 2 + ((path[0].y - c.y) / (0.72 * half)) ** 2 < 1).length;
      expect(joints.length - inner, fit).toBeGreaterThan(4.5 * inner);
      expect(inner, fit).toBeGreaterThan(5);
      // The first set's marks keep their corners, a scaled inset in, and their size scales with the card: the star top
      // left, the disc top right, the bolt bottom left, the sun bottom right.
      const inset = 20 * s, size = 2 * 9 * s;
      const box = (ps: Pt[]) => ({ x: (Math.min(...ps.map(p => p.x)) + Math.max(...ps.map(p => p.x))) / 2, y: (Math.min(...ps.map(p => p.y)) + Math.max(...ps.map(p => p.y))) / 2, h: Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)) });
      const carbon = points(result, 'emblem-carbon');
      const marks = [
        { at: box(points(result, 'emblem-ultramarine')), x: card.x0 + inset, y: card.y0 + inset },
        { at: box(carbon.filter(p => p.y < c.y)), x: card.x1 - inset, y: card.y0 + inset },
        { at: box(carbon.filter(p => p.y > c.y)), x: card.x0 + inset, y: card.y1 - inset },
        { at: box(points(result, 'emblem-vermilion')), x: card.x1 - inset, y: card.y1 - inset },
      ];
      for (const [i, { at, x, y }] of marks.entries()) {
        expect(Math.hypot(at.x - x, at.y - y), `${fit} mark ${i}`).toBeLessThan(0.6);
        expect(at.h, `${fit} mark ${i}`).toBeGreaterThan(0.75 * size);
        expect(at.h, `${fit} mark ${i}`).toBeLessThan(1.05 * size);
      }
    }
  }, T);

  it('keeps clear paper round him and round his tie, the halos scaled with the card: no nearer than the floor allows, no wider than scaled', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      const scene = sampled([...all(result, 'walls-'), ...all(result, 'shadow-')]);
      // The print keeps 1.7 mm round the figure and 1.4 mm round the tie; on the card each is scaled, never under 0.5 mm, on
      // a mask as fine as the print's. A wall stops a step of the walk short of the mask, which is a pixel off the mesh: no
      // nearer than 0.3 mm to his lines, nor further than the scaled halo and 0.15 (left at the print's, they were over 1.3).
      for (const [prefix, print] of [['figure', 1.7], ['helix-', 1.4]] as const) {
        const gap = nearestDistance(scene, sampled(all(result, prefix)));
        expect(gap, `${fit} ${prefix}`).toBeGreaterThan(0.3);
        expect(gap, `${fit} ${prefix}`).toBeLessThan(Math.max(0.5, print * s) + 0.15);
      }
    }
  }, T);

  it('is no denser than its tabloid print, part by part, each wall one line, which the print shrunk to the card is not', async () => {
    const tabloid = await print();
    const master = probe(tabloid);
    for (const fit of fits) {
      const report = probe(await rendered(fit));
      expect(denserThan(report, master), `${fit} ${describeDensity(report)}`).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // Each wall is one line along its crest, and its rim's blocks trimmed outlines: no stroke of the walls runs beside
      // another closer than the pens hold apart (the print's courses crowd 39% of its walls).
      const walls = report.parts.find(part => part.id === 'walls-carbon')!;
      expect(walls.violations, `${fit} ${describeDensity(report)}`).toBe(0);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its courses,
    // hatch and shadow rows shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...tabloid, parts: tabloid.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['walls-carbon', 'shadow-carbon', 'figure-ultramarine', 'figure-violet', 'emblem-carbon']) expect(denser).toContain(id);
  }, T);

  it('draws the rim’s blocks and the settling copings as trimmed outlines: no edge of theirs doubled, even for a block’s length', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      // Trimmed (kit/slabs.ts' `SlabTrim`), a block's front face, a sliver seen from above, is folded into its outline.
      // Untrimmed, each face's loop ran its edges a fraction of a millimetre apart, too short for the probe's millimetre
      // run: at a fifth of one, 17 to 23 pairs of the walls' strokes.
      const report = densityProbe(result.parts.filter(part => part.id === 'walls-carbon'), { penWidth: () => 0.25, minRun: 0.2 });
      expect(report.violations, `${fit} ${describeDensity(report)}`).toBe(0);
    }
  }, T);

  it('draws in its preferred fit, width, where the render names none: the whole labyrinth in the window, which height crops', async () => {
    const [plain, width, height] = await Promise.all([renderSketch({ entry, seed: 3, finishing: { page }, timeoutMs: T }), rendered('width'), rendered('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
    // In its width the rim and its blocks stand clear of the window's sides; in height they run to its edges.
    const edge = (fit: Fit, result: RenderResult) => {
      const { card } = formatOf(fit);
      return Math.min(...points(result, 'walls-').map(p => Math.min(p.x - card.x0, card.x1 - p.x)));
    };
    expect(edge('width', width)).toBeGreaterThan(1);
    expect(edge('height', height)).toBeLessThan(0.05);
  }, T);
});
