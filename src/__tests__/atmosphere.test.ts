import { describe, expect, it } from 'vitest';
import {
  createAtmosphere,
  hatchAtmosphere,
  maskAtmospherePaths,
  type AtmosphereField,
  type AtmospherePoint,
} from '../../packages/plot-core/src/index.ts';

const bounds = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
const options = { bounds, seed: 42, depth: 1, scale: 18, clearRadius: 16 };

describe('atmosphere field', () => {
  it('is deterministic, seeded, bounded, edge concentrated, and center clear', () => {
    const a = createAtmosphere(options);
    const b = createAtmosphere(options);
    const c = createAtmosphere({ ...options, seed: 43 });
    const samples = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 8 }));
    expect(samples.map(a)).toEqual(samples.map(b));
    expect(samples.map(a)).not.toEqual(samples.map(c));
    for (const p of samples) expect(a(p)).toBeGreaterThanOrEqual(0);
    for (const p of samples) expect(a(p)).toBeLessThanOrEqual(1);
    expect(a({ x: 50, y: 50 })).toBe(0);
    expect(a({ x: 0, y: 10 })).toBeGreaterThan(a({ x: 50, y: 50 }));
    expect(a({ x: -1, y: 10 })).toBe(0);
  });

  it('makes deeper structure monotonically more obscured', () => {
    const near = createAtmosphere({ ...options, depth: 0.25 });
    const far = createAtmosphere({ ...options, depth: 0.9 });
    for (let x = 0; x <= 100; x += 5) {
      for (let y = 0; y <= 100; y += 5) {
        expect(far({ x, y })).toBeGreaterThanOrEqual(near({ x, y }));
      }
    }
    expect(createAtmosphere({ ...options, depth: 0 })({ x: 0, y: 0 })).toBe(0);
  });

  it('snapshots caller-owned bounds and center and rejects unrepresentable scales', () => {
    const mutableBounds = { ...bounds };
    const center = { x: 50, y: 50 };
    const field = createAtmosphere({ ...options, bounds: mutableBounds, center });
    const before = field({ x: 0, y: 10 });
    mutableBounds.xMin = 20;
    center.x = 0;
    expect(field({ x: 0, y: 10 })).toBe(before);
    expect(field.bounds).toEqual(bounds);
    expect(() => createAtmosphere({ ...options, scale: 1e-310 })).toThrow(RangeError);
    expect(() => createAtmosphere({ ...options, bounds: { xMin: -1e308, xMax: 1e308, yMin: 0, yMax: 100 } })).toThrow(RangeError);
  });
});

describe('partial path visibility', () => {
  const band = ((p: AtmospherePoint) => p.x >= 40 && p.x <= 60 ? 1 : 0) as AtmosphereField;

  it('returns exact original geometry and identity when amount is zero', () => {
    const paths = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]];
    expect(maskAtmospherePaths(paths, band, { amount: 0 })).toBe(paths);
    expect(paths[0]).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('samples a long two-point segment and never bridges the concealed interval', () => {
    const paths = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]];
    const masked = maskAtmospherePaths(paths, band, { amount: 1, sampleStep: 2 });
    expect(masked).toHaveLength(2);
    expect(masked[0][0]).toEqual(paths[0][0]);
    expect(masked[1].at(-1)).toEqual(paths[0][1]);
    expect(masked[0].at(-1)!.x).toBeLessThan(41);
    expect(masked[1][0].x).toBeGreaterThan(59);
    expect(masked[1][0].x - masked[0].at(-1)!.x).toBeGreaterThan(18);
    expect(paths[0]).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(maskAtmospherePaths(paths, band, { amount: 1, depth: 0 })).toBe(paths);
  });

  it('keeps closed-path runs joined across their original seam without closing over fog', () => {
    const ring = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }];
    const output = maskAtmospherePaths([ring], band, { amount: 1, sampleStep: 2 });
    expect(output).toHaveLength(2);
    for (const path of output) {
      expect(path.length).toBeGreaterThan(1);
      for (let i = 1; i < path.length; i++) {
        expect(Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)).toBeLessThanOrEqual(2.1);
      }
    }
    expect(output.some((path) => path.some((p) => p.x === 0 && p.y === 0))).toBe(true);
  });

  it('is spatially consistent across neighboring strokes and independent of path order', () => {
    const field = createAtmosphere({ ...options, clearRadius: 0 });
    const a = [{ x: 0, y: 8 }, { x: 100, y: 8 }];
    const b = [{ x: 0, y: 9 }, { x: 100, y: 9 }];
    const one = maskAtmospherePaths([a, b], field, { amount: 1, sampleStep: 1 });
    const separate = [
      ...maskAtmospherePaths([a], field, { amount: 1, sampleStep: 1 }),
      ...maskAtmospherePaths([b], field, { amount: 1, sampleStep: 1 }),
    ];
    expect(one).toEqual(separate);
  });

  it('has visible midrange occlusion without re-randomizing geometry', () => {
    const field = createAtmosphere({ ...options, depth: 0.58, clearRadius: 0 });
    const path = [{ x: 0, y: 8 }, { x: 100, y: 8 }];
    const masked = maskAtmospherePaths([path], field, { amount: 0.55, sampleStep: 1 });
    const retained = masked.reduce((sum, line) => sum + line.reduce((distance, p, i) =>
      i === 0 ? distance : distance + Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y), 0), 0);
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(100);
    expect(masked).toEqual(maskAtmospherePaths([path], field, { amount: 0.55, sampleStep: 1 }));
  });
});

