import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { drawBridge, type BridgeDrawing } from '../../sketches/load-bearing-silence/geometry.ts';
import { resolveMacroParams } from '../sketch/control-values.js';
import { mulberry32 } from '../utils/prng.ts';
import type { Params, Point, SketchContext } from '../sketch/types.ts';

const entry = resolve('sketches/load-bearing-silence/sketch.ts');
const bridgeParts = (result: Awaited<ReturnType<typeof renderSketch>>) => result.parts.filter(part => part.id.startsWith('bridge-'));

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const squared = dx * dx + dy * dy;
  const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / squared));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

function geometryContext(params: Params, seed: number): SketchContext {
  return {
    params, seed, assets: {},
    random(id: string) {
      const hash = createHash('sha256').update(`${seed}\0${id}`).digest().readUInt32LE(0);
      return mulberry32(hash);
    },
  };
}

function gapClearance(drawing: BridgeDrawing): number {
  const center = drawing.stats.projectedGapCenter;
  return Math.min(...drawing.parts.flatMap(part => part.paths.flatMap(path =>
    path.slice(1).map((point, index) => distanceToSegment(center, path[index], point)))));
}

describe('Load Bearing Silence', () => {
  it('keeps five ordered inks, a genuinely empty central span, and bounded plot geometry', async () => {
    const first = await renderSketch({ entry, seed: 17 });
    const repeated = await renderSketch({ entry, seed: 17 });
    expect(first.identity).toBe(repeated.identity);
    expect(first.parts).toEqual(repeated.parts);
    expect(first.diagnostics).toEqual([]);
    expect(first.metadata.page).toEqual({ width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' });
    expect(first.metadata.pens.map(pen => pen.id)).toEqual(['carbon', 'ultramarine', 'vermilion', 'acid', 'violet']);
    expect(first.parts.map(part => part.id)).toEqual([
      'poster-title', 'poster-caption', 'poster-rules',
      'bridge-carbon', 'bridge-ultramarine', 'bridge-vermilion', 'bridge-acid', 'bridge-violet',
    ]);
    const parts = bridgeParts(first);
    expect(parts.every(part => part.paths.length >= 10)).toBe(true);
    expect(parts.filter(part => part.paths.length >= 20).length).toBeGreaterThanOrEqual(4);
    for (const part of parts) for (const path of part.paths) {
      expect(path.length).toBeGreaterThanOrEqual(2);
      for (const point of path) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(18);
        expect(point.x).toBeLessThanOrEqual(261.4);
        expect(point.y).toBeGreaterThanOrEqual(76);
        expect(point.y).toBeLessThanOrEqual(371.8);
      }
    }
    expect(first.stats.pointCount).toBeLessThan(200_000);
    expect(first.durationMs).toBeLessThan(5_000);
    const bridge = drawBridge(geometryContext(first.effectiveParams ?? first.params, 17));
    expect(bridge.parts.map(part => part.paths.length)).toEqual(parts.map(part => part.paths.length));
    expect(gapClearance(bridge)).toBeGreaterThan(18);
  }, 30000);

  it('keeps radar macros in effective params and makes seed and 3D placement materially change the drawing', async () => {
    const metadata = await inspectSketch({ entry });
    expect(metadata.navigators).toMatchObject([
      { id: 'composition', axes: ['load', 'tension', 'disintegration'] },
      { id: 'branch-root', type: 'xy', axes: ['branchRootX', 'branchRootY'] },
      { id: 'world-position', type: 'xyz', axes: ['worldX', 'worldY', 'worldZ'] },
    ]);
    const baseline = await renderSketch({ entry, seed: 17 });
    const alternate = await renderSketch({ entry, seed: 23 });
    const moved = await renderSketch({ entry, seed: 17, params: { load: 1, worldX: 6, worldY: -5, worldZ: 5 } });
    expect(bridgeParts(alternate)).not.toEqual(bridgeParts(baseline));
    expect(moved.params.hatchPitch).toBe(1.45);
    expect(moved.effectiveParams?.hatchPitch).toBe(1.15);
    expect(bridgeParts(moved)).not.toEqual(bridgeParts(baseline));
    expect(moved.metadata.navigators).toEqual(metadata.navigators);
  }, 30000);

  it('renders finite geometry at every slider minimum and maximum', async () => {
    const metadata = await inspectSketch({ entry });
    for (const bound of ['default', 'min', 'max'] as const) {
      const params = Object.fromEntries(metadata.controls.map(control => [control.id, control.type === 'slider' ? control[bound] : control.default]));
      const result = await renderSketch({ entry, seed: 109, params });
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeGreaterThan(5_000);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      expect(result.svg).toContain('<svg');
      const effective = resolveMacroParams(metadata.controls, result.params, metadata.macros);
      expect(result.effectiveParams).toEqual(effective);
      const drawing = drawBridge(geometryContext(effective, 109));
      expect(drawing.parts.map(part => part.paths.length)).toEqual(bridgeParts(result).map(part => part.paths.length));
      expect(drawing.stats.projectedGapCenter.x).toBeGreaterThan(100);
      expect(drawing.stats.projectedGapCenter.x).toBeLessThan(190);
      expect(drawing.stats.projectedGapCenter.y).toBeGreaterThan(165);
      expect(drawing.stats.projectedGapCenter.y).toBeLessThan(255);
      expect(gapClearance(drawing)).toBeGreaterThan(18);
    }
  }, 30000);
});
