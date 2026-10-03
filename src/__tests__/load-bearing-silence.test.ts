import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { drawBridge } from '../../sketches/load-bearing-silence/geometry.ts';
import { mulberry32 } from '../utils/prng.ts';
import type { Params, Point, SketchContext } from '../sketch/types.ts';

const entry = resolve('sketches/load-bearing-silence/sketch.ts');
const art = (result: Awaited<ReturnType<typeof renderSketch>>, prefix: string) =>
  result.parts.filter(part => part.id.startsWith(prefix));
const count = (result: Awaited<ReturnType<typeof renderSketch>>, prefix: string) =>
  art(result, prefix).reduce((total, part) => total + part.paths.length, 0);

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

function clearance(drawing: ReturnType<typeof drawBridge>, prefix: string, center: Point): number {
  return Math.min(...drawing.parts.filter(part => part.id.startsWith(prefix)).flatMap(part =>
    part.paths.flatMap(path => path.slice(1).map((point, index) => distanceToSegment(center, path[index], point)))));
}

describe('Load Bearing Silence', () => {
  it('is deterministic, bounded on Tabloid, and uses eight actual plotter inks', async () => {
    const first = await renderSketch({ entry, seed: 211 });
    const repeated = await renderSketch({ entry, seed: 211 });
    expect(first.identity).toBe(repeated.identity);
    expect(first.parts).toEqual(repeated.parts);
    expect(first.diagnostics).toEqual([]);
    expect(first.metadata.page).toEqual({ width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' });
    expect(first.metadata.pens.map(pen => pen.id)).toEqual(['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'cyan', 'coral', 'gold']);
    for (const pen of ['cyan', 'coral', 'gold']) {
      expect(first.parts.filter(part => part.pen === pen).some(part => part.paths.length > 0)).toBe(true);
      expect(count(first, `ribbon-${pen}`)).toBeGreaterThan(0);
    }
    for (const pen of ['acid', 'violet']) expect(count(first, `bridge-${pen}`)).toBeGreaterThan(0);
    for (const part of first.parts) for (const path of part.paths) for (const point of path) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(18);
      expect(point.x).toBeLessThanOrEqual(261.4);
      expect(point.y).toBeGreaterThanOrEqual(18);
      expect(point.y).toBeLessThanOrEqual(413.8);
    }
    expect(first.stats.pointCount).toBeLessThan(200_000);
    const drawing = drawBridge(geometryContext(first.effectiveParams ?? first.params, 211));
    expect(clearance(drawing, 'ribbon-', drawing.stats.projectedSingularityCenter)).toBeGreaterThan(5);
  }, 30000);

  it('scales the luminous sheet and ray fans across the power range while preserving separate toggles', async () => {
    const quiet = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', singularityPower: 0.05 } });
    const defaultRender = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract' } });
    const powerful = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', singularityPower: 1 } });
    expect(count(quiet, 'ribbon-')).toBeLessThan(count(defaultRender, 'ribbon-'));
    expect(count(powerful, 'ribbon-')).toBeGreaterThan(count(defaultRender, 'ribbon-') * 2);
    expect(count(powerful, 'ray-')).toBeGreaterThan(count(defaultRender, 'ray-'));
    const noRibbons = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', lightRibbons: 0 } });
    const noRays = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', rayCount: 0 } });
    expect(count(noRibbons, 'ribbon-')).toBe(0);
    expect(count(noRays, 'ray-')).toBe(0);
    expect(art(noRibbons, 'bridge-')).toEqual(art(defaultRender, 'bridge-'));
    expect(art(noRays, 'bridge-')).toEqual(art(defaultRender, 'bridge-'));
    const powerNoRibbon = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', singularityPower: 1, ribbonEnabled: false } });
    const powerNoRays = await renderSketch({ entry, seed: 211, params: { posterMode: 'abstract', singularityPower: 1, raysEnabled: false } });
    expect(count(powerNoRibbon, 'ribbon-')).toBe(0);
    expect(count(powerNoRays, 'ray-')).toBe(0);
    expect(count(powerNoRibbon, 'ray-')).toBeGreaterThan(0);
    expect(count(powerNoRays, 'ribbon-')).toBeGreaterThan(0);
  }, 30000);

  it('makes seed change architectural silhouette and control changes move the shared core', async () => {
    const base = await renderSketch({ entry, seed: 17, params: { posterMode: 'abstract' } });
    const alternate = await renderSketch({ entry, seed: 23, params: { posterMode: 'abstract' } });
    const fragmented = await renderSketch({ entry, seed: 17, params: { posterMode: 'abstract', orbitalFragmentation: 1, structureDensity: 1 } });
    expect(art(alternate, 'bridge-')).not.toEqual(art(base, 'bridge-'));
    expect(count(fragmented, 'bridge-')).toBeGreaterThan(count(base, 'bridge-'));
    const moved = await renderSketch({ entry, seed: 17, params: { posterMode: 'abstract', singularityX: 10, singularityY: -8 } });
    expect(art(moved, 'bridge-')).not.toEqual(art(base, 'bridge-'));
    expect(art(moved, 'ribbon-')).not.toEqual(art(base, 'ribbon-'));
  }, 30000);

  it('exposes reachable shape extremes and renders finite geometry at their bounds', async () => {
    const metadata = await inspectSketch({ entry });
    expect(metadata.navigators[0]).toMatchObject({ id: 'composition', axes: ['load', 'tension', 'singularityPower'] });
    for (const id of ['beamWidth', 'hatchPitch', 'portalScale', 'routeWarp', 'gapWidth', 'ribbonWidth', 'rayCount', 'rayLength', 'rayCurve', 'branchCount', 'branchReach']) {
      const control = metadata.controls.find(control => control.id === id);
      expect(control?.type).toBe('slider');
      if (control?.type === 'slider') expect(control.max - control.min).toBeGreaterThan(0);
    }
    for (const bound of ['min', 'max'] as const) {
      const params = Object.fromEntries(metadata.controls.map(control => [control.id, control.type === 'slider' ? control[bound] : control.default]));
      const result = await renderSketch({ entry, seed: 109, params });
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeGreaterThan(1_000);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      const drawing = drawBridge(geometryContext(result.effectiveParams ?? result.params, 109));
      expect(Number.isFinite(drawing.stats.projectedGapCenter.x)).toBe(true);
      expect(clearance(drawing, 'ribbon-', drawing.stats.projectedSingularityCenter)).toBeGreaterThan(bound === 'min' ? 0 : 5);
    }
  }, 30000);
});
