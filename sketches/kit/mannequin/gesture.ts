import * as THREE from 'three';
import { LOOK, TIER, perpendicular, runs, stride, tierOf, type Look, type ToneEnv } from './hatch.ts';
import type { Body } from './body.ts';
import type { JointAngles, JointName, Pose, Proportions, Side, Skeleton } from './skeleton.ts';
import { Tube, silhouettes, type ClothStroke, type Key, type ViewEnv } from './tube.ts';

/**
 * Stylized, flowing figures over the stiff reference skeleton. Three layers, each optional:
 * - `gesture` pushes a pose along one line of action: exaggerated angles, a spine that bends as one
 *   curve, contrapposto (hips one way, shoulders the other), a lean into the movement;
 * - `ELONGATED` proportions (with `poseSkeleton`'s `proportions`): longer legs and forearms, a smaller
 *   head, narrower hips;
 * - `flowBody` builds the body with each limb one tapering tube from root to tip, bowed off the
 *   straight line between joints, so outlines and hatch run across the knee and elbow unbroken.
 * `ribbonStrokes` then draws such a body as long bands running the length of each limb.
 */
export interface Gesture {
  /** Push every joint angle further from rest by this factor (1 = as posed). */
  push?: number;
  /** Bend of the spine as one curve in the sagittal plane, degrees: + curls forward, − arches back. */
  arc?: number;
  /** Contrapposto, degrees: the hips tilt toward the figure's left, the shoulders back the other way. */
  sway?: number;
  /** Wring between hips and shoulders, degrees. */
  wring?: number;
  /** Lean of the whole figure into its movement, degrees forward. */
  lean?: number;
}

/** A pose pushed along its line of action. */
export function gesture(pose: Pose, g: Gesture = {}): Pose {
  const push = g.push ?? 1;
  const joints: Partial<Record<JointName, JointAngles>> = {};
  for (const [k, a] of Object.entries(pose.joints) as [JointName, JointAngles][]) {
    joints[k] = { flex: (a.flex ?? 0) * push, abduct: (a.abduct ?? 0) * push, twist: (a.twist ?? 0) * push };
  }
  const add = (j: JointName, d: JointAngles) => {
    const a = joints[j] ?? {};
    joints[j] = { flex: (a.flex ?? 0) + (d.flex ?? 0), abduct: (a.abduct ?? 0) + (d.abduct ?? 0), twist: (a.twist ?? 0) + (d.twist ?? 0) };
  };
  const arc = g.arc ?? 0, sway = g.sway ?? 0, wring = g.wring ?? 0;
  // The spine bends as one curve, the upper joints carrying more of it.
  add('spine', { flex: arc * 0.3 }); add('chest', { flex: arc * 0.35 }); add('neck', { flex: arc * 0.35 });
  // Contrapposto: the pelvis tilts, the legs stay under it, the shoulders tilt back the other way and
  // the head comes back over the feet.
  add('pelvis', { abduct: sway, twist: wring * 0.5 });
  add('hip_l', { abduct: sway }); add('hip_r', { abduct: -sway });
  add('spine', { abduct: -sway * 0.8, twist: -wring * 0.5 }); add('chest', { abduct: -sway * 0.9, twist: -wring * 0.5 });
  add('neck', { abduct: sway * 0.6 });
  return { ...pose, joints, body: { ...(pose.body ?? {}), pitch: (pose.body?.pitch ?? 0) + (g.lean ?? 0) } };
}

/** Long-limbed, small-headed proportions, about nine and a half heads. */
export const ELONGATED: Proportions = {
  head: 0.84, neck: 1.2, lumbar: 1.05, thigh: 1.08, shin: 1.09, upperArm: 1.05, forearm: 1.1, hand: 0.95, hipX: 0.88, shoulderX: 0.95,
};

export interface FlowOptions {
  /** Broader or slighter build, 1 = canon. */
  build?: number;
  /** How far each limb bows off the straight line between its joints, as a fraction of the bone. */
  bow?: number;
  /** Planes per section (0 = smooth). */
  facets?: number;
  /** Feet that run to a point, or a jester's points curling up past the toe. */
  toes?: 'point' | 'curl';
}

