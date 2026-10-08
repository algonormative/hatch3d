import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { clamp, n } from '../../kit/params.ts';
import { pageOf } from '../../kit/perspective.ts';
import type { Stroke } from '../../kit/types.ts';
import { bodyMeshes, contourTube, type Body } from '../../kit/mannequin/body.ts';
import { drape, drapeMesh, drapeStrokes } from '../../kit/mannequin/drape.ts';
import { ELONGATED, flowBody, gesture } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look } from '../../kit/mannequin/hatch.ts';
import { POSES, poseSkeleton, withPose, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { Tube, silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import type { Scale } from './peak.ts';

/**
 * The hermit and the lantern. The figure is the kit's flowing mannequin in a hooded cloak, seen in
 * three-quarter view, one hand on a staff and the other raising a lantern; the lantern is a plain
 * frame round the card's helix, drawn in its native inks, which is also the only light there is.
 */

/** The hermit's skeleton, standing on `stand` (a point on the summit), looking out to the left. */
export function hermitSkeleton(ctx: SketchContext, stand: THREE.Vector3, height: number): Skeleton {
  const yaw = n(ctx, 'yaw', -60, -110, -20), stoop = n(ctx, 'stoop', 9, 0, 25), raise = n(ctx, 'raise', 118, 70, 160);
  const joints = {
    // The far arm lifts the lantern out ahead and up, clear of the body; the near one plants the staff by his feet.
    shoulder_r: { flex: raise, abduct: 14 }, elbow_r: { flex: 16 }, wrist_r: { flex: -8 },
    shoulder_l: { flex: 30, abduct: 6 }, elbow_l: { flex: 24 }, wrist_l: { flex: -14 },
    hip_l: { flex: 8, abduct: 3 }, knee_l: { flex: 6 }, hip_r: { flex: -4, abduct: 3 }, knee_r: { flex: 10 },
    neck: { flex: -8 }, head: { flex: -6 },
  };
  const pose = withPose(gesture(withPose(POSES.stand, joints), { push: 1, arc: stoop, sway: 2, lean: 2 }), {}, { yaw });
  return poseSkeleton(pose, { height, position: stand, proportions: { ...ELONGATED, head: 0.95, neck: 1.2 } });
}

/** Where the raised hand closes on the lantern's cord. */
export const lanternHand = (s: Skeleton): THREE.Vector3 => s.at('wrist_r').lerp(s.at('wrist_r', true), 0.55);

export interface Lantern {
  slabs: Slab[];
  /** Cord and posts, as world-space lines. */
  lines: THREE.Vector3[][];
  /** The light: the middle of the coil. */
  centre: THREE.Vector3;
  strokes: ReturnType<typeof helixAlong>['strokes'];
  meshes: THREE.BufferGeometry[];
}

/** The lantern hung from `hand`: cap and base slabs, four posts, and the helix coiled tight between them. */
export function buildLantern(ctx: SketchContext, view: THREE.PerspectiveCamera, sc: Scale, hand: THREE.Vector3): Lantern {
  const mm = n(ctx, 'lantern', 18, 6, 24);
  const Lh = mm / sc.mmPerUnit(hand);
  const cord = 0.2 * Lh, capH = 0.07 * Lh, clear = 0.05 * Lh, half = 0.24 * Lh;
  const capTop = hand.y - cord, capBottom = capTop - capH, baseTop = capTop - Lh + capH, baseBottom = capTop - Lh;
  const cap = solid(hand.x, capTop - capH / 2, hand.z, 2 * half, capH, 2 * half, 0, 'stub');
  const base = solid(hand.x, baseBottom + capH / 2, hand.z, 2 * half, capH, 2 * half, 1, 'stub');
  const lines: THREE.Vector3[][] = [[hand.clone(), new THREE.Vector3(hand.x, capTop, hand.z)]];
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    lines.push([new THREE.Vector3(hand.x + a * half * 0.86, baseTop, hand.z + b * half * 0.86), new THREE.Vector3(hand.x + a * half * 0.86, capBottom, hand.z + b * half * 0.86)]);
  }
  // The coil is built built larger and brought back: the kit's wiggles are fixed in world units.
  const S = n(ctx, 'helixScale', 24, 4, 60);
  const bottom = baseTop + clear, top = capBottom - clear, len = top - bottom;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const column = [bottom, bottom + len / 2, top].map(y => new THREE.Vector3(hand.x, y, hand.z).multiplyScalar(S));
  const turns = n(ctx, 'coilTurns', 2.5, 1.5, 6), thin = Math.round(n(ctx, 'coilThin', 6, 1, 12));
  const made = helixAlong(ctx, sv, new THREE.CatmullRomCurve3(column, false, 'centripetal'), {
    radius: n(ctx, 'coilRadius', 0.1, 0.03, 0.15) * Lh * S, width: n(ctx, 'coilWidth', 0.1, 0.04, 0.2) * Lh * S, pitch: len / turns * S, spread: 0.012 * Lh * S, narrow: 0.01 * Lh * S,
    twist: 0.15, density: n(ctx, 'coilDensity', 0, 0, 1), interruption: n(ctx, 'coilRests', 0, 0, 1),
  });
  return {
    slabs: [cap, base], lines, centre: new THREE.Vector3(hand.x, (bottom + top) / 2, hand.z),
    // The ribbons' edges and spine always draw; of their laminations and ribs only every few-th, so a coil this small reads as two strands.
    strokes: made.strokes.filter((h, i) => h.points.length > 100 || i % thin === 0).map(h => ({ ...h, points: h.points.map(q => q.clone().multiplyScalar(1 / S)) })),
    meshes: made.meshes.map(g => g.scale(1 / S, 1 / S, 1 / S)),
  };
}

export interface Hermit { strokes: Stroke[]; meshes: THREE.BufferGeometry[] }

/**
 * The figure drawn in plain carbon: contour rings on every limb, the cloak's fall and folds, a hood
 * with a point behind, a faceted staff. The light is the lantern, so the side toward it falls to
 * paper and the back of the cloak is dark.
 */
export function hermitFigure(ctx: SketchContext, view: THREE.PerspectiveCamera, s: Skeleton, lamp: THREE.Vector3, stand: THREE.Vector3): Hermit {
  const H = s.height, k = H / 24;
  const body = flowBody(s, { toes: 'point' });
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const env = {
    forward, density: 0.4,
    screen: (p: THREE.Vector3) => pageOf(view, p),
    dark: (p: THREE.Vector3, normal: THREE.Vector3) => {
      const to = lamp.clone().sub(p);
      return clamp(0.98 - 1.05 * Math.max(0, normal.dot(to) / to.length()), 0, 1);
    },
  };
  const look: Look = { ...LOOK, cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure', family: 'hatch' };
  const cloak = drape(body, {
    rng: ctx.random('hermit-cloak'), attach: 'shoulders', length: n(ctx, 'cloakLength', 0.95, 0.5, 1.1), folds: 9, depth: 0.1, flare: 0.07,
    gap: 0.015 * H, open: n(ctx, 'cloakOpen', 1.2, 0, 2),
  });
  // The hood: wider than the head, a long point swept back behind it, and an opening on the face side
  // (the mask), the hollow of which is drawn dark.
  const hj = s.joints.get('head')!;
  const up = hj.end.clone().sub(hj.origin).normalize();
  const front = s.axes('head').z;
  const back = front.clone().negate();
  // The opening, in the hood's own (u along, v round) coordinates: v = 0.25 faces the front.
  const OPEN = { u0: 0.2, u1: 0.6, v: 0.25, dv: 0.11 };
  const inOpening = (u: number, v: number) => u > OPEN.u0 && u < OPEN.u1 && Math.abs(((v - OPEN.v + 0.5) % 1 + 1) % 1 - 0.5) < OPEN.dv;
  const hood = new Tube('hood', [
    hj.origin.clone().addScaledVector(up, -0.5 * k), hj.origin.clone().lerp(hj.end, 0.5),
    hj.end.clone().addScaledVector(up, 0.3 * k).addScaledVector(back, 0.4 * k), hj.end.clone().addScaledVector(up, 2.7 * k).addScaledVector(back, 2.5 * k),
  ], [[0, 1.4 * k, 1.45 * k], [0.3, 1.8 * k, 1.9 * k], [0.58, 1.55 * k, 1.7 * k], [0.8, 0.8 * k, 0.95 * k], [1, 0.05 * k, 0.05 * k]],
  front, 1, [0.3 * k, 0.1 * k], (u, v) => !inOpening(u, v));
  const lift = 0.012 * k;
  const arc = (u0: number, v0: number, u1: number, v1: number, steps = 12) =>
    Array.from({ length: steps + 1 }, (_, i) => hood.point(u0 + (u1 - u0) * i / steps, v0 + (v1 - v0) * i / steps, lift));
  const { u0, u1, v: vc, dv } = OPEN;
  const rim = [...arc(u0, vc - dv, u0, vc + dv), ...arc(u0, vc + dv, u1, vc + dv), ...arc(u1, vc + dv, u1, vc - dv), ...arc(u1, vc - dv, u0, vc - dv)];
  // The hollow: a few close rules across it and a few down it, so it is dark.
  const hollow: THREE.Vector3[][] = [];
  for (let i = 1; i <= 4; i++) hollow.push(arc(u0 + (u1 - u0) * i / 5, vc - dv, u0 + (u1 - u0) * i / 5, vc + dv, 8));
  for (let i = 1; i <= 3; i++) hollow.push(arc(u0, vc - dv + 2 * dv * i / 4, u1, vc - dv + 2 * dv * i / 4, 8));
  // The staff stands on the summit at the near hand, a little over head height.
  const grip = s.at('wrist_l').lerp(s.at('wrist_l', true), 0.55);
  const r = 0.24 * k;
  // Planted a little ahead of the hand, so it stands clear of the hood.
  const ahead = s.axes('pelvis').z.clone().setY(0).normalize().multiplyScalar(n(ctx, 'staffAhead', 0.04, -0.1, 0.2) * H);
  const foot = new THREE.Vector3(grip.x + ahead.x, stand.y, grip.z + ahead.z), topAt = foot.clone().setY(stand.y + 1.12 * H);
  const staff = new Tube('staff', [foot, foot.clone().lerp(topAt, 0.5), topAt], [[0, r, r], [1, r, r]], new THREE.Vector3(0, 0, 1), 1, [0, 0], undefined, 6);

  const edge = { ink: 'carbon' as const, group: 'figure', family: 'hatch' as const };
  const cloth: ClothStroke[] = [
    // The arms are plain outlines; the body and legs under the cloak keep their rings.
    ...[body.trunk, ...body.limbs].flatMap(t => [...(t.id.startsWith('arm') ? [] : contourTube(t, env, look, 0.6)), ...silhouettes(t, env, edge)]),
    ...drapeStrokes(cloak, env, look),
    // The hood is mostly paper: its outline, a few rings where it turns from the light, the rim of its opening and the dark hollow.
    ...contourTube(hood, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.35) }, look, 0.5), ...silhouettes(hood, env, edge),
    { ink: 'carbon', group: 'figure', family: 'hatch', points: rim },
    ...hollow.map((points): ClothStroke => ({ ink: 'carbon', group: 'figure', family: 'hatch', points })),
    ...silhouettes(staff, env, edge),
  ];
  const headless: Body = { ...body, head: undefined };
  return {
    strokes: cloth.map(st => ({ ink: st.ink, group: 'figure', family: st.family ?? 'hatch', points: st.points })),
    meshes: [...bodyMeshes(headless, 0.8), drapeMesh(cloak), hood.mesh(80, 32), staff.mesh(40, 24)],
  };
}

/** The lantern frame's strokes: cap and base slab outlines, cord and posts. */
export function lanternFrame(l: Lantern, light: THREE.Vector3, eye: THREE.Vector3): Stroke[] {
  const out: Stroke[] = [];
  for (const sl of l.slabs) for (const st of facetStrokes(sl, light, eye, true)) out.push({ ink: 'carbon', group: 'lantern', family: 'edge', points: st.points });
  for (const points of l.lines) out.push({ ink: 'carbon', group: 'lantern', family: 'edge', points });
  return out;
}

export const lanternMeshes = (l: Lantern): THREE.BufferGeometry[] => [...l.slabs.map(slabGeometry), ...l.meshes];
