import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { ART, buildAssembly, drawNova, insideAny, sourceOf } from '../../sketches/load-bearing-silence-nova/geometry.ts';
import { mulberry32 } from '../utils/prng.ts';
import type { Params, Part, Point, SketchContext } from '../sketch/types.ts';

const entry = resolve('sketches/load-bearing-silence-nova/sketch.ts');
const SEED = 9;
const paths = (parts: Part[], id: string) => parts.filter(part => part.id === id).flatMap(part => part.paths);

function context(params: Params, seed = SEED): SketchContext {
  return {
    params, seed, assets: {},
    random(id: string) {
      return mulberry32(createHash('sha256').update(`${seed}\0${id}`).digest().readUInt32LE(0));
    },
  };
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const squared = dx * dx + dy * dy;
  const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / squared));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

/** Ray marks crossing a circle of `radius` about `center`, within an angular window. */
function arcCrossings(rays: Point[][], center: Point, radius: number, mid: number, half: number): number {
  let count = 0;
  for (const path of rays) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const ra = Math.hypot(a.x - center.x, a.y - center.y), rb = Math.hypot(b.x - center.x, b.y - center.y);
    if ((ra - radius) * (rb - radius) > 0) continue;
    const t = (radius - ra) / (rb - ra || 1);
    const angle = Math.atan2(a.y + (b.y - a.y) * t - center.y, a.x + (b.x - a.x) * t - center.x);
    if (Math.abs(Math.atan2(Math.sin(angle - mid), Math.cos(angle - mid))) <= half) count++;
  }
  return count;
}