const scaleKeys = (keys: Key[], k: number): Key[] => keys.map(([u, rx, ry]) => [u, rx * k, ry * k]);

/** The axis of `candidates` most nearly square to every segment of a chain: a stable tube frame. */
export function squareRef(chain: THREE.Vector3[], candidates: THREE.Vector3[]): THREE.Vector3 {
  let best = candidates[0], score = -1;
  for (const c of candidates) {
    let s = Infinity;
    for (let i = 0; i + 1 < chain.length; i++) s = Math.min(s, chain[i + 1].clone().sub(chain[i]).normalize().cross(c).length());
    if (s > score) { score = s; best = c; }
  }
  return best;
}

/** A body of flowing limbs: one tube per limb, root to tip, tapering and bowed. */
export function flowBody(s: Skeleton, o: FlowOptions = {}): Body {
  const H = s.height, k = H / 24 * (o.build ?? 1);
  const bow = o.bow ?? 0.06;
  const cut = o.facets && o.facets >= 3 ? o.facets : 0;
  const ax = (j: JointName) => s.axes(j);
  const pelvis = s.joints.get('pelvis')!, neck = s.joints.get('neck')!;
  const spine = [
    pelvis.origin.clone().addScaledVector(ax('pelvis').y, -0.03 * H),
    s.at('spine'), s.at('chest'), s.at('chest').lerp(s.at('neck'), 0.6), s.at('neck'), neck.end,
  ];
  // A narrower waist and a longer, slighter neck than the reference trunk.
  const trunk = new Tube('trunk', spine,
    scaleKeys([[0, 2.0, 1.4], [0.22, 1.58, 1.18], [0.5, 2.2, 1.38], [0.74, 2.7, 1.24], [0.82, 2.2, 1.04], [0.885, 0.86, 0.76], [0.93, 0.56, 0.56], [1, 0.5, 0.5]], k),
    ax('pelvis').z, 1, [1.0 * k, 0], undefined, cut);
  const limbs: Tube[] = [];
  /** A limb through `chain` (root to tip), bowed by `bows` per bone, radius `radii` at each joint and each bone's middle. */
  const limb = (id: string, chain: THREE.Vector3[], bows: (THREE.Vector3 | null)[], radii: number[], hand: 1 | -1, caps: [number, number], refs: THREE.Vector3[]) => {
    const pts = [chain[0]];
    const lengths = chain.slice(1).map((p, i) => p.distanceTo(chain[i]));
    const total = lengths.reduce((a, b) => a + b, 0);
    const keys: Key[] = [[0, radii[0], radii[0]]];
    let run = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
      const along = chain[i + 1].clone().sub(chain[i]).normalize();
      const mid = chain[i].clone().lerp(chain[i + 1], 0.5);
      const b = bows[i];
      if (b) {
        const off = b.clone().addScaledVector(along, -b.dot(along));
        if (off.lengthSq() > 1e-9) mid.addScaledVector(off.normalize(), lengths[i] * bow);
      }
      pts.push(mid, chain[i + 1]);
      keys.push([(run + lengths[i] / 2) / total, radii[2 * i + 1], radii[2 * i + 1]]);
      run += lengths[i];
      keys.push([run / total, radii[2 * i + 2], radii[2 * i + 2]]);
    }
    limbs.push(new Tube(id, pts, scaleKeys(keys, k), squareRef(chain, refs), hand, [caps[0] * k, caps[1] * k], undefined, cut));
  };
  for (const side of ['l', 'r'] as Side[]) {
    const h: 1 | -1 = side === 'l' ? 1 : -1;
    const hip = ax(`hip_${side}`), sh = ax(`shoulder_${side}`);
    // Leg: hip, knee, ankle, toe. The thigh bows forward, the calf back; the foot runs to a point, or
    // on past it, curling up. The leg starts inside the trunk, above the hip joint, so the thigh grows
    // out of the pelvis.
    const leg = [s.at(`hip_${side}`).addScaledVector(ax('pelvis').y, 0.04 * H), s.at(`knee_${side}`), s.at(`ankle_${side}`), s.at(`ankle_${side}`, true)];
    if (o.toes === 'curl') {
      const toe = leg[3], along = toe.clone().sub(leg[2]).setY(0).normalize(), up = new THREE.Vector3(0, 1, 0);
      leg.push(toe.clone().addScaledVector(along, 1.1 * k).addScaledVector(up, 0.25 * k), toe.clone().addScaledVector(along, 1.75 * k).addScaledVector(up, 0.95 * k));
      limb(`leg_${side}`, leg, [hip.z, ax(`knee_${side}`).z.negate(), null, null, null],
        [1.18, 1.24, 0.82, 0.9, 0.46, 0.52, 0.36, 0.28, 0.2, 0.13, 0.05], h, [0.9, 0.06], [hip.x, hip.z]);
    } else {
      limb(`leg_${side}`, leg, [hip.z, ax(`knee_${side}`).z.negate(), null], [1.18, 1.24, 0.82, 0.9, 0.46, 0.5, 0.14], h, [0.9, 0.12], [hip.x, hip.z]);
    }
    // Arm: shoulder, elbow, wrist, fingertips. The upper arm bows out, the forearm forward.
    limb(`arm_${side}`, [s.at(`shoulder_${side}`), s.at(`elbow_${side}`), s.at(`wrist_${side}`), s.at(`wrist_${side}`, true)],
      [sh.x.clone().multiplyScalar(h), ax(`elbow_${side}`).z, null], [0.95, 0.8, 0.58, 0.64, 0.38, 0.44, 0.1], h, [0.8, 0.08], [sh.z, sh.x]);
  }
  const j = s.joints.get('head')!;
  const hk = j.length / (0.125 * H);
  const head = new Tube('head', [j.origin, j.origin.clone().lerp(j.end, 0.5), j.end],
    scaleKeys([[0, 0.72, 0.78], [0.45, 1.22, 1.32], [1, 1.0, 1.05]], k * hk), ax('head').z, 1, [0.4 * k * hk, 1.15 * k * hk], undefined, cut);
  return { skeleton: s, trunk, limbs, head, blocks: [] };
}

