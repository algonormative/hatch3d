import * as THREE from 'three';

/**
 * A joint skeleton for plotted figures. One skeleton, many renderers: stick figure, bare body, suit,
 * robe, outfits. Proportions follow an eight-head canon; `height` sets the figure's standing height in
 * world units. The figure faces +z with y up; its left side is +x.
 *
 * Each joint carries its own frame. A joint sits at its parent's origin plus `attach` (in the parent's
 * frame), turns by the pose's angles, and its bone runs `length` along `rest` in its own frame.
 *
 * Pose angles are in degrees and read anatomically, the same on both sides:
 * - `flex`: bend in the sagittal plane. Positive brings a limb forward (hip, shoulder, elbow), the
 *   spine forward, the head down (a nod); for the knee, positive folds the shin back.
 * - `abduct`: bend in the frontal plane. Positive takes a limb out to its own side; for the spine and
 *   head, positive leans toward the figure's left.
 * - `twist`: turn about the bone. Positive turns the front toward the figure's left.
 */
export type Side = 'l' | 'r';
export type JointName =
  | 'pelvis' | 'spine' | 'chest' | 'neck' | 'head'
  | `shoulder_${Side}` | `elbow_${Side}` | `wrist_${Side}`
  | `hip_${Side}` | `knee_${Side}` | `ankle_${Side}`;

export interface JointAngles { flex?: number; abduct?: number; twist?: number }

export interface Pose {
  joints: Partial<Record<JointName, JointAngles>>;
  /** Whole-body turn, in degrees, about the vertical (yaw), side-to-side (roll) and front-to-back (pitch) axes. */
  body?: { yaw?: number; pitch?: number; roll?: number };
  /** How the figure meets the world: standing on the ground (default), or hanging by a joint from a point. */
  support?: { kind: 'ground' } | { kind: 'hang'; from: JointName; end?: boolean };
}

interface JointDef { name: JointName; parent?: JointName; attach: [number, number, number]; rest: [number, number, number]; length: number }

/** Canon proportions as fractions of standing height. */
const CANON = {
  pelvisY: 0.535, lumbar: 0.09, thorax: 0.1, chest: 0.09, neck: 0.05, head: 0.125,
  shoulderX: 0.105, shoulderY: 0.075, upperArm: 0.17, forearm: 0.145, hand: 0.1,
  hipX: 0.062, hipY: -0.02, thigh: 0.245, shin: 0.235, foot: 0.13,
} as const;

function defs(): JointDef[] {
  const c = CANON;
  const out: JointDef[] = [
    { name: 'pelvis', attach: [0, c.pelvisY, 0], rest: [0, 1, 0], length: c.lumbar },
    { name: 'spine', parent: 'pelvis', attach: [0, c.lumbar, 0], rest: [0, 1, 0], length: c.thorax },
    { name: 'chest', parent: 'spine', attach: [0, c.thorax, 0], rest: [0, 1, 0], length: c.chest },
    { name: 'neck', parent: 'chest', attach: [0, c.chest, 0], rest: [0, 1, 0], length: c.neck },
    { name: 'head', parent: 'neck', attach: [0, c.neck, 0], rest: [0, 1, 0], length: c.head },
  ];
  for (const side of ['l', 'r'] as const) {
    const x = side === 'l' ? 1 : -1;
    out.push(
      { name: `shoulder_${side}`, parent: 'chest', attach: [x * c.shoulderX, c.shoulderY, 0], rest: [0, -1, 0], length: c.upperArm },
      { name: `elbow_${side}`, parent: `shoulder_${side}`, attach: [0, -c.upperArm, 0], rest: [0, -1, 0], length: c.forearm },
      { name: `wrist_${side}`, parent: `elbow_${side}`, attach: [0, -c.forearm, 0], rest: [0, -1, 0], length: c.hand },
      { name: `hip_${side}`, parent: 'pelvis', attach: [x * c.hipX, c.hipY, 0], rest: [0, -1, 0], length: c.thigh },
      { name: `knee_${side}`, parent: `hip_${side}`, attach: [0, -c.thigh, 0], rest: [0, -1, 0], length: c.shin },
      { name: `ankle_${side}`, parent: `knee_${side}`, attach: [0, -c.shin, 0], rest: [0, 0, 1], length: c.foot },
    );
  }
  return out;
}

const DEFS = defs();
export const JOINTS: readonly JointName[] = DEFS.map(d => d.name);

