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
});