function angularSpan(center: Point, polygon: Point[]) {
  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length, cy = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
  const mid = Math.atan2(cy - center.y, cx - center.x);
  const offsets = polygon.map(p => Math.atan2(Math.sin(Math.atan2(p.y - center.y, p.x - center.x) - mid), Math.cos(Math.atan2(p.y - center.y, p.x - center.x) - mid)));
  const radii = polygon.map(p => Math.hypot(p.x - center.x, p.y - center.y));
  const low = Math.min(...offsets), high = Math.max(...offsets);
  return { mid: mid + (low + high) / 2, half: (high - low) / 2, near: Math.min(...radii), far: Math.max(...radii) };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe('Load Bearing Silence / Nova', () => {
  it('is deterministic, abstract by default, and differs between seeds', async () => {
    const first = await renderSketch({ entry, seed: SEED });
    const again = await renderSketch({ entry, seed: SEED });
    const other = await renderSketch({ entry, seed: 4 });
    expect(first.identity).toBe(again.identity);
    expect(first.parts).toEqual(again.parts);
    expect(first.diagnostics).toEqual([]);
    expect(first.parts.some(part => part.id.startsWith('poster-'))).toBe(false);
    expect(paths(other.parts, 'panel-carbon')).not.toEqual(paths(first.parts, 'panel-carbon'));
    expect(paths(other.parts, 'ray-cyan')).not.toEqual(paths(first.parts, 'ray-cyan'));
    // Carbon panels, cyan rays, and at most two sparse accents.
    expect(first.metadata.pens.map(pen => pen.id)).toEqual(['carbon', 'cyan', 'vermilion', 'gold']);
    expect(paths(first.parts, 'panel-carbon').length).toBeGreaterThan(100);
    expect(paths(first.parts, 'ray-cyan').length).toBeGreaterThan(150);
    expect(paths(first.parts, 'tear-vermilion').length).toBeGreaterThan(0);
    const accents = paths(first.parts, 'tear-vermilion').length + paths(first.parts, 'ray-gold').length;
    expect(accents).toBeLessThan(paths(first.parts, 'ray-cyan').length * 0.25);
  }, 30000);

  it('keeps finite marks inside the content area and within the plot budget', async () => {
    for (const seed of [1, 4, SEED, 23]) {
      const result = await renderSketch({ entry, seed });
      for (const part of result.parts) for (const path of part.paths) {
        expect(path.length).toBeGreaterThanOrEqual(2);
        for (const point of path) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(point.x).toBeGreaterThanOrEqual(ART.xMin - 1e-9);
          expect(point.x).toBeLessThanOrEqual(ART.xMax + 1e-9);
          expect(point.y).toBeGreaterThanOrEqual(ART.yMin - 1e-9);
          expect(point.y).toBeLessThanOrEqual(ART.yMax + 1e-9);
        }
      }
      expect(result.stats.pathCount).toBeLessThanOrEqual(6000);
      expect(result.stats.lengthMm).toBeLessThanOrEqual(80_000);
    }
  }, 60000);

  it('reproduces the render from the geometry and leaves the glare disc unmarked', async () => {
    const result = await renderSketch({ entry, seed: SEED });
    const scene = drawNova(context(result.effectiveParams ?? result.params));
    // The runner rounds to micrometres; otherwise the geometry is the render.
    for (const part of scene.parts) {
      const rendered = paths(result.parts, part.id);
      expect(rendered.map(path => path.length)).toEqual(part.paths.map(path => path.length));
      part.paths.forEach((path, i) => path.forEach((point, k) => {
        expect(Math.abs(point.x - rendered[i][k].x)).toBeLessThan(6e-4);
        expect(Math.abs(point.y - rendered[i][k].y)).toBeLessThan(6e-4);
      }));
    }
    const center = scene.source.page;
    let nearest = Infinity;
    for (const part of scene.parts) for (const path of part.paths) for (let i = 1; i < path.length; i++) {
      nearest = Math.min(nearest, distanceToSegment(center, path[i - 1], path[i]));
    }
    expect(scene.glareRadius).toBeGreaterThanOrEqual(20);
    expect(nearest).toBeGreaterThanOrEqual(scene.glareRadius - 1e-6);
  }, 30000);

  it('stops rays at panels and leaves fewer ray marks on the shadow side than on the lit side', () => {
    let lit = 0, shadow = 0, interrupted = 0;
    for (const seed of [1, 4, SEED]) {
      const scene = drawNova(context({}, seed));
      const rays = [...paths(scene.parts, 'ray-cyan'), ...paths(scene.parts, 'ray-gold')];
      const center = scene.source.page;
      // No ray mark is drawn across a panel silhouette.
      for (const path of rays) for (let i = 1; i < path.length; i++) {
        for (let k = 1; k < 8; k++) {
          const t = k / 8;
          const sample = { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t };
          expect(insideAny(sample, scene.silhouettes)).toBe(false);
        }
      }
      for (const silhouette of scene.silhouettes) {
        if (insideAny(center, [silhouette])) continue;
        const span = angularSpan(center, silhouette);
        if (span.half < 0.12 || span.near < scene.glareRadius + 20) continue;
        const window = span.half * 0.4;
        const before = arcCrossings(rays, center, span.near - 4, span.mid, window);
        const after = arcCrossings(rays, center, span.far + 8, span.mid, window);
        lit += before;
        shadow += after;
        // Rays that reached the panel and stop before it: same direction, two radii.
        interrupted += Math.max(0, before - after);
      }
    }
    expect(lit).toBeGreaterThan(20);
    expect(shadow).toBeLessThan(lit * 0.5);
    expect(interrupted).toBeGreaterThan(10);
  });

  it('flings nearer panels further and spins them more; strength and moment both grow the motion', () => {
    for (const seed of [1, 4, SEED, 23]) {
      const bodies = [...drawNova(context({}, seed)).bodies].sort((a, b) => a.distance - b.distance);
      const half = Math.floor(bodies.length / 2);
      const near = bodies.slice(0, half), far = bodies.slice(-half);
      expect(mean(near.map(b => b.displacement))).toBeGreaterThan(mean(far.map(b => b.displacement)) * 1.25);
      expect(mean(near.map(b => b.rotation))).toBeGreaterThan(mean(far.map(b => b.rotation)));
      expect(bodies[0].displacement).toBeGreaterThan(bodies[bodies.length - 1].displacement);
    }
    const run = (params: Params) => drawNova(context(params)).bodies;
    const calm = run({ blastStrength: 0.35 }), fierce = run({ blastStrength: 0.85 });
    const early = run({ moment: 0.25 }), late = run({ moment: 0.75 });
    calm.forEach((body, i) => {
      expect(fierce[i].displacement).toBeGreaterThan(body.displacement);
      expect(late[i].displacement).toBeGreaterThan(early[i].displacement);
    });
    expect(mean(fierce.map(b => b.rotation))).toBeGreaterThan(mean(calm.map(b => b.rotation)));
    expect(mean(late.map(b => b.rotation))).toBeGreaterThan(mean(early.map(b => b.rotation)));
    for (const body of run({ moment: 0 })) {
      expect(body.displacement).toBe(0);
      expect(body.rotation).toBe(0);
    }
  });

  it('keeps the intact assembly fixed while moment and strength change', () => {
    const reference = buildAssembly(context({}));
    for (const params of [{ moment: 0 }, { moment: 1 }, { blastStrength: 0.1 }, { blastStrength: 1, moment: 0.9 }, { sourceX: 0.2, sourceY: 0.7 }]) {
      expect(buildAssembly(context(params))).toEqual(reference);
      expect(drawNova(context(params)).assembly).toEqual(reference);
    }
    const before = drawNova(context({ moment: 0.3 })), after = drawNova(context({ moment: 0.7 }));
    expect(after.bodies.map(b => b.center)).not.toEqual(before.bodies.map(b => b.center));
    // The burst position belongs to the light, not the structure.
    expect(sourceOf(context({ sourceX: 0.2, sourceY: 0.7 })).page).toEqual({ x: ART.xMin + 0.2 * (ART.xMax - ART.xMin), y: ART.yMin + 0.7 * (ART.yMax - ART.yMin) });
  });
});
