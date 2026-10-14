import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { agentFigure } from '../../sketches/kit/agent.ts';
import { TIER, toneField } from '../../sketches/kit/mannequin/hatch.ts';
import { Tube, silhouettes } from '../../sketches/kit/mannequin/tube.ts';
import { fitDepthRange } from '../../sketches/kit/perspective.ts';
import { slabGeometry, solid } from '../../sketches/kit/slabs.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('sketch kit: zoomed agent, opt-in fixes', () => {
  it('fits the depth range from the exact vertex depths on request, and leaves the default sphere fit as it was', () => {
    // A tall slab 140 to 160 ahead of a camera 100 up its side: the camera is inside the slab's bounding sphere (radius
    // about 200.5, centre 180 from the eye) but well clear of the slab.
    const slab = slabGeometry(solid(0, 200, -150, 20, 400, 20, 0, 'stack'));
    const camera = () => {
      const c = new THREE.PerspectiveCamera(50, 0.65, 1, 5000);
      c.position.set(0, 100, 0);
      c.lookAt(0, 100, -1000);
      return c;
    };
    // The default reads the sphere: its near falls to the 0.5 floor, its far is the sphere's far side.
    const sphere = camera();
    fitDepthRange(sphere, [slab]);
    expect(sphere.near).toBe(0.5);
    expect(sphere.far).toBeCloseTo((150 + Math.hypot(10, 200, 10)) * 1.1, 4);
    // Exact: the slab's near face is 140 ahead and its far face 160, and the slack is the same fraction either side.
    const exact = camera();
    fitDepthRange(exact, [slab], 0.1, { exact: true });
    expect(exact.near).toBeCloseTo(140 * 0.9, 4);
    expect(exact.far).toBeCloseTo(160 * 1.1, 4);
    // A geometry at hand's reach of the eye cannot pull near under far / 1000, and a vertex behind the eye is ignored.
    const wide = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.01, 1, 0, -1000, 0, 1, -1000, 0, 0, 50], 3));
    const reach = new THREE.PerspectiveCamera(50, 0.65, 1, 5000);
    fitDepthRange(reach, [wide], 0.1, { exact: true });
    expect(reach.far).toBeCloseTo(1000 * 1.1, 3);
    expect(reach.near).toBeCloseTo(reach.far / 1000, 6);
  });

  it('traces a tube\'s silhouettes against the ray from the eye when one is given, and against the parallel direction otherwise', () => {
    // A unit cylinder up y, section x facing +x (v = 0) and y facing +z (v = 0.25), seen from 5 away, off-axis.
    const cylinder = new Tube('cyl', [V(0, -2, 0), V(0, 0, 0), V(0, 2, 0)], [[0, 1, 1], [1, 1, 1]], V(0, 0, 1), 1, [0, 0]);
    const eye = V(3, 0, 4), toward = eye.clone().negate().normalize();
    // The tangent points from the eye are at the eye's bearing, plus and minus acos(radius / distance).
    const bearing = Math.atan2(eye.z, eye.x), half = Math.acos(1 / Math.hypot(eye.x, eye.z));
    const step = 2 * Math.PI / 96;
    const angleOf = (p: THREE.Vector3) => Math.atan2(p.z, p.x);
    const off = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const near = (points: THREE.Vector3[], bearings: number[]) => points.every(p => bearings.some(b => off(angleOf(p), b) < step));
    const exact = silhouettes(cylinder, { forward: toward, eye });
    expect(exact.length).toBe(2);
    for (const stroke of exact) expect(near(stroke.points, [bearing + half, bearing - half])).toBe(true);
    // The parallel default puts them a quarter turn from the bearing: a different pair, tens of degrees off the true tangents.
    const parallel = silhouettes(cylinder, { forward: toward });
    expect(parallel.length).toBe(2);
    for (const stroke of parallel) {
      expect(near(stroke.points, [bearing + Math.PI / 2, bearing - Math.PI / 2])).toBe(true);
      expect(near(stroke.points, [bearing + half, bearing - half])).toBe(false);
    }
  });

  it('sizes the head\'s aura with `reach`, so a bust at scale 6 keeps its mid-chest tone, and leaves the default reach of 3 + 5 glow as it was', () => {
    const k = 6;
    const fig = agentFigure({ height: 24 * k, anchor: V(0, 0, 0), yaw: -THREE.MathUtils.degToRad(36) });
    // No breakup noise, so the tone is the aura's alone. Read at canon scale, as a card does (points divided by its scale).
    const ctx = sketchContext(1, { impression: 0 });
    const source = fig.head.centre.clone().divideScalar(k);
    const chest = (field: ReturnType<typeof toneField>) => [0.55, 0.6, 0.65, 0.7].map(u => field(fig.body.trunk.point(u, 0.25).divideScalar(k), fig.body.trunk.normal(u, 0.25)));
    const dflt = chest(toneField(ctx, source));
    // The head is 5 canon units off: inside the default aura (reach 5.5), which leaves the chest at the lightest tier.
    expect(fig.head.centre.distanceTo(fig.body.trunk.point(0.6, 0.25)) / k).toBeGreaterThan(5);
    for (const tone of dflt) expect(tone).toBeLessThan(TIER[1]);
    // The default is the glow's reach, to the bit; a reach of 2 lifts every one of those points past the second tier.
    expect(chest(toneField(ctx, source, { reach: 3 + 5 * 0.5 }))).toEqual(dflt);
    for (const tone of chest(toneField(ctx, source, { reach: 2 }))) expect(tone).toBeGreaterThan(TIER[1]);
  });
});
