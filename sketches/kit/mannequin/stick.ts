import * as THREE from 'three';
import type { Ink, Stroke } from '../types.ts';
import type { JointName, Skeleton } from './skeleton.ts';

/**
 * The stick figure: the skeleton's bones as single lines, the most abstract register. The spine is
 * one line from pelvis to crown; limbs run joint to joint; the head is a ring facing the camera. Joints
 * can carry a small ring or a tick across the bone, the way a drafting mannequin marks its pins.
 */
export interface StickOptions {
  /** Ink for the bones and head. */
  ink?: Ink;
  /** Ink for the joint marks; defaults to the bone ink. */
  jointInk?: Ink;
  group?: string;
  /** Head as a ring facing the camera, a line only, or nothing. */
  head?: 'ring' | 'line' | 'none';
  /** Marks at the joints: small rings, ticks across the bone, or none. */
  joints?: 'ring' | 'tick' | 'none';
  /** Size of joint marks and the pelvis/shoulder bars, as a fraction of standing height. */
  mark?: number;
  /** The camera's forward direction, so rings face the eye. Default: looking down −z. */
  forward?: THREE.Vector3;
}

const LIMBS: JointName[][] = [
  ['shoulder_l', 'elbow_l', 'wrist_l'], ['shoulder_r', 'elbow_r', 'wrist_r'],
  ['hip_l', 'knee_l', 'ankle_l'], ['hip_r', 'knee_r', 'ankle_r'],
];
const MARKED: JointName[] = ['shoulder_l', 'shoulder_r', 'elbow_l', 'elbow_r', 'wrist_l', 'wrist_r', 'hip_l', 'hip_r', 'knee_l', 'knee_r', 'ankle_l', 'ankle_r', 'neck'];

/** A ring of radius r about c, in the plane facing `forward`. */
function ring(c: THREE.Vector3, r: number, forward: THREE.Vector3, steps = 40): THREE.Vector3[] {
  const u = new THREE.Vector3().crossVectors(forward, Math.abs(forward.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(forward, u).normalize();
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = i / steps * Math.PI * 2;
    return c.clone().addScaledVector(u, r * Math.cos(a)).addScaledVector(v, r * Math.sin(a));
  });
}

export function stickStrokes(s: Skeleton, options: StickOptions = {}): Stroke[] {
  const ink = options.ink ?? 'carbon', jointInk = options.jointInk ?? ink, group = options.group ?? 'figure';
  const forward = (options.forward ?? new THREE.Vector3(0, 0, -1)).clone().normalize();
  const mark = (options.mark ?? 0.012) * s.height;
  const out: Stroke[] = [];
  const line = (points: THREE.Vector3[], i: Ink = ink) => out.push({ ink: i, group, family: 'edge', points });
  // Spine: pelvis through chest to the base of the head; bars across the hips and shoulders.
  line([s.at('pelvis'), s.at('spine'), s.at('chest'), s.at('neck'), s.at('head')]);
  line([s.at('hip_l'), s.at('pelvis'), s.at('hip_r')]);
  line([s.at('shoulder_l'), s.at('neck'), s.at('shoulder_r')]);
  for (const chain of LIMBS) line([...chain.map(j => s.at(j)), s.at(chain[2], true)]);
  // Head: a ring of the head's length, centred along the head bone.
  const headLen = s.joints.get('head')!.length;
  if (options.head !== 'none') {
    if (options.head === 'line') line([s.at('head'), s.at('head', true)]);
    else line(ring(s.at('head').lerp(s.at('head', true), 0.5), headLen * 0.46, forward, 48));
  }
  if (options.joints !== 'none') for (const j of MARKED) {
    const p = s.at(j);
    if (options.joints === 'tick') {
      const along = s.at(j, true).sub(p).normalize();
      const across = new THREE.Vector3().crossVectors(along, forward).normalize().multiplyScalar(mark * 1.4);
      line([p.clone().sub(across), p.clone().add(across)], jointInk);
    } else line(ring(p, mark, forward, 16), jointInk);
  }
  return out;
}
