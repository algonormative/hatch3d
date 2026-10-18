import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Tube, pinstripeTube, silhouettes, type ToneEnv } from '../../sketches/kit/mannequin/index.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A straight cylinder up y; section x faces +x (v = 0) and y faces +z (v = 0.25). */
const cylinder = (facets = 0, mask?: (u: number, v: number) => boolean) =>
  new Tube('cyl', [V(0, -2, 0), V(0, 0, 0), V(0, 2, 0)], [[0, 1, 1], [1, 1, 1]], V(0, 0, 1), 1, [0, 0], mask, facets);
/** Looking straight down -z, nudged so no outline sits exactly on a sample. */
const side = V(0.013, 0, -1).normalize();
const env: ToneEnv = { screen: p => ({ x: p.x * 10, y: p.y * 10 }), dark: () => 1, density: 0.5 };

describe('mannequin tube', () => {
  it('lays sections round the spine and points the normal outward', () => {
    const t = cylinder();
    expect(t.length).toBeCloseTo(4, 3);
    for (const [u, v] of [[0.3, 0], [0.5, 0.25], [0.7, 0.5], [0.4, 0.8]]) {
      const p = t.point(u, v);
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(1, 3);
      const out = p.clone().sub(t.centre(u)).normalize();
      expect(t.normal(u, v).dot(out)).toBeGreaterThan(0.99);
    }
    expect(t.point(0.5, 0, 0.2).x).toBeCloseTo(1.2, 3);
  });

  it('gives a facet one normal along its whole width', () => {
    const t = cylinder(6);
    const a = t.normal(0.5, 0.02), b = t.normal(0.5, 0.08), c = t.normal(0.5, 0.15);
    expect(a.distanceTo(b)).toBeLessThan(1e-4);
    expect(a.distanceTo(c)).toBeLessThan(1e-4);
    // The next plane faces a different way.
    expect(a.dot(t.normal(0.5, 0.25))).toBeLessThan(0.9);
  });

  it('traces the two edge-on curves of a cylinder seen side-on', () => {
    const t = cylinder();
    const out = silhouettes(t, { forward: side });
    expect(out.length).toBe(2);
    for (const s of out) {
      expect(s.ink).toBe('vermilion');
      expect(s.group).toBe('contour');
      expect(s.family).toBeUndefined();
      expect(s.points.length).toBeGreaterThan(100);
      expect(Math.abs(Math.abs(s.points[0].x) - 1)).toBeLessThan(0.05);
    }
    const tagged = silhouettes(t, { forward: side }, { ink: 'carbon', group: 'edge', family: 'edge' });
    expect(tagged.every(s => s.ink === 'carbon' && s.group === 'edge' && s.family === 'edge')).toBe(true);
  });

  it('keeps cut outlines on plane edges for a faceted body', () => {
    const out = silhouettes(cylinder(6), { forward: side });
    expect(out.length).toBeGreaterThan(0);
  });

  it('draws pinstripes only where the mask leaves cloth', () => {
    const open = pinstripeTube(cylinder(), env, { seams: [0.5], hems: [0.1] });
    expect(open.some(s => s.points.some(p => p.z > 0.5))).toBe(true);
    // Cloth only on the v >= 0.5 half, the side facing -z.
    const half = pinstripeTube(cylinder(0, (_u, v) => v >= 0.5), env, { seams: [0.5], hems: [0.1] });
    expect(half.length).toBeGreaterThan(0);
    for (const s of half) for (const p of s.points) expect(p.z).toBeLessThan(1e-6);
  });

  it('holds the stripes the env\'s minimum apart, and as far off the plane edges and seams ruled among them', () => {
    // Seen down -z at 10 mm a unit: a stripe at angle a round the six-faceted cylinder lies at x = cos(a) on the sheet.
    const t = cylinder(6), min = 1.2;
    const turn = (x: number, z: number) => ((Math.atan2(z, x) / (2 * Math.PI)) % 1 + 1) % 1;
    const sheetX = (v: number) => 10 * t.point(0.5, v).x;
    /** The stripes' places round the tube (constant v, along the spine), on the front half (z > 0). */
    const stripes = (e: ToneEnv) => pinstripeTube(t, e, { seams: [0.15], hems: [] })
      .filter(s => (s.ink === 'ultramarine' || s.ink === 'violet') && s.group === 'figure' && Math.abs(s.points[0].y - s.points.at(-1)!.y) > 0.5)
      .map(s => turn(s.points[0].x, s.points[0].z)).filter(v => v > 0.02 && v < 0.48);
    const seam = turn(...(() => { const s = pinstripeTube(t, env, { seams: [0.15], hems: [] }).find(q => q.group === 'contour' && q.ink === 'vermilion')!; return [s.points[0].x, s.points[0].z] as const; })());
    const ruled = [0, 1, 2, 3].map(k => k / 6).concat(seam).sort((a, b) => a - b);
    /** Least sheet distance from a stripe to the ruled lines either side of it. */
    const offRuled = (v: number) => {
      const k = ruled.findIndex(r => r >= v);
      return Math.min(...[ruled[k - 1], ruled[k]].map(r => Math.abs(sheetX(v) - sheetX(r))));
    };
    const plain = stripes(env), held = stripes({ ...env, min });
    expect(held.length).toBeGreaterThan(4);
    expect(Math.min(...plain.map(offRuled))).toBeLessThan(min);
    for (const v of held) expect(offRuled(v)).toBeGreaterThanOrEqual(min - 1e-6);
    // Neighbours on one plane, as far apart on the sheet.
    const sorted = [...held].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (Math.floor(sorted[i] * 6) === Math.floor(sorted[i - 1] * 6)) expect(Math.abs(sheetX(sorted[i]) - sheetX(sorted[i - 1]))).toBeGreaterThanOrEqual(min - 0.05);
    }
  });
});
