import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipToRect, keepAlong, pathLength, simplify } from '../../sketches/kit/page.ts';
import { clamp, n, smooth } from '../../sketches/kit/params.ts';
import { atPage, horizonCamera, onGround, pageOf } from '../../sketches/kit/perspective.ts';
import { barPattern, restPattern } from '../../sketches/kit/rhythm.ts';
import { PartBuckets, scalePoints } from '../../sketches/kit/strokes.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const page = { width: 279.4, height: 431.8 };
const HORIZON_Y = 250;
const view = horizonCamera({
  fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600,
  page, depth: { width: 559, height: 864 }, horizonY: HORIZON_Y,
});

describe('sketch kit: params', () => {
  it('reads a clamped number, falling back for anything else', () => {
    const ctx = sketchContext(1, { a: 5, b: -3, c: 'x', d: NaN });
    expect(n(ctx, 'a', 1, 0, 2)).toBe(2);
    expect(n(ctx, 'b', 1, 0, 2)).toBe(0);
    expect(n(ctx, 'c', 1, 0, 2)).toBe(1);
    expect(n(ctx, 'd', 1, 0, 2)).toBe(1);
    expect(n(ctx, 'missing', 7, 0, 10)).toBe(7);
  });

  it('clamps and smoothsteps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(smooth(0, 1, -1)).toBe(0);
    expect(smooth(0, 1, 0.5)).toBe(0.5);
    expect(smooth(2, 4, 9)).toBe(1);
  });
});

describe('sketch kit: page', () => {
  const box = { x0: 0, x1: 10, y0: 0, y1: 10 };

  it('clips a polyline to a rectangle, splitting where it leaves', () => {
    expect(clipToRect([{ x: -5, y: 5 }, { x: 15, y: 5 }], box)).toEqual([[{ x: 0, y: 5 }, { x: 10, y: 5 }]]);
    expect(clipToRect([{ x: -5, y: -5 }, { x: -1, y: 20 }], box)).toEqual([]);
    const runs = clipToRect([{ x: 2, y: 5 }, { x: 12, y: 5 }, { x: 12, y: 8 }, { x: 5, y: 8 }], box);
    expect(runs).toEqual([[{ x: 2, y: 5 }, { x: 10, y: 5 }], [{ x: 10, y: 8 }, { x: 5, y: 8 }]]);
    // A single point yields no run.
    expect(clipToRect([{ x: 5, y: 5 }], box)).toEqual([]);
  });

  it('keeps the stretches a test allows and carries arclength to it', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const runs = keepAlong(line, (_, at) => at % 4 < 2, 0.5);
    expect(runs.length).toBe(3);
    expect(runs.map(r => [r[0].x, r.at(-1)!.x])).toEqual([[0, 2], [4, 6], [8, 10]]);
    expect(keepAlong(line, () => false)).toEqual([]);
  });

  it('simplifies collinear points and measures length', () => {
    const path = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }];
    expect(simplify(path)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 5 }])).toBe(6);
  });
});

describe('sketch kit: horizon camera', () => {
  it('puts the vanishing line of the ground on the horizon', () => {
    // Directions parallel to the ground meet at infinity, on the horizon, whatever their heading.
    for (const dir of [[0, 0, -1], [3, 0, -1], [-1, 0, -2]]) {
      const far = view.position.clone().addScaledVector(new THREE.Vector3(...dir).normalize(), 1e5);
      const q = new THREE.Vector3(...far.toArray()).project(view);
      expect((-q.y * 0.5 + 0.5) * page.height).toBeCloseTo(HORIZON_Y, 2);
    }
    // The straight-ahead point lands on the page's centre line.
    expect(pageOf(view, atPage(view, { x: page.width / 2, y: HORIZON_Y }, 50), page).x).toBeCloseTo(page.width / 2, 6);
  });

  it('round-trips between page and world', () => {
    for (const p of [{ x: 50, y: 60 }, { x: 140, y: 250 }, { x: 200, y: 400 }]) {
      const back = pageOf(view, atPage(view, p, 37, page), page);
      expect(back.x).toBeCloseTo(p.x, 4);
      expect(back.y).toBeCloseTo(p.y, 4);
    }
  });

  it('puts a page point below the horizon on the ground plane', () => {
    for (const p of [{ x: 140, y: 300 }, { x: 40, y: 420 }]) {
      const g = onGround(view, p, page);
      expect(g.y).toBeCloseTo(0, 6);
      expect(g.z).toBeLessThan(0);
      const back = pageOf(view, g, page);
      expect(back.x).toBeCloseTo(p.x, 4);
      expect(back.y).toBeCloseTo(p.y, 4);
    }
  });
});

describe('sketch kit: rhythm', () => {
  it('draws one value per step for a rest pattern', () => {
    let draws = 0;
    const pattern = restPattern(() => { draws++; return 0.5; }, 0.6);
    expect(pattern.length).toBe(64);
    expect(draws).toBe(64);
    expect(pattern.every(Boolean)).toBe(true);
  });

  it('always rests the last step of a bar, drawing nothing for it', () => {
    let draws = 0;
    const pattern = barPattern(() => { draws++; return 0; }, 0.5);
    expect(pattern.filter((_, k) => k % 8 === 7).some(Boolean)).toBe(false);
    expect(pattern.filter((_, k) => k % 8 !== 7).every(Boolean)).toBe(true);
    expect(draws).toBe(56);
  });
});

describe('sketch kit: part buckets', () => {
  const line = (length: number) => [{ x: 0, y: 0 }, { x: length, y: 0 }];

  it('orders parts by group then ink and skips empty buckets', () => {
    const b = new PartBuckets();
    b.add('helix-acid', line(5));
    b.add('system-violet', line(5));
    b.add('system-carbon', line(5));
    b.add('helix-carbon', line(5));
    const parts = b.toParts(['system', 'helix', 'slogan'], ['carbon', 'acid', 'violet']);
    expect(parts.map(p => p.id)).toEqual(['system-carbon', 'system-violet', 'helix-carbon', 'helix-acid']);
    expect(parts[1]).toMatchObject({ pen: 'violet' });
  });

  it('drops paths at or under the minimum length, with a lower floor for exact marks', () => {
    const b = new PartBuckets(0.4);
    expect(b.add('a-carbon', line(0.4))).toBe(false);
    expect(b.add('a-carbon', line(0.41))).toBe(true);
    expect(b.add('a-carbon', line(0.1), true)).toBe(true);
    expect(b.add('a-carbon', line(0.04), true)).toBe(false);
    expect(b.add('a-carbon', line(0.45), false, 0.5)).toBe(false);
    expect(b.add('a-carbon', [{ x: 0, y: 0 }], true)).toBe(false);
    expect(b.get('a-carbon')!.length).toBe(2);
  });

  it('simplifies ordinary paths and keeps exact ones whole', () => {
    const b = new PartBuckets();
    const path = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }];
    b.add('s-carbon', path);
    b.add('t-carbon', path, true);
    expect(b.get('s-carbon')![0].length).toBe(2);
    expect(b.get('t-carbon')![0].length).toBe(3);
  });

  it('scales points', () => {
    expect(scalePoints([{ x: 1, y: 2 }], 3, 4)).toEqual([{ x: 3, y: 8 }]);
  });
});
