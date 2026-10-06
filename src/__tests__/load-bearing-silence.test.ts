import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { drawBridge, gapField, lightRuns } from '../../sketches/load-bearing-silence/geometry.ts';
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
    }
    expect(count(first, 'ribbon-cyan')).toBeGreaterThan(0);
    expect(count(first, 'ribbon-cyan')).toBeGreaterThan(count(first, 'ribbon-coral') + count(first, 'ribbon-gold'));
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


  it('uses a coherent gap field and splits missing samples without bridging them', () => {
    const field = gapField(geometryContext({}, 211), 0.55);
    const repeated = gapField(geometryContext({}, 211), 0.55);
    const points = Array.from({ length: 401 }, (_, x) => ({ x, y: 80 }));
    expect(points.map(field)).toEqual(points.map(repeated));
    const near = points.reduce((sum, point) => sum + Math.abs(field(point) - field({ x: point.x, y: 81 })), 0);
    const far = points.reduce((sum, point) => sum + Math.abs(field(point) - field({ x: point.x, y: 125 })), 0);
    expect(near).toBeLessThan(far * 0.2);
    const runs = lightRuns(points, 0.7, field);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) for (let i = 1; i < run.length; i++) expect(run[i].x - run[i - 1].x).toBe(1);
    expect(runs.flat().length).toBeLessThan(points.length * 0.8);
    for (let i = 1; i < runs.length; i++) expect(runs[i][0].x - runs[i - 1].at(-1)!.x).toBeGreaterThan(1);
  });

  it('shades by line occupancy and lets each light family reach the frame without moving structure', async () => {
    const finishing = { border: { style: 'double' as const, pen: 'carbon', inset: 12, contentGap: 0 } };
    const base = { posterMode: 'abstract', singularityPower: 1, lightGapAmount: 0, ribbonShade: 0, ribbonEdgeReach: 0, rayEdgeReach: 0 };
    const uniform = await renderSketch({ entry, seed: 211, params: { ...base, ribbonShade: 0 }, finishing });
    const shaded = await renderSketch({ entry, seed: 211, params: { ...base, ribbonShade: 1 }, finishing });
    const length = (parts: typeof uniform.parts) => parts.flatMap(part => part.paths).reduce((total, path) =>
      total + path.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - path[i].x, point.y - path[i].y), 0), 0);
    expect(length(art(shaded, 'ribbon-'))).toBeLessThan(length(art(uniform, 'ribbon-')) * 0.9);
    expect(art(shaded, 'bridge-')).toEqual(art(uniform, 'bridge-'));
    const ribbonEdge = await renderSketch({ entry, seed: 211, params: { ...base, ribbonEdgeReach: 1, rayEdgeReach: 0 }, finishing });
    const rayEdge = await renderSketch({ entry, seed: 211, params: { ...base, ribbonEdgeReach: 0, rayEdgeReach: 1 }, finishing });
    const extent = (parts: typeof uniform.parts) => parts.flatMap(part => part.paths).flat();
    expect(Math.min(...extent(art(ribbonEdge, 'ribbon-')).map(point => point.y))).toBeLessThan(15);
    expect(Math.max(...extent(art(rayEdge, 'ray-')).map(point => point.y))).toBeGreaterThan(416);
    expect(art(ribbonEdge, 'bridge-')).toEqual(art(uniform, 'bridge-'));
    expect(art(rayEdge, 'bridge-')).toEqual(art(uniform, 'bridge-'));
    expect(art(ribbonEdge, 'ray-')).toEqual(art(uniform, 'ray-'));
    expect(art(rayEdge, 'ribbon-')).toEqual(art(uniform, 'ribbon-'));
    for (const result of [ribbonEdge, rayEdge]) for (const point of extent(result.parts.filter(part => part.id !== 'finishing-border'))) {
      expect(point.x).toBeGreaterThanOrEqual(14.25);
      expect(point.x).toBeLessThanOrEqual(265.15);
      expect(point.y).toBeGreaterThanOrEqual(14.25);
      expect(point.y).toBeLessThanOrEqual(417.55);
    }
  }, 30000);

  it('keeps lettered light below the header and above the footer at full frame reach', async () => {
    const result = await renderSketch({ entry, seed: 211, params: {
      posterMode: 'lettered', ribbonEdgeReach: 1, rayEdgeReach: 1, lightGapAmount: 0,
    }, finishing: { border: { style: 'double', pen: 'carbon', inset: 12, contentGap: 0 } } });
    const light = art(result, 'ribbon-').concat(art(result, 'ray-')).flatMap(part => part.paths).flat();
    expect(Math.min(...light.map(point => point.y))).toBeGreaterThan(70);
    expect(Math.max(...light.map(point => point.y))).toBeLessThan(380);
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
    for (const id of ['beamWidth', 'hatchPitch', 'portalScale', 'routeWarp', 'gapWidth', 'ribbonWidth', 'rayCount', 'rayLength', 'rayCurve', 'ribbonShade', 'lightGapAmount', 'lightGapScale', 'ribbonEdgeReach', 'rayEdgeReach', 'branchCount', 'branchReach']) {
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

  it('preserves zero-reach source geometry and grows independent structural modules toward the frame', async () => {
    const defaultGeometry = drawBridge(geometryContext({}, 211));
    const explicitOff = drawBridge(geometryContext({ structureReach: 0, fogEnabled: false }, 211));
    expect(explicitOff.parts).toEqual(defaultGeometry.parts);
    expect(explicitOff.stats).toEqual(defaultGeometry.stats);
    expect(explicitOff.parts.some(part => part.id.startsWith('extension-'))).toBe(false);

    const params = { posterMode: 'abstract', branchCount: 1, singularityPower: 0.75,
      ribbonEdgeReach: 1, rayEdgeReach: 0.8, fogEnabled: false };
    const short = await renderSketch({ entry, seed: 211, params: { ...params, structureReach: 0 } });
    const long = await renderSketch({ entry, seed: 211, params: { ...params, structureReach: 1 } });
    expect(count(short, 'extension-')).toBe(0);
    expect(count(long, 'extension-')).toBeGreaterThan(100);
    const extents = (parts: typeof long.parts) => {
      const points = parts.flatMap(part => part.paths).flat();
      return { xMin: Math.min(...points.map(point => point.x)), xMax: Math.max(...points.map(point => point.x)),
        yMin: Math.min(...points.map(point => point.y)), yMax: Math.max(...points.map(point => point.y)) };
    };
    const old = extents(art(long, 'bridge-'));
    const added = extents(art(long, 'extension-'));
    expect(added.xMin).toBeLessThan(old.xMin - 10);
    expect(added.xMax).toBeGreaterThan(old.xMax + 10);
    expect(added.yMin).toBeLessThan(old.yMin - 20);
    expect(added.yMax).toBeGreaterThan(old.yMax + 20);
    expect(long.stats.pointCount).toBeLessThan(200_000);
  }, 30000);

  it('veils camera-distant structure with coherent edge hatches while keeping named light and core clear', async () => {
    const base = { posterMode: 'abstract', structureReach: 1, branchCount: 1,
      singularityPower: 0.75, lightGapAmount: 0.48, ribbonEdgeReach: 1, rayEdgeReach: 0.8 };
    const clear = await renderSketch({ entry, seed: 211, params: { ...base, fogEnabled: false } });
    const veiled = await renderSketch({ entry, seed: 211, params: { ...base, fogEnabled: true,
      fogCoverage: 0.68, fogDepth: 0.65, fogScale: 0.65, fogHatchPitch: 3 } });
    const deep = await renderSketch({ entry, seed: 211, params: { ...base, fogEnabled: true,
      fogCoverage: 0.94, fogDepth: 0.9, fogScale: 0.8, fogHatchPitch: 2.2 } });
    for (const candidate of [veiled, deep]) {
      expect(art(candidate, 'ribbon-')).toEqual(art(clear, 'ribbon-'));
      expect(art(candidate, 'ray-')).toEqual(art(clear, 'ray-'));
      expect(count(candidate, 'fog-')).toBeGreaterThan(20);
      expect(art(candidate, 'extension-')).not.toEqual(art(clear, 'extension-'));
      expect(candidate.stats.pointCount).toBeLessThan(200_000);
      expect(candidate.diagnostics).toEqual([]);
    }
    expect(count(deep, 'extension-')).toBeGreaterThan(0);
    expect(count(deep, 'extension-')).toBeLessThan(count(veiled, 'extension-'));
    const deepDrawing = drawBridge(geometryContext({ ...base, fogEnabled: true,
      fogCoverage: 0.94, fogDepth: 0.9, fogScale: 0.8, fogHatchPitch: 2.2 }, 211));
    expect(clearance(deepDrawing, 'fog-', deepDrawing.stats.projectedSingularityCenter)).toBeGreaterThan(20);
  }, 30000);

  it('keeps maximum fog and outer reach finite inside the lettered art band at both cloud scales', async () => {
    const finishing = { border: { style: 'double' as const, pen: 'carbon', inset: 12, contentGap: 0 } };
    for (const fogScale of [0, 1]) {
      const params = { posterMode: 'lettered', structureReach: 1, fogEnabled: true,
        fogCoverage: 1, fogDepth: 1, fogScale, fogHatchPitch: 1.2,
        ribbonEdgeReach: 1, rayEdgeReach: 1 };
      const result = await renderSketch({ entry, seed: 211, params, finishing });
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeGreaterThan(1_000);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      expect(count(result, 'fog-')).toBeGreaterThan(0);
      for (const part of result.parts.filter(part => part.id.startsWith('extension-') || part.id.startsWith('fog-'))) {
        for (const path of part.paths) for (const point of path) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(point.x).toBeGreaterThanOrEqual(14.25);
          expect(point.x).toBeLessThanOrEqual(265.15);
          expect(point.y).toBeGreaterThan(70);
          expect(point.y).toBeLessThan(380);
        }
      }
      const drawing = drawBridge(geometryContext(params, 211));
      expect(clearance(drawing, 'fog-', drawing.stats.projectedSingularityCenter)).toBeGreaterThan(20);
    }
  }, 30000);
});
