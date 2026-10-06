import { describe, expect, it } from 'vitest';
import type { Params, SketchContext } from '../sketch/types.ts';
import { drawFolds } from '../../sketches/fault-choir/folds.ts';

function context(params: Params = {}, seed = 0): SketchContext {
  return {
    params,
    seed,
    assets: {},
    random(partId: string) {
      let state = Array.from(partId).reduce((acc, char) => Math.imul(acc, 31) + char.charCodeAt(0) | 0, seed + 17);
      return () => {
        state = Math.imul(state, 1664525) + 1013904223 | 0;
        return (state >>> 0) / 4294967296;
      };
    },
  };
}

function paths(result: ReturnType<typeof drawFolds>) {
  return result.parts.flatMap(part => part.paths);
}

function length(path: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

function centroid(result: ReturnType<typeof drawFolds>) {
  const points = paths(result).flat();
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

describe('fault choir folded surfaces', () => {
  it('renders a finite, substantial cluster with a field mask and plot-worthy fragments', () => {
    const result = drawFolds(context());
    expect(result.stats.foldCount).toBe(4);
    expect(result.parts.map(part => part.pen)).toEqual(['carbon', 'cobalt', 'lagoon', 'ember', 'brass']);
    expect(result.stats.occupiedPixels).toBeGreaterThan(30_000);
    expect(result.stats.occupiedPixels).toBeLessThan(150_000);
    expect(result.stats.candidateSegments).toBeGreaterThan(result.stats.visibleSegments);
    expect(result.stats.hiddenSegments).toBeGreaterThan(100);
    expect(paths(result).length).toBeGreaterThan(100);
    for (const path of paths(result)) {
      expect(length(path)).toBeGreaterThanOrEqual(0.9);
      for (const point of path) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(420);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(297);
      }
    }
    expect(result.occludes(210, 148)).toBe(true);
    expect(result.occludes(5, 5)).toBe(false);
  });

  it('uses the unified depth pass for visible lines while retaining the field mask in diagnostic mode', () => {
    const visible = drawFolds(context({ occlusion: true }));
    const diagnostic = drawFolds(context({ occlusion: false }));
    expect(visible.stats.candidateSegments).toBe(diagnostic.stats.candidateSegments);
    expect(visible.stats.visibleSegments).toBeLessThan(diagnostic.stats.visibleSegments);
    expect(diagnostic.stats.hiddenSegments).toBe(0);
    expect(visible.stats.occupiedPixels).toBe(diagnostic.stats.occupiedPixels);
    expect(visible.occludes(210, 148)).toBe(diagnostic.occludes(210, 148));
  });

  it('moves the whole 3D cluster along each world axis and changes the seeded arrangement', () => {
    const base = drawFolds(context());
    const origin = centroid(base);
    for (const axis of ['foldX', 'foldY', 'foldZ']) {
      const moved = drawFolds(context({ [axis]: 1 }));
      const center = centroid(moved);
      expect(Math.hypot(center.x - origin.x, center.y - origin.y)).toBeGreaterThan(2);
    }
    const alternate = drawFolds(context({}, 29));
    expect(paths(alternate)).not.toEqual(paths(base));
    expect(alternate.stats.foldCount).toBe(4);
  });
});
