import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { slabs } from '../../sketches/breach-cathedral/geometry.ts';

const entry = resolve('sketches/breach-cathedral/sketch.ts');

function shellCells(parts: Awaited<ReturnType<typeof renderSketch>>['parts']): Set<string> {
  const cells = new Set<string>();
  const body = parts.find(p => p.id === 'cathedral-vermilion')!;
  for (const path of body.paths) for (const point of path) {
    cells.add(`${Math.floor(point.x / 12)},${Math.floor(point.y / 12)}`);
  }
  return cells;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const cell of a) if (b.has(cell)) shared++;
  return shared / (a.size + b.size - shared);
}

describe('Breach Cathedral', () => {
  it('keeps split slab widths positive at the narrowest reach and widest breach', () => {
    for (const roll of [0.001, 0.25, 0.5, 0.75, 0.999]) {
      const architecture = slabs({
        params: { cantilever: 0, breach: 1, levels: 13 }, seed: 0, assets: {},
        random: () => () => roll,
      });
      expect(Math.min(...architecture.map(slab => slab.w))).toBeGreaterThan(0);
    }
  });

  it('replays, reshuffles with seed, and keeps every ink finite within the art field', async () => {
    const first = await renderSketch({ entry, seed: 17 });
    const replay = await renderSketch({ entry, seed: 17 });
    const other = await renderSketch({ entry, seed: 73 });
    const third = await renderSketch({ entry, seed: 211 });
    expect(replay.identity).toBe(first.identity);
    expect(replay.parts).toEqual(first.parts);
    expect(other.identity).not.toBe(first.identity);
    expect(other.parts).not.toEqual(first.parts);
    // Coarse page occupancy tests the silhouette, beyond exact path jitter.
    expect(overlap(shellCells(first.parts), shellCells(other.parts))).toBeLessThan(0.7);
    expect(overlap(shellCells(first.parts), shellCells(third.parts))).toBeLessThan(0.7);
    for (const result of [first, other, third]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pathCount).toBeGreaterThan(1800);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      const art = result.parts.filter(p => p.id.startsWith('cathedral-'));
      expect(art).toHaveLength(5);
      for (const part of art) {
        expect(part.paths.length).toBeGreaterThan(part.pen === 'acid' ? 10 : 60);
        for (const path of part.paths) for (const p of path) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
          expect(p.x).toBeGreaterThanOrEqual(18 - 1e-8);
          expect(p.x).toBeLessThanOrEqual(261.4 + 1e-8);
          expect(p.y).toBeGreaterThanOrEqual(76 - 1e-8);
          expect(p.y).toBeLessThanOrEqual(371.8 + 1e-8);
        }
      }
    }
  });

  it('responds to the composition and world controls and removes hidden runs', async () => {
    const base = await renderSketch({ entry, seed: 17 });
    const moved = await renderSketch({ entry, seed: 17, params: { worldZ: 1.5, growth: 0.8 } });
    const transparent = await renderSketch({ entry, seed: 17, params: { occlusion: false } });
    expect(moved.effectiveParams?.shellWidth).not.toBe(base.effectiveParams?.shellWidth);
    expect(moved.parts.filter(p => p.id.startsWith('cathedral-'))).not.toEqual(base.parts.filter(p => p.id.startsWith('cathedral-')));
    expect(transparent.stats.lengthMm).toBeGreaterThan(base.stats.lengthMm);
  });

  it('retains closed architectural outlines and moves the whole scene in XYZ', async () => {
    const openDepth = await renderSketch({ entry, seed: 17, params: { occlusion: false } });
    const carbon = openDepth.parts.find(p => p.id === 'cathedral-carbon')!;
    const closed = carbon.paths.filter(path => {
      const a = path[0], b = path.at(-1)!;
      return Math.hypot(a.x - b.x, a.y - b.y) < 0.001;
    });
    expect(closed.length).toBeGreaterThan(0);

    const shifted = await renderSketch({ entry, seed: 17, params: { occlusion: false, worldX: 0.5, worldY: -0.5, worldZ: 0.5 } });
    expect(shifted.parts.find(p => p.id === 'cathedral-carbon')?.paths).not.toEqual(carbon.paths);
  });

  it('moves the membrane with Organic focus XY while the architecture stays put', async () => {
    const base = await renderSketch({ entry, seed: 17, params: { occlusion: false } });
    const focused = await renderSketch({ entry, seed: 17, params: { occlusion: false, focusX: 0.8, focusY: 0.2 } });
    expect(focused.parts.find(p => p.id === 'cathedral-carbon')?.paths)
      .toEqual(base.parts.find(p => p.id === 'cathedral-carbon')?.paths);
    const center = (parts: typeof base.parts) => {
      const points = parts.find(p => p.id === 'cathedral-vermilion')!.paths.flat();
      return {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };
    };
    const before = center(base.parts), after = center(focused.parts);
    expect(after.x - before.x).toBeGreaterThan(5);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(5);
  });
  it('exposes a useful sparse-to-dense hatch range without losing the art aperture', async () => {
    const sparse = await renderSketch({ entry, seed: 0, params: { hatchDensity: 0, occlusion: false } });
    const dense = await renderSketch({ entry, seed: 0, params: { hatchDensity: 1, occlusion: false } });
    expect(dense.stats.pathCount).toBeGreaterThan(sparse.stats.pathCount * 1.5);
    for (const result of [sparse, dense]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      for (const part of result.parts.filter(p => p.id.startsWith('cathedral-'))) {
        for (const path of part.paths) for (const point of path) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(point.x).toBeGreaterThanOrEqual(18 - 1e-8);
          expect(point.x).toBeLessThanOrEqual(261.4 + 1e-8);
          expect(point.y).toBeGreaterThanOrEqual(76 - 1e-8);
          expect(point.y).toBeLessThanOrEqual(371.8 + 1e-8);
        }
      }
    }
  });

});
