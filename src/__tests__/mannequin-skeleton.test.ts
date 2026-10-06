import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JOINTS, POSES, poseSkeleton, withPose } from '../../sketches/kit/mannequin/skeleton.ts';
import { stickStrokes } from '../../sketches/kit/mannequin/stick.ts';

describe('mannequin skeleton', () => {
  it('keeps every bone its canon length in every named pose', () => {
    const rest = poseSkeleton({ joints: {} });
    for (const pose of Object.values(POSES)) {
      const s = poseSkeleton(pose);
      for (const name of JOINTS) {
        const j = s.joints.get(name)!;
        expect(j.origin.distanceTo(j.end)).toBeCloseTo(rest.joints.get(name)!.length, 6);
      }
    }
  });

  it('stands on the ground: standing height is the canon, lowest point at y = 0', () => {
    const s = poseSkeleton(POSES.stand, { height: 24 });
    let low = Infinity, high = -Infinity;
    for (const j of s.joints.values()) { low = Math.min(low, j.origin.y, j.end.y); high = Math.max(high, j.origin.y, j.end.y); }
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeGreaterThan(22);
    expect(high).toBeLessThan(24.5);
  });

  it('reads angles anatomically and the same on both sides', () => {
    const fwd = poseSkeleton({ joints: { hip_l: { flex: 60 }, hip_r: { flex: 60 } } });
    for (const side of ['l', 'r'] as const) expect(fwd.at(`knee_${side}`).z).toBeGreaterThan(fwd.at(`hip_${side}`).z + 5);
    const out = poseSkeleton({ joints: { shoulder_l: { abduct: 90 }, shoulder_r: { abduct: 90 } } });
    expect(out.at('elbow_l').x).toBeGreaterThan(out.at('shoulder_l').x + 3);
    expect(out.at('elbow_r').x).toBeLessThan(out.at('shoulder_r').x - 3);
    const bent = poseSkeleton({ joints: { knee_l: { flex: 90 } } });
    expect(bent.at('ankle_l').z).toBeLessThan(bent.at('knee_l').z - 3);
  });

  it('clamps to joint limits: a knee never folds forward', () => {
    const a = poseSkeleton({ joints: { knee_l: { flex: -60 } } }), b = poseSkeleton({ joints: { knee_l: { flex: 0 } } });
    expect(a.at('ankle_l').distanceTo(b.at('ankle_l'))).toBeLessThan(1e-9);
  });

  it('hangs from the named joint at the given point, head down', () => {
    const at = new THREE.Vector3(3, 40, -2);
    const s = poseSkeleton(POSES.hang, { position: at });
    expect(s.at('ankle_r').distanceTo(at)).toBeLessThan(1e-9);
    expect(s.at('head', true).y).toBeLessThan(at.y - 20);
  });

  it('merges overrides over a named pose', () => {
    const p = withPose(POSES.reach, { elbow_r: { flex: 90 } });
    expect(p.joints.elbow_r!.flex).toBe(90);
    expect(p.joints.shoulder_r!.flex).toBe(165);
  });

  it('draws a stick figure of finite lines with a head ring', () => {
    const strokes = stickStrokes(poseSkeleton(POSES.walk), { joints: 'tick' });
    expect(strokes.length).toBeGreaterThan(15);
    for (const s of strokes) for (const p of s.points) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    expect(strokes.some(s => s.points.length > 40)).toBe(true);
  });
});
