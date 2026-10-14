import * as THREE from 'three';
import { clamp } from '../params.ts';
import { LOOK, TIER, runs, type Look, type ToneEnv } from './hatch.ts';
import { POSES, withPose, type Pose } from './skeleton.ts';
import type { ClothStroke } from './tube.ts';

/**
 * Movement over time: a walk cycle to pose a figure at any moment of its stride, and a streamer (a
 * scarf, a sash) trailing along a path. Together they draw a figure with the moments before it.
 */

/** One leg over its own cycle, heel strike at 0 and toe-off at 0.5: [phase, hip, knee, ankle] flex. */
const LEG: [number, number, number, number][] = [
  [0, 26, 8, 8], [0.12, 22, 16, 0], [0.3, 8, 6, -4], [0.5, -16, 34, -18], [0.62, -8, 58, 4], [0.75, 10, 40, 10], [0.88, 24, 12, 10],
];

/** Periodic Catmull-Rom through the keys' column `col`. */
function periodic(phase: number, col: 1 | 2 | 3): number {
  const p = ((phase % 1) + 1) % 1;
  const n = LEG.length;
  let i = n - 1;
  while (i > 0 && LEG[i][0] > p) i--;
  const at = (k: number) => LEG[((k % n) + n) % n];
  const t0 = at(i)[0], t1 = i + 1 < n ? at(i + 1)[0] : 1;
  const f = (p - t0) / (t1 - t0);
  const [a, b, c, d] = [at(i - 1)[col], at(i)[col], at(i + 1)[col], at(i + 2)[col]];
  return 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (3 * b - a - 3 * c + d) * f * f * f);
}

/** Ground covered per cycle (two steps), as a fraction of standing height. */
export const STRIDE = 0.78;

/** The walk at `phase` of its cycle: the kit's walk pose at 0, its mirror at 0.5. */
export function walkCycle(phase: number, base: Pose = POSES.walk): Pose {
  const leg = (p: number) => ({ hip: periodic(p, 1), knee: periodic(p, 2), ankle: periodic(p, 3) });
  const l = leg(phase), r = leg(phase + 0.5);
  // Each arm swings against its own side's leg.
  const arm = (hip: number) => { const flex = -(hip - 5) * 1.05; return { flex, elbow: 14 + 16 * clamp(flex / 24, 0, 1) }; };
  const al = arm(l.hip), ar = arm(r.hip);
  const c = Math.cos(2 * Math.PI * phase);
  return withPose(base, {
    hip_l: { flex: l.hip }, knee_l: { flex: l.knee }, ankle_l: { flex: l.ankle },
    hip_r: { flex: r.hip }, knee_r: { flex: r.knee }, ankle_r: { flex: r.ankle },
    shoulder_l: { flex: al.flex }, elbow_l: { flex: al.elbow },
    shoulder_r: { flex: ar.flex }, elbow_r: { flex: ar.elbow },
    spine: { twist: -6 * c }, chest: { twist: 8 * c },
  });
}

export interface StreamerOptions {
  /** Ribbon width, world units. */
  width: number;
  /** Half-turns the ribbon makes about its path from end to end. */
  turns?: number;
  /** Lines across the ribbon per world unit, at full darkness. */
  rungs?: number;
}

/**
 * A ribbon streaming along `path`: two edges turning about it, and rungs across the face where it is
 * turned from the light. The ribbon narrows to a point at the path's end.
 */
export function streamerStrokes(path: THREE.Vector3[], env: Pick<ToneEnv, 'dark'>, o: StreamerOptions, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const n = path.length;
  if (n < 2) return out;
  const up = new THREE.Vector3(0, 1, 0);
  const lenAt: number[] = [0];
  for (let i = 1; i < n; i++) lenAt.push(lenAt[i - 1] + path[i].distanceTo(path[i - 1]));
  const total = lenAt[n - 1];
  const a: THREE.Vector3[] = [], b: THREE.Vector3[] = [], face: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const tan = path[Math.min(n - 1, i + 1)].clone().sub(path[Math.max(0, i - 1)]).normalize();
    const side = up.clone().addScaledVector(tan, -up.dot(tan)).normalize();
    const f = lenAt[i] / total;
    side.applyAxisAngle(tan, Math.PI * (o.turns ?? 1.5) * f);
    const w = o.width / 2 * (1 - 0.85 * f ** 2);
    a.push(path[i].clone().addScaledVector(side, w));
    b.push(path[i].clone().addScaledVector(side, -w));
    face.push(new THREE.Vector3().crossVectors(tan, side).normalize());
  }
  out.push({ ink: look.edge, group: look.contour, family: look.family, points: a });
  out.push({ ink: look.edge, group: look.contour, family: look.family, points: b });
  // Rungs: one per spacing, the face's tone deciding which tiers show (either side of the ribbon).
  const per = (o.rungs ?? 3.5) * total;
  for (let r = 0; r < per; r++) {
    const s = (r + 0.5) / per * total;
    let i = 1;
    while (i < n - 1 && lenAt[i] < s) i++;
    const f = (s - lenAt[i - 1]) / Math.max(1e-9, lenAt[i] - lenAt[i - 1]);
    const pa = a[i - 1].clone().lerp(a[i], f), pb = b[i - 1].clone().lerp(b[i], f);
    const mid = pa.clone().lerp(pb, 0.5);
    const nrm = face[i - 1].clone().lerp(face[i], f).normalize();
    const dark = Math.max(env.dark(mid, nrm), env.dark(mid, nrm.clone().negate()) * 0.6);
    const tier = r % 4 === 0 ? 0 : r % 2 === 0 ? 1 : 2;
    runs([pa, pb], [true, true], r % 8 === 0 ? look.accent : look.cloth, look.figure, dark > TIER[tier] ? out : [], look.family);
  }
  return out;
}