export interface RibbonOptions {
  /** Bands round the trunk; limbs carry a little over half as many, the head five. */
  bands?: number;
  /** Share of each band's slot that is cloth; the rest is a paper gap. */
  fill?: number;
  /** Turns each band winds round its tube over the tube's length. */
  twist?: number;
  /** Line spaces across a band at full density. */
  lines?: number;
}

/**
 * The figure as long ribbons: bands of lengthwise lines running root to tip down each tube, winding
 * slowly round it, with paper between. Band edges are always drawn; lines inside a band come in by
 * tone, primaries first, so a band fills as it turns from the light.
 */
export function ribbonStrokes(b: Body, env: ToneEnv & ViewEnv, look: Look = LOOK, o: RibbonOptions = {}): ClothStroke[] {
  const out: ClothStroke[] = [];
  const fill = o.fill ?? 0.62, twist = o.twist ?? 0.22, L = o.lines ?? 8, bands = o.bands ?? 9;
  const wrap = (v: number) => ((v % 1) + 1) % 1;
  for (const t of [b.trunk, ...b.limbs, ...(b.head ? [b.head] : [])]) {
    const K = t === b.trunk ? bands : t === b.head ? 5 : Math.max(4, Math.round(bands * 0.55));
    const steps = Math.max(160, Math.round(t.length / 0.04));
    const turn = t.hand * twist;
    for (let band = 0; band < K; band++) for (let j = 0; j <= L; j++) {
      const edge = j === 0 || j === L;
      const v0 = (band + fill * j / L) / K;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps, v = v0 + turn * u;
        const p = t.point(u, v);
        pts.push(p);
        const dark = env.dark(p, t.normal(u, wrap(v)));
        if (edge) { keep.push(dark > 0.04); continue; }
        const s = stride(perpendicular(env, p, t.point(u + 1 / steps, v + turn / steps), t.point(u, v + fill / (K * L))));
        keep.push(j % s === 0 && dark > TIER[tierOf(j)]);
      }
      runs(pts, keep, edge ? look.crease : j === L / 2 ? look.accent : look.cloth, look.figure, out, look.family);
    }
    out.push(...silhouettes(t, env, { ink: look.edge, group: look.contour, family: look.family }));
  }
  return out;
}
