import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { ART, clipOutsideDisc, drawSpan } from '../../sketches/load-bearing-silence-span/geometry.ts';
import { mulberry32 } from '../utils/prng.ts';
import type { Params, Part, Point, SketchContext } from '../sketch/types.ts';

const entry = resolve('sketches/load-bearing-silence-span/sketch.ts');
const finishing = { border: { style: 'double' as const, pen: 'carbon', inset: 12, contentGap: 6 } };
const PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'cyan', 'coral', 'gold'];

const art = (parts: Part[], prefix: string) => parts.filter(part => part.id.startsWith(prefix));
const count = (parts: Part[], prefix: string) => art(parts, prefix).reduce((total, part) => total + part.paths.length, 0);
const length = (path: Point[]) => path.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - path[i].x, point.y - path[i].y), 0);
const points = (parts: Part[]) => parts.flatMap(part => part.paths).flat();

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const squared = dx * dx + dy * dy;
  const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / squared));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

/** Nearest approach of any drawn segment to a point. */
function clearance(parts: Part[], center: Point): number {
  let nearest = Infinity;
  for (const part of parts) for (const path of part.paths) for (let i = 1; i < path.length; i++) {
    nearest = Math.min(nearest, distanceToSegment(center, path[i - 1], path[i]));
  }
  return nearest;
}

function geometryContext(params: Params, seed: number): SketchContext {
  return {
    params, seed, assets: {},
    random(id: string) {
      return mulberry32(createHash('sha256').update(`${seed}\0${id}`).digest().readUInt32LE(0));
    },
  };
}

