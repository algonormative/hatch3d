import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { collect } from '../../sketches/chamber-bloom/geometry.ts';
import type { Point } from '../sketch/types.ts';
import { renderSketch } from '../../cli/sketch/runner.ts';

const entry = resolve('sketches/chamber-bloom/sketch.ts');
const art = { left: 18, right: 279, top: 76, bottom: 357 };

describe('Chamber Bloom', () => {
  it('splits long ribs at interior masks even when both endpoints are visible', () => {
    const paths: Point[][]=[];
    collect([{x:0,y:0},{x:10,y:0}],p=>p.x<2||p.x>8,paths);
    expect(paths).toHaveLength(2);
    expect(paths[0].at(-1)!.x).toBeLessThan(2);
    expect(paths[1][0].x).toBeGreaterThan(8);
    const separated: Point[][]=[];
    collect([{x:0,y:0},{x:1,y:0},{x:NaN,y:NaN},{x:9,y:0},{x:10,y:0}],()=>true,separated);
    expect(separated).toHaveLength(2);
  });
  it('replays exactly, changes anatomy with seed, and uses every physical ink', async () => {
    const first = await renderSketch({ entry, seed: 17 });
    const replay = await renderSketch({ entry, seed: 17 });
    const other = await renderSketch({ entry, seed: 71 });
    expect(replay.identity).toBe(first.identity);
    expect(replay.parts).toEqual(first.parts);
    expect(other.parts).not.toEqual(first.parts);
    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      const counts = new Map(result.metadata.pens.map(pen => [pen.id, 0]));
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const part of result.parts) {
        counts.set(part.pen, (counts.get(part.pen) ?? 0) + part.paths.length);
        if (part.id.startsWith('poster-')) continue;
        for (const path of part.paths) for (const point of path) {
          xMin = Math.min(xMin, point.x); xMax = Math.max(xMax, point.x);
          yMin = Math.min(yMin, point.y); yMax = Math.max(yMax, point.y);
        }
      }
      expect(xMin).toBeGreaterThanOrEqual(art.left);
      expect(xMax).toBeLessThanOrEqual(art.right);
      expect(yMin).toBeGreaterThanOrEqual(art.top);
      expect(yMax).toBeLessThanOrEqual(art.bottom);
      for (const count of counts.values()) expect(count).toBeGreaterThan(20);
    }
  });

  it('moves the chamber and changes its terrace and rest structure through controls', async () => {
    const base = await renderSketch({ entry, seed: 17 });
    const moved = await renderSketch({ entry, seed: 17, params: { focusX: 0.72, focusY: 0.34 } });
    const ruptured = await renderSketch({ entry, seed: 17, params: { rupture: 0.9, terraceCount: 6 } });
    expect(moved.parts.find(part => part.id === 'blue-shell')?.paths).not.toEqual(base.parts.find(part => part.id === 'blue-shell')?.paths);
    expect(ruptured.parts.find(part => part.id === 'stepped-terraces')?.paths).not.toEqual(base.parts.find(part => part.id === 'stepped-terraces')?.paths);
    expect(ruptured.effectiveParams?.terraceDepth).toBeGreaterThan(base.effectiveParams?.terraceDepth as number);
  });
});