/** Anatomical limits, degrees: [min, max] per angle. Poses are clamped to them. */
const LIMITS: Partial<Record<string, { flex?: [number, number]; abduct?: [number, number]; twist?: [number, number] }>> = {
  pelvis: { flex: [-40, 100], abduct: [-40, 40], twist: [-60, 60] },
  spine: { flex: [-30, 50], abduct: [-30, 30], twist: [-40, 40] },
  chest: { flex: [-25, 40], abduct: [-25, 25], twist: [-35, 35] },
  neck: { flex: [-50, 60], abduct: [-40, 40], twist: [-70, 70] },
  head: { flex: [-40, 40], abduct: [-20, 20], twist: [-20, 20] },
  shoulder: { flex: [-60, 180], abduct: [-30, 180], twist: [-90, 90] },
  elbow: { flex: [0, 150], abduct: [0, 0], twist: [-90, 90] },
  wrist: { flex: [-70, 80], abduct: [-25, 35], twist: [0, 0] },
  hip: { flex: [-30, 130], abduct: [-30, 80], twist: [-45, 45] },
  knee: { flex: [0, 155], abduct: [0, 0], twist: [0, 0] },
  ankle: { flex: [-45, 30], abduct: [-25, 25], twist: [0, 0] },
};
const kind = (name: JointName) => name.replace(/_[lr]$/, '');
const clampTo = (v: number, r?: [number, number]) => (r ? Math.max(r[0], Math.min(r[1], v)) : v);

/** The local rotation for a joint from its anatomical angles. */
function localRotation(name: JointName, a: JointAngles): THREE.Quaternion {
  const lim = LIMITS[kind(name)] ?? {};
  const d = THREE.MathUtils.degToRad;
  const flex = d(clampTo(a.flex ?? 0, lim.flex)), abduct = d(clampTo(a.abduct ?? 0, lim.abduct)), twist = d(clampTo(a.twist ?? 0, lim.twist));
  const def = DEFS.find(j => j.name === name)!;
  const down = def.rest[1] < 0, foot = def.rest[2] > 0;
  const side = name.endsWith('_r') ? -1 : 1;
  // Rotation about x moves an up-pointing bone's end toward +z for positive angles and a down-pointing
  // one's toward −z; flip so positive flex is always forward. The knee and the foot read the other way.
  let fx = down ? -flex : flex;
  if (kind(name) === 'knee') fx = flex;
  if (foot) fx = -flex;
  // Rotation about z takes a down-pointing bone toward +x: outward for the left side.
  const fz = down || foot ? side * abduct : -abduct;
  const fy = side * twist;
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), fz)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), fx))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), fy));
}

export interface JointFrame { name: JointName; parent?: JointName; origin: THREE.Vector3; end: THREE.Vector3; rot: THREE.Quaternion; length: number }

/** A posed skeleton in world space. */
export interface Skeleton {
  height: number;
  joints: Map<JointName, JointFrame>;
  /** A joint's origin, or its bone's end with `end`. */
  at(name: JointName, end?: boolean): THREE.Vector3;
  /** The joint's local axes in world space: x (its left), y (along the bone), z (its front). */
  axes(name: JointName): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 };
  /** Every bone as a [from, to] pair, parents first. */
  bones(): [JointName, THREE.Vector3, THREE.Vector3][];
}

export interface PoseOptions {
  /** Standing height, world units. */
  height?: number;
  /** Where the figure stands (ground support: the point under it) or hangs from (hang support). */
  position?: THREE.Vector3;
}

/** Forward kinematics: pose a skeleton in the world. */
export function poseSkeleton(pose: Pose, options: PoseOptions = {}): Skeleton {
  const height = options.height ?? 24;
  const joints = new Map<JointName, JointFrame>();
  const b = pose.body ?? {};
  const d = THREE.MathUtils.degToRad;
  const bodyRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(b.pitch ?? 0), d(b.yaw ?? 0), d(b.roll ?? 0), 'YXZ'));
  for (const def of DEFS) {
    const parent = def.parent ? joints.get(def.parent)! : undefined;
    const attach = new THREE.Vector3(...def.attach).multiplyScalar(height);
    const origin = parent ? parent.origin.clone().add(attach.applyQuaternion(parent.rot)) : attach.applyQuaternion(bodyRot);
    const rot = (parent ? parent.rot.clone() : bodyRot.clone()).multiply(localRotation(def.name, pose.joints[def.name] ?? {}));
    const length = def.length * height;
    const end = origin.clone().add(new THREE.Vector3(...def.rest).multiplyScalar(length).applyQuaternion(rot));
    joints.set(def.name, { name: def.name, parent: def.parent, origin, end, rot, length });
  }
  // Support: rest the lowest point on the ground, or hang the named point from the given position.
  const support = pose.support ?? { kind: 'ground' };
  const at = options.position ?? new THREE.Vector3();
  let shift: THREE.Vector3;
  if (support.kind === 'hang') {
    const j = joints.get(support.from)!;
    shift = at.clone().sub(support.end ? j.end : j.origin);
  } else {
    let low = Infinity;
    for (const j of joints.values()) low = Math.min(low, j.origin.y, j.end.y);
    const pelvis = joints.get('pelvis')!.origin;
    shift = new THREE.Vector3(at.x - pelvis.x, at.y - low, at.z - pelvis.z);
  }
  for (const j of joints.values()) { j.origin.add(shift); j.end.add(shift); }
  return {
    height,
    joints,
    at: (name, end = false) => (end ? joints.get(name)!.end : joints.get(name)!.origin).clone(),
    axes: name => {
      const r = joints.get(name)!.rot;
      return { x: new THREE.Vector3(1, 0, 0).applyQuaternion(r), y: new THREE.Vector3(0, 1, 0).applyQuaternion(r), z: new THREE.Vector3(0, 0, 1).applyQuaternion(r) };
    },
    bones: () => [...joints.values()].map(j => [j.name, j.origin.clone(), j.end.clone()]),
  };
}

