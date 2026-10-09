import * as THREE from 'three';
import { bodyMeshes, contourTube, type Body } from '../../kit/mannequin/body.ts';
import { ELONGATED, figureBands, flowBody, gesture, ribbonStrokes } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { POSES, poseSkeleton, withPose, type JointAngles, type JointName, type Pose, type Side, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import type { ClothStroke, Tube, ViewEnv } from '../../kit/mannequin/tube.ts';
import type { Stroke } from '../../kit/types.ts';

/**
 * The two who stay: the kit's mannequin, bare, in plain carbon, standing on the ground at ease and
 * turned inward toward the pillar: weight on one leg, shoulders loose, the head tipped a little up
 * to what they look at. The arm on the pillar's side hangs a little forward, and its wrist is where
 * the leash lands.
 */
export interface Figure { skeleton: Skeleton; body: Body; wrist: THREE.Vector3 }

/** Ink and group for the figures: all carbon, plain beside the pillar's hatch. */
const FIGURE_LOOK: Look = { ...LOOK, cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure-edge', family: 'hatch' };
const PROPORTIONS = { ...ELONGATED, head: 0.95, neck: 1.35 };
const BUILD = 1.3;

/**
 * `near` is the side whose arm is toward the eye (and the pillar's side): the right arm for the
 * figure on the left, facing right; the left arm for the figure on the right. `tilt` is how far the
 * head inclines, in degrees, which the seed varies a little.
 */
function relaxed(near: Side, yaw: number, tilt: number): Pose {
  const far: Side = near === 'l' ? 'r' : 'l';
  const t = near === 'l' ? 1 : -1;
  const joints: Partial<Record<JointName, JointAngles>> = {
    // Weight on the far leg; the near knee soft and the foot easy.
    [`hip_${near}`]: { flex: 7, abduct: 3 }, [`knee_${near}`]: { flex: 9 }, [`ankle_${near}`]: { flex: -5 },
    [`hip_${far}`]: { flex: -3, abduct: 6 }, [`knee_${far}`]: { flex: 3 },
    // The near arm hangs a little forward, elbow soft, the leash on its wrist; the other hangs loose.
    [`shoulder_${near}`]: { flex: 38, abduct: 26 }, [`elbow_${near}`]: { flex: 16 }, [`wrist_${near}`]: { flex: -8 },
    [`shoulder_${far}`]: { flex: -8, abduct: 9 }, [`elbow_${far}`]: { flex: 14 },
    spine: { flex: 3 }, chest: { flex: 3 },
    neck: { flex: -5, abduct: t * tilt }, head: { flex: -4, abduct: t * tilt },
  };
  return withPose(gesture(withPose(POSES.stand, joints), { push: 1.05, arc: 3, sway: t * 3, wring: 3 }), {}, { yaw });
}

/**
 * A figure standing with its pelvis over ground point (`x`, `z`), `height` tall, facing `yaw` degrees
 * (+90 faces right, -90 faces left, 0 faces the eye).
 */
export function standing(near: Side, yaw: number, height: number, x: number, z: number, tilt: number): Figure {
  const skeleton = poseSkeleton(relaxed(near, yaw, tilt), { height, position: new THREE.Vector3(x, 0, z), proportions: PROPORTIONS });
  return { skeleton, body: flowBody(skeleton, { build: BUILD, toes: 'point' }), wrist: skeleton.at(`wrist_${near}`) };
}

/** The figure's closed surfaces, for the depth pass and its coverage masks. */
export const figureMeshes = (f: Figure): THREE.BufferGeometry[] => bodyMeshes(f.body, 0.7);

/**
 * A head's outline on the page: the hull of its surface as the eye sees it, drawn through the surface
 * points that make it. The kit's `silhouettes` trace along the tube and so miss a crown or a chin
 * seen nearly end-on, which is how a head tipped a little back is seen from this low an eye.
 */
function headOutline(head: Tube, screen: ToneEnv['screen'], look: Look): ClothStroke {
  const pts: { p: THREE.Vector3; x: number; y: number }[] = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j < 48; j++) {
    const p = head.point(i / 40, j / 48, 0.012);
    const q = screen(p);
    pts.push({ p, x: q.x, y: q.y });
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [], upper: typeof pts = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return { ink: look.edge, group: look.contour, family: 'hatch', points: [...ring, ring[0]].map(q => q.p) };
}

/**
 * Plain contour hatch that follows the form: long bands run the length of each limb and wind slowly
 * round it, their lines coming in where the light leaves them dark, with an outline; the head is a
 * blank egg, thinly ringed, outlined by its hull, with no face. Its bands are the print's at tabloid and fewer on a
 * smaller card (`figureBands`), where a figure fifteen millimetres tall would crowd them.
 */
export function figureStrokes(f: Figure, env: ToneEnv & ViewEnv): Stroke[] {
  const out: ClothStroke[] = ribbonStrokes({ ...f.body, head: undefined }, env, FIGURE_LOOK, { bands: figureBands(), fill: 0.58, twist: 0.3, lines: 6 });
  const head = f.body.head!;
  out.push(...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.35) }, FIGURE_LOOK, f.skeleton.height * 0.012),
    headOutline(head, env.screen, FIGURE_LOOK));
  return out.map(st => ({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points }));
}
