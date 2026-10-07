import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { arcs, axisTable, chartresPlan, CHARTRES } from '../../sketches/breach-tarot/xxi-world/labyrinth.ts';
import { facetStrokes, slabGeometry, solid } from '../../sketches/kit/slabs.ts';
import { fitDepthRange } from '../../sketches/kit/perspective.ts';
import { projectStrokes } from '../../sketches/kit/strokes.ts';

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
  });

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