describe('Load Bearing Silence: Span', () => {
  it('is deterministic, defaults to the abstract tall sheet, and draws with all eight pens', async () => {
    const first = await renderSketch({ entry, seed: 211 });
    const repeated = await renderSketch({ entry, seed: 211 });
    expect(first.identity).toBe(repeated.identity);
    expect(first.parts).toEqual(repeated.parts);
    expect(first.diagnostics).toEqual([]);
    expect(first.metadata.page).toEqual({ width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' });
    expect(first.metadata.pens.map(pen => pen.id)).toEqual(PENS);
    expect(first.parts.some(part => part.id.startsWith('poster-'))).toBe(false);
    for (const pen of PENS) expect(first.parts.filter(part => part.pen === pen).some(part => part.paths.length > 0)).toBe(true);
    for (const pen of ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet']) expect(count(first.parts, `bridge-${pen}`)).toBeGreaterThan(0);
    expect(count(first.parts, 'ribbon-cyan')).toBeGreaterThan(count(first.parts, 'ribbon-coral') + count(first.parts, 'ribbon-gold'));
    expect(count(first.parts, 'ray-cyan')).toBeGreaterThan(20);
    const other = await renderSketch({ entry, seed: 23 });
    expect(art(other.parts, 'bridge-')).not.toEqual(art(first.parts, 'bridge-'));
  }, 30000);

  it('keeps finite geometry inside the tall art window and within the physical budget', async () => {
    for (const seed of [211, 23, 3]) {
      const plain = await renderSketch({ entry, seed });
      for (const point of points(plain.parts)) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(ART.xMin - 1e-6);
        expect(point.x).toBeLessThanOrEqual(ART.xMax + 1e-6);
        expect(point.y).toBeGreaterThanOrEqual(ART.yMin - 1e-6);
        expect(point.y).toBeLessThanOrEqual(ART.yMax + 1e-6);
      }
      const framed = await renderSketch({ entry, seed, finishing });
      const paths = framed.parts.flatMap(part => part.paths);
      expect(paths.length).toBeLessThanOrEqual(8000);
      expect(paths.reduce((sum, path) => sum + length(path), 0)).toBeLessThanOrEqual(90_000);
      for (const point of points(framed.parts)) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(279.4);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(431.8);
      }
    }
  }, 60000);

  it('leaves the singularity core as open paper across seeds and control extremes', async () => {
    const cases: [Params, number][] = [
      [{ posterMode: 'abstract' }, 211], [{ posterMode: 'abstract' }, 23], [{ posterMode: 'abstract' }, 777],
      [{ posterMode: 'abstract', singularityPower: 1, coreRadius: 44, singularityX: 16, singularityY: -16, fogEnabled: true }, 3],
      [{ posterMode: 'abstract', coreRadius: 14, gapWidth: 0.12, lightGapAmount: 0, rayCount: 160 }, 41],
    ];
    for (const [params, seed] of cases) {
      const drawing = drawSpan(geometryContext(params, seed));
      const { projectedSingularityCenter: center, coreRadius } = drawing.stats;
      expect(clearance(drawing.parts, center)).toBeGreaterThanOrEqual(coreRadius - 1e-6);
      // The light approaches the core closely: the void is shaped by marks, not by an empty region of the page.
      expect(clearance(art(drawing.parts, 'ribbon-').concat(art(drawing.parts, 'ray-')), center)).toBeLessThan(coreRadius + 14);
    }
    // Same check on the rendered (identity-mapped) abstract sheet.
    const rendered = await renderSketch({ entry, seed: 211 });
    const drawing = drawSpan(geometryContext(rendered.effectiveParams ?? rendered.params, 211));
    expect(clearance(rendered.parts, drawing.stats.projectedSingularityCenter)).toBeGreaterThanOrEqual(drawing.stats.coreRadius - 1e-6);
  }, 30000);

  it('runs the broken span along the long diagonal with remnants in opposite corners', () => {
    for (const seed of [211, 23, 3, 628]) {
      const drawing = drawSpan(geometryContext({}, seed));
      const { projectedRouteStart: start, projectedRouteEnd: end, projectedGapCenter: gap } = drawing.stats;
      // Route anchors overshoot the frame at bottom-left and top-right.
      expect(start.x).toBeLessThan(ART.xMin + 6);
      expect(start.y).toBeGreaterThan(ART.yMax - 6);
      expect(end.x).toBeGreaterThan(ART.xMax - 6);
      expect(end.y).toBeLessThan(ART.yMin + 6);
      const bridge = points(art(drawing.parts, 'bridge-'));
      const near = (corner: Point) => Math.min(...bridge.map(point => Math.hypot(point.x - corner.x, point.y - corner.y)));
      expect(near({ x: ART.xMin, y: ART.yMax })).toBeLessThan(25);
      expect(near({ x: ART.xMax, y: ART.yMin })).toBeLessThan(25);
      // Off-diagonal corners stay open (the lower-right one only receives the soft branch growth).
      expect(near({ x: ART.xMin, y: ART.yMin })).toBeGreaterThan(60);
      expect(near({ x: ART.xMax, y: ART.yMax })).toBeGreaterThan(40);
      // The missing span sits mid-sheet and the structure is a corner-to-corner presence.
      expect(Math.abs(gap.x - (ART.xMin + ART.xMax) / 2)).toBeLessThan(35);
      expect(Math.abs(gap.y - (ART.yMin + ART.yMax) / 2)).toBeLessThan(45);
      const ys = bridge.map(point => point.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.9 * (ART.yMax - ART.yMin));
    }
  });

  it('sends rays and ribbon toward the inner frame, governed by the reach controls', async () => {
    const reachOf = (parts: Part[]) => Math.min(...points(parts).map(point =>
      Math.min(point.x - ART.xMin, ART.xMax - point.x, point.y - ART.yMin, ART.yMax - point.y)));
    const drawing = drawSpan(geometryContext({}, 211));
    const center = drawing.stats.projectedSingularityCenter;
    const rays = art(drawing.parts, 'ray-');
    expect(reachOf(rays)).toBeLessThan(2);
    expect(reachOf(art(drawing.parts, 'ribbon-'))).toBeLessThan(2);
    // Several distinct rays end close to the frame, not a single stray.
    const framed = rays.flatMap(part => part.paths).filter(path => {
      const last = path.at(-1)!, first = path[0];
      return Math.min(...[first, last].map(point => Math.min(point.x - ART.xMin, ART.xMax - point.x, point.y - ART.yMin, ART.yMax - point.y))) < 8;
    });
    expect(framed.length).toBeGreaterThan(10);
    const farthest = (parts: Part[]) => Math.max(...points(parts).map(point => Math.hypot(point.x - center.x, point.y - center.y)));
    const short = drawSpan(geometryContext({ rayEdgeReach: 0, ribbonEdgeReach: 0 }, 211));
    expect(farthest(art(short.parts, 'ray-'))).toBeLessThan(farthest(rays));
    expect(art(short.parts, 'bridge-')).toEqual(art(drawing.parts, 'bridge-'));
  });

  it('keeps independent light toggles and leaves the structure alone', async () => {
    const base = await renderSketch({ entry, seed: 211 });
    const noRibbon = await renderSketch({ entry, seed: 211, params: { ribbonEnabled: false } });
    const noRays = await renderSketch({ entry, seed: 211, params: { raysEnabled: false } });
    expect(count(noRibbon.parts, 'ribbon-')).toBe(0);
    expect(count(noRays.parts, 'ray-')).toBe(0);
    expect(count(noRibbon.parts, 'ray-')).toBeGreaterThan(0);
    expect(count(noRays.parts, 'ribbon-')).toBeGreaterThan(0);
    expect(art(noRibbon.parts, 'bridge-')).toEqual(art(base.parts, 'bridge-'));
    expect(art(noRays.parts, 'bridge-')).toEqual(art(base.parts, 'bridge-'));
  }, 30000);

  it('fits the lettered layout between header and footer', async () => {
    const result = await renderSketch({ entry, seed: 211, params: { posterMode: 'lettered' }, finishing });
    expect(result.diagnostics).toEqual([]);
    expect(result.parts.some(part => part.id === 'poster-title')).toBe(true);
    const drawn = points(result.parts.filter(part => /^(bridge|ribbon|ray)-/.test(part.id)));
    expect(Math.min(...drawn.map(point => point.y))).toBeGreaterThan(70);
    expect(Math.max(...drawn.map(point => point.y))).toBeLessThan(380);
  }, 30000);

  it('renders finite geometry at every slider bound', async () => {
    const metadata = await inspectSketch({ entry });
    expect(metadata.controls.find(control => control.id === 'posterMode')).toMatchObject({ default: 'abstract' });
    for (const id of ['spanAngle', 'remnantMass', 'coreRadius', 'gapWidth', 'beamWidth', 'rayEdgeReach', 'ribbonEdgeReach']) {
      expect(metadata.controls.find(control => control.id === id)?.type).toBe('slider');
    }
    for (const bound of ['min', 'max'] as const) {
      const params = Object.fromEntries(metadata.controls.map(control => [control.id, control.type === 'slider' ? control[bound] : control.default]));
      const result = await renderSketch({ entry, seed: 109, params });
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pointCount).toBeGreaterThan(1_000);
      for (const point of points(result.parts)) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      const drawing = drawSpan(geometryContext(result.effectiveParams ?? result.params, 109));
      expect(clearance(drawing.parts, drawing.stats.projectedSingularityCenter)).toBeGreaterThanOrEqual(drawing.stats.coreRadius - 1e-6);
    }
  }, 60000);

  it('cuts polylines exactly at the core circle', () => {
    const center = { x: 0, y: 0 };
    const through = clipOutsideDisc([{ x: -10, y: 0 }, { x: 10, y: 0 }], center, 4);
    expect(through).toHaveLength(2);
    expect(through[0].at(-1)!.x).toBeCloseTo(-4, 9);
    expect(through[1][0].x).toBeCloseTo(4, 9);
    expect(clipOutsideDisc([{ x: -1, y: 0 }, { x: 1, y: 0 }], center, 4)).toEqual([]);
    expect(clipOutsideDisc([{ x: -10, y: 5 }, { x: 10, y: 5 }], center, 4)).toHaveLength(1);
    const exiting = clipOutsideDisc([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 5, y: 10 }], center, 4);
    expect(exiting).toHaveLength(1);
    expect(exiting[0][0].y).toBeCloseTo(4, 9);
  });
});
