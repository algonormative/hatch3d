import { describe, expect, it } from 'vitest';
import { POSES, poseSkeleton } from '../../sketches/kit/mannequin/skeleton.ts';
import { ELONGATED, flowBody, gesture } from '../../sketches/kit/mannequin/gesture.ts';
import { walkCycle } from '../../sketches/kit/mannequin/motion.ts';
import { BreakTube, bigSuit, shoeOf } from '../../sketches/kit/mannequin/big-suit.ts';

describe('mannequin gesture', () => {
  it('leaves canon skeletons alone and stretches bones by the stylized proportions', () => {
    const canon = poseSkeleton(POSES.walk), same = poseSkeleton(POSES.walk, { proportions: {} });
    for (const [name, a, b] of canon.bones()) {
      const [, c, d] = same.bones().find(([n]) => n === name)!;
      expect(c.distanceTo(a) + d.distanceTo(b)).toBe(0);
    }
    const long = poseSkeleton(gesture(POSES.walk, { push: 1.3, arc: -10, lean: 5 }), { proportions: ELONGATED });
    const bone = (s: typeof canon, j: 'hip_l' | 'head') => s.joints.get(j)!.length;
    expect(bone(long, 'hip_l') / bone(canon, 'hip_l')).toBeCloseTo(ELONGATED.thigh!, 6);
    expect(bone(long, 'head') / bone(canon, 'head')).toBeCloseTo(ELONGATED.head!, 6);
  });

  it('walks a cycle whose half-way pose mirrors its start', () => {
    const a = walkCycle(0), b = walkCycle(0.5);
    expect(b.joints.hip_l!.flex).toBeCloseTo(a.joints.hip_r!.flex!, 6);
    expect(b.joints.knee_r!.flex).toBeCloseTo(a.joints.knee_l!.flex!, 6);
    expect(a.joints.hip_l!.flex).toBeCloseTo(POSES.walk.joints.hip_l!.flex!, 6);
  });

  it('builds each limb as one tube from root to tip, curling the toes up when asked', () => {
    const s = poseSkeleton(gesture(POSES.walk), { proportions: ELONGATED });
    const body = flowBody(s, { toes: 'curl' });
    expect(body.limbs.map(t => t.id).sort()).toEqual(['arm_l', 'arm_r', 'leg_l', 'leg_r']);
    const leg = body.limbs.find(t => t.id === 'leg_l')!;
    expect(leg.centre(1).distanceTo(s.at('ankle_l', true))).toBeGreaterThan(1);
    expect(leg.centre(1).y).toBeGreaterThan(s.at('ankle_l', true).y);
  });
});

describe('the big suit', () => {
  const s = poseSkeleton(gesture(walkCycle(0), { push: 1.3 }), { proportions: { ...ELONGATED, head: 0.72 } });
  const body = flowBody(s, { toes: 'curl' });
  const suit = bigSuit(s, { size: 1.6, feet: body.limbs });

  it('stands its shoulders far outside the body and swallows the hands', () => {
    const half = Math.max(...Array.from({ length: 64 }, (_, i) => suit.jacket.point(0.89, i / 64).sub(suit.jacket.centre(0.89)).length()));
    expect(half).toBeGreaterThan(2 * s.at('shoulder_l').distanceTo(s.at('neck')));
    for (const sleeve of suit.sleeves) {
      const side = sleeve.id.endsWith('_l') ? 'l' : 'r';
      expect(sleeve.centre(1).distanceTo(s.at(`elbow_${side}`))).toBeGreaterThan(s.at(`wrist_${side}`, true).distanceTo(s.at(`elbow_${side}`)));
    }
  });

  it('lays each trouser hem over its shoe without cutting into it', () => {
    for (const leg of suit.trousers) {
      expect(leg).toBeInstanceOf(BreakTube);
      const side = leg.id.endsWith('_l') ? 'l' : 'r';
      const foot = body.limbs.find(t => t.id === `leg_${side}`)!;
      const ankle = s.at(`ankle_${side}`), toward = s.at(`ankle_${side}`, true).sub(ankle).setY(0).normalize();
      const shoe = shoeOf(foot, ankle, toward, 1);
      expect(shoe.length).toBeGreaterThan(100);
      for (let i = 0; i < 96; i++) {
        const p = leg.point(1, i / 96);
        const under = shoe.filter(q => Math.hypot(q.x - p.x, q.z - p.z) < 0.25);
        if (under.length) expect(p.y).toBeGreaterThan(Math.max(...under.map(q => q.y)) - 0.05);
      }
    }
  });
});