const both = (a: JointAngles, b: JointAngles = a, prefix: 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle') =>
  ({ [`${prefix}_l`]: a, [`${prefix}_r`]: b }) as Partial<Record<JointName, JointAngles>>;

/** Named poses. Cards start from one and override joints. */
export const POSES: Record<'stand' | 'walk' | 'sit' | 'kneel' | 'hang' | 'reach' | 'dance', Pose> = {
  stand: { joints: {
    ...both({ abduct: 8, flex: 4 }, undefined, 'shoulder'), ...both({ flex: 12 }, undefined, 'elbow'),
    ...both({ abduct: 4 }, undefined, 'hip'), ...both({ flex: 3 }, undefined, 'knee'),
  } },
  walk: { joints: {
    spine: { twist: -6 }, chest: { twist: 8 },
    hip_l: { flex: 26, abduct: 3 }, knee_l: { flex: 8 }, ankle_l: { flex: 8 },
    hip_r: { flex: -16, abduct: 3 }, knee_r: { flex: 34 }, ankle_r: { flex: -18 },
    shoulder_l: { flex: -22, abduct: 7 }, elbow_l: { flex: 14 },
    shoulder_r: { flex: 24, abduct: 7 }, elbow_r: { flex: 30 },
  } },
  sit: { joints: {
    ...both({ flex: 88, abduct: 8 }, undefined, 'hip'), ...both({ flex: 90 }, undefined, 'knee'),
    ...both({ flex: 18, abduct: 10 }, undefined, 'shoulder'), ...both({ flex: 70 }, undefined, 'elbow'),
  } },
  kneel: { joints: {
    hip_l: { flex: 90, abduct: 6 }, knee_l: { flex: 90 },
    hip_r: { flex: -5, abduct: 4 }, knee_r: { flex: 95 }, ankle_r: { flex: -40 },
    spine: { flex: 6 }, shoulder_l: { flex: 40, abduct: 10 }, elbow_l: { flex: 60 },
    shoulder_r: { flex: 60, abduct: 4 }, elbow_r: { flex: 40 },
  } },
  // The Hanged Man: by the right ankle, the left leg folded behind the right knee, hands behind the back.
  hang: {
    body: { roll: 180 },
    support: { kind: 'hang', from: 'ankle_r' },
    joints: {
      hip_l: { flex: -10, abduct: 6 }, knee_l: { flex: 100 },
      shoulder_l: { flex: -40, abduct: 12 }, elbow_l: { flex: 100, twist: 40 },
      shoulder_r: { flex: -40, abduct: 12 }, elbow_r: { flex: 100, twist: 40 },
      neck: { flex: -10 },
    },
  },
  // The Magician: one arm raised to the sky, the other pointing to the ground.
  reach: { joints: {
    shoulder_r: { flex: 165, abduct: 10 }, elbow_r: { flex: 8 },
    shoulder_l: { flex: 25, abduct: 22 }, elbow_l: { flex: 6 }, wrist_l: { flex: -20 },
    ...both({ abduct: 5 }, undefined, 'hip'), knee_r: { flex: 4 },
    neck: { flex: -12 },
  } },
  // The World: one leg crossed behind, arms open.
  dance: { joints: {
    pelvis: { abduct: 6 }, chest: { abduct: -8, twist: 10 },
    hip_l: { flex: 6, abduct: 10 }, knee_l: { flex: 6 },
    hip_r: { flex: -12, abduct: -14 }, knee_r: { flex: 85 },
    shoulder_l: { abduct: 70, flex: 20 }, elbow_l: { flex: 40 },
    shoulder_r: { abduct: 115, flex: -10 }, elbow_r: { flex: 25 },
    neck: { abduct: 10 },
  } },
};

/** A named pose with per-joint overrides merged over it. */
export function withPose(base: Pose, overrides: Partial<Record<JointName, JointAngles>> = {}, body?: Pose['body']): Pose {
  const joints: Partial<Record<JointName, JointAngles>> = { ...base.joints };
  for (const [k, v] of Object.entries(overrides) as [JointName, JointAngles][]) joints[k] = { ...(joints[k] ?? {}), ...v };
  return { ...base, joints, body: { ...(base.body ?? {}), ...(body ?? {}) } };
}