describe('hatch atmosphere', () => {
  it('makes deterministic finite pen marks only at cloud shoulders', () => {
    const field = ((p: AtmospherePoint) => p.x / 100) as AtmosphereField;
    const hatch = hatchAtmosphere(bounds, field, { spacing: 5, angle: 0.55 });
    expect(hatch).toEqual(hatchAtmosphere(bounds, field, { spacing: 5, angle: 0.55 }));
    expect(hatch.length).toBeGreaterThan(0);
    expect(hatch.length).toBeLessThan(100);
    for (const path of hatch) {
      expect(path.length).toBeGreaterThanOrEqual(2);
      for (const p of path) {
        expect(p.x).toBeGreaterThanOrEqual(bounds.xMin);
        expect(p.x).toBeLessThanOrEqual(bounds.xMax);
        expect(p.y).toBeGreaterThanOrEqual(bounds.yMin);
        expect(p.y).toBeLessThanOrEqual(bounds.yMax);
        expect(field(p)).toBeGreaterThanOrEqual(0.2);
        expect(field(p)).toBeLessThanOrEqual(0.68);
      }
    }
    expect(hatchAtmosphere(bounds, (() => 0) as AtmosphereField, { spacing: 5, angle: 0 })).toEqual([]);
  });

  it('follows curved cloud shoulders and makes pitch alter contour density', () => {
    const page = { xMin: 0, yMin: 0, xMax: 279.4, yMax: 431.8 };
    const field = createAtmosphere({ bounds: page, seed: 211, depth: 0.72, scale: 36,
      center: { x: 140, y: 215 }, clearRadius: 30 });
    const dense = hatchAtmosphere(page, field, { spacing: 1.2, angle: 0.55 });
    const sparse = hatchAtmosphere(page, field, { spacing: 4, angle: 0.55 });
    expect(dense.length).toBeGreaterThan(sparse.length * 2);
    expect(dense.some((path) => path.length > 3 && Math.abs(
      (path[1].x - path[0].x) * (path.at(-1)!.y - path[0].y) -
      (path[1].y - path[0].y) * (path.at(-1)!.x - path[0].x),
    ) > 0.01)).toBe(true);
  });

  it('connects ambiguous marching-square crossings around the low corners', () => {
    const saddle = Object.assign(
      (p: AtmospherePoint) => 0.1 + 0.7 * p.x + 0.7 * p.y - 1.4 * p.x * p.y,
      { scale: 1, seed: 0 },
    ) as AtmosphereField;
    const output = hatchAtmosphere({ xMin: 0, yMin: 0, xMax: 1, yMax: 1 }, saddle,
      { spacing: 0.1, angle: -Math.PI / 4, sampleStep: 1, minLength: 0 });
    const aroundTopLeft = output.find((path) => path.length === 2 &&
      Math.abs(path[0].x - 0.4214285714) < 1e-4 && path[0].y === 0);
    expect(aroundTopLeft).toBeDefined();
    expect(aroundTopLeft![1].x).toBe(0);
    expect(aroundTopLeft![1].y).toBeCloseTo(0.4214285714);
  });

  it('rejects nonfinite settings and bounds pathological work before allocation', () => {
    expect(() => createAtmosphere({ ...options, scale: 0 })).toThrow(RangeError);
    expect(() => createAtmosphere({ ...options, depth: 2 })).toThrow(RangeError);
    expect(() => maskAtmospherePaths([[{ x: 0, y: 0 }, { x: 1e7, y: 0 }]],
      (() => 0) as AtmosphereField, { amount: 1, sampleStep: 1 })).toThrow(/sample limit/);
    expect(() => hatchAtmosphere(bounds, (() => 0.5) as AtmosphereField,
      { spacing: 0.0001, angle: 0, sampleStep: 0.0001 })).toThrow(/grid limit/);
  });
});
