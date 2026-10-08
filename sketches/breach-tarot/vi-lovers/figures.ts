import * as THREE from 'three';
import { bodyMeshes, contourTube, type Body } from '../../kit/mannequin/body.ts';
import { ELONGATED, flowBody, gesture, ribbonStrokes } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { POSES, poseSkeleton, withPose, type JointAngles, type JointName, type Pose, type Side, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { silhouettes, type ClothStroke, type ViewEnv } from '../../kit/mannequin/tube.ts';
import type { Stroke } from '../../kit/types.ts';

/**
 * The two lovers as small figures floating in the air: the kit's mannequin, bare, in plain carbon, a
 * relaxed pose pushed along one line of action (Chagall's lovers): the body arched and leaning toward
 * the other, the legs trailing and a little bent, one arm reaching, the head tilted toward the other.
 * Their fingertips are put one `gap` apart along the line of the light, so the hands never touch but,
 * shadows being the projection along that line, their shadows' hands meet on the ground below.
 */
export interface Figure { skeleton: Skeleton; body: Body; tip: THREE.Vector3 }

/** Ink and group for the figures: all carbon, so they stay plain beside the towers' hatch. */
export const FIGURE_LOOK: Look = { ...LOOK, cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure-edge', family: 'hatch' };

const PROPORTIONS = { ...ELONGATED, head: 0.95, neck: 1.35 };

/**
 * One lover drifting in the air, facing along `yaw`, the arm on `side` reaching `reach` degrees from
 * hanging, leaning `lean` degrees toward the other from the hips. Pushed a little along its line of action.
 */
function floatingPose(side: Side, reach: number, yaw: number, lean: number): Pose {
  const other: Side = side === 'l' ? 'r' : 'l';
  const tilt = side === 'l' ? 1 : -1;
  const joints: Partial<Record<JointName, JointAngles>> = {
    // The body leans toward the other from the hips (the legs, hung from the pelvis, swing back with it, so the hips bring
    // them forward again); they hang below and a little back, knees softly bent, feet pointing down.
    pelvis: { flex: lean },
    [`hip_${side}`]: { flex: lean - 4, abduct: 3 }, [`knee_${side}`]: { flex: 12 }, [`ankle_${side}`]: { flex: -52 },
    [`hip_${other}`]: { flex: lean - 10, abduct: 4 }, [`knee_${other}`]: { flex: 20 }, [`ankle_${other}`]: { flex: -58 },
    // One arm reaches at about shoulder height, the other hangs loose; the head inclines toward the other.
    [`shoulder_${side}`]: { flex: reach, abduct: 6 }, [`elbow_${side}`]: { flex: 14 }, [`wrist_${side}`]: { flex: -6 },
    [`shoulder_${other}`]: { flex: 6, abduct: 20 }, [`elbow_${other}`]: { flex: 24 },
    neck: { flex: 8, abduct: tilt * 6 }, head: { flex: 6, abduct: tilt * 8 },
  };
  return withPose(gesture(withPose(POSES.stand, joints), { push: 1.1, arc: 4, sway: tilt * 3, wring: 6 }), {}, { yaw });
}

/** The skeleton of one lover with its pelvis over ground point (`x`, `z`) and its lowest point `y` above the ground. */
function float(side: Side, reach: number, yaw: number, lean: number, height: number, x: number, y: number, z: number): Skeleton {
  return poseSkeleton(floatingPose(side, reach, yaw, lean), { height, position: new THREE.Vector3(x, y, z), proportions: PROPORTIONS });
}

/** Where the reaching hand ends: the tip of the wrist bone. */
const tipOf = (s: Skeleton, side: Side) => s.at(`wrist_${side}`, true);

export interface MeetingOptions {
  /** Heights of the left and right lover, in world units. */
  heights: [number, number];
  /** Where each faces, degrees of yaw (0 faces the eye, +90 faces right). */
  yaws: [number, number];
  /** How far each arm is raised, degrees from hanging, and how far each leans forward, degrees. */
  reach: number;
  lean: number;
  /** Distance between the fingertips, world units. */
  gap: number;
  /** Direction from the ground toward the light. */
  light: THREE.Vector3;
  /** The ground point midway between the two. */
  centre: THREE.Vector3;
  /** How high the left lover's pelvis floats above the ground. */
  pelvisAt: number;
}

/**
 * The left lover reaches with the right arm; the right lover reaches with the left, mirrored. The right
 * lover floats at the height, and stands over the ground point, that put its fingertips `gap` from the
 * left's along the light's ray: lower, behind, and to the right of them, so the two shadows' hands lie
 * on one another.
 */
export function meeting(o: MeetingOptions): { left: Figure; right: Figure } {
  const [hl, hr] = o.heights, [yl, yr] = o.yaws;
  // The left lover floats with its pelvis at `pelvisAt`: pose it at the ground first to see where its pelvis falls.
  const left0 = float('r', o.reach, yl, o.lean, hl, 0, 0, 0);
  const leftY = o.pelvisAt - left0.at('pelvis').y;
  const tipLeft = tipOf(left0, 'r').setY(tipOf(left0, 'r').y + leftY);
  const offset = o.light.clone().normalize().multiplyScalar(-o.gap);
  const tipRight0 = tipOf(float('l', o.reach, yr, o.lean, hr, 0, 0, 0), 'l');
  const rx = tipLeft.x + offset.x - tipRight0.x, rz = tipLeft.z + offset.z - tipRight0.z, ry = tipLeft.y + offset.y - tipRight0.y;
  // Then the pair is centred on `centre`.
  const dx = o.centre.x - rx / 2, dz = o.centre.z - rz / 2;
  const left = float('r', o.reach, yl, o.lean, hl, dx, leftY, dz), right = float('l', o.reach, yr, o.lean, hr, rx + dx, ry, rz + dz);
  return {
    left: { skeleton: left, body: flowBody(left), tip: tipOf(left, 'r') },
    right: { skeleton: right, body: flowBody(right), tip: tipOf(right, 'l') },
  };
}

/** The ground point under a figure's pelvis. */
export const footOf = (f: Figure): THREE.Vector3 => f.skeleton.at('pelvis').setY(0);

/** The figure's closed surfaces, for the depth pass and its coverage masks. */
export const figureMeshes = (f: Figure): THREE.BufferGeometry[] => bodyMeshes(f.body, 0.7);

/**
 * Plain contour hatch that follows the form: long bands run the length of each limb and wind slowly
 * round it, their lines coming in where the light leaves them dark, with an outline; the head is a
 * blank egg, thinly ringed, with no face and no cross.
 */
export function figureStrokes(f: Figure, env: ToneEnv & ViewEnv): Stroke[] {
  const out: ClothStroke[] = ribbonStrokes({ ...f.body, head: undefined }, env, FIGURE_LOOK, { bands: 6, fill: 0.58, twist: 0.3, lines: 6 });
  const head = f.body.head!;
  out.push(...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.35) }, FIGURE_LOOK, f.skeleton.height * 0.012),
    ...silhouettes(head, env, { ink: FIGURE_LOOK.edge, group: FIGURE_LOOK.contour, family: 'hatch' }));
  return out.map(st => ({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points }));
}
