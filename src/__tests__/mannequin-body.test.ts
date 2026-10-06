import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { POSES, poseSkeleton } from '../../sketches/kit/mannequin/skeleton.ts';
import { buildBody, bodyMeshes, bodyStrokes } from '../../sketches/kit/mannequin/body.ts';

const env = {
  forward: new THREE.Vector3(0, 0, -1), density: 0.55,
  screen: (p: THREE.Vector3) => ({ x: p.x * 10, y: -p.y * 10 }),
  dark: (_p: THREE.Vector3, n: THREE.Vector3) => Math.max(0, 1 - Math.max(0, n.z)),
};

describe('mannequin body', () => {
  it('builds trunk, eight limbs, hands, shoes and a head on any pose, following the skeleton', () => {
    for (const pose of Object.values(POSES)) {
      const s = poseSkeleton(pose);
      const b = buildBody(s);
      expect(b.limbs).toHaveLength(8);
      expect(b.blocks).toHaveLength(4);
      expect(b.head).toBeDefined();
      // Each limb tube runs from its joint to the bone's end.
      const thigh = b.limbs.find(t => t.id === 'thigh_l')!;
      expect(thigh.centre(0).distanceTo(s.at('hip_l'))).toBeLessThan(1e-6);
      expect(thigh.centre(1).distanceTo(s.at('hip_l', true))).toBeLessThan(1e-6);
    }
  });

  it('suits a body with more line than it leaves bare, and darker surfaces get more rings', () => {
    const b = buildBody(poseSkeleton(POSES.stand), { jacket: true });
    const len = (ss: { points: THREE.Vector3[] }[]) => ss.reduce((t, s) => t + s.points.slice(1).reduce((u, p, i) => u + p.distanceTo(s.points[i]), 0), 0);
    expect(len(bodyStrokes(b, env, 'suit'))).toBeGreaterThan(len(bodyStrokes(b, { ...env, dark: () => 0 }, 'bare')));
    expect(len(bodyStrokes(b, { ...env, dark: () => 0.9 }, 'bare'))).toBeGreaterThan(len(bodyStrokes(b, { ...env, dark: () => 0.3 }, 'bare')));
  });

  it('meshes every surface for the depth pass, and renders the proof sheet in every style', async () => {
    const b = buildBody(poseSkeleton(POSES.sit));
    expect(bodyMeshes(b)).toHaveLength(1 + 8 + 1 + 4);
    const entry = resolve('sketches/mannequin-proof/sketch.ts');
    for (const style of ['stick', 'bare', 'suit']) {
      const r = await renderSketch({ entry, seed: 1, params: { style } } as never);
      expect(r.diagnostics).toEqual([]);
      expect(r.stats.pathCount).toBeGreaterThan(100);
    }
  }, 60_000);
});
