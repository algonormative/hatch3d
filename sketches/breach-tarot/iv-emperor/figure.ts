import * as THREE from 'three';
import { solid, type Slab } from '../../kit/slabs.ts';
import type { Body } from '../../kit/mannequin/body.ts';
import { flowBody } from '../../kit/mannequin/gesture.ts';
import { POSES, poseSkeleton, withPose, type JointAngles, type JointName, type Proportions, type Side, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { BUTTON, COLLAR, front, lapel, opening } from '../../kit/mannequin/suit.ts';
import { Tube } from '../../kit/mannequin/tube.ts';

/**
 * The Emperor's colossus: enthroned, rigid, upright and massive. Thighs level on the seat, shins
 * plumb, feet planted side by side, the torso straight, the forearms flat along the armrests with
 * the hands over their ends; only the head turns, up and to its right. Broad shoulders and thick
 * limbs, the body cut into six planes per limb, no gesture: the power is in the stillness.
 *
 * The throne is fitted round it, so nothing cuts through anything: a plain seat block just under
 * the thighs, an armrest block each side just under the forearms and short of the hanging hands, a
 * high back slab just behind the body and the head, all on a stepped plinth the feet stand on. The
 * head is left out; the card winds the helix where it would be.
 */
export const SIT: Partial<Record<JointName, JointAngles>> = {
  hip_l: { flex: 90, abduct: 3 }, hip_r: { flex: 90, abduct: 3 },
  knee_l: { flex: 90 }, knee_r: { flex: 90 },
  shoulder_l: { flex: 0, abduct: 12, twist: 6 }, shoulder_r: { flex: 0, abduct: 12, twist: 6 },
  elbow_l: { flex: 90 }, elbow_r: { flex: 90 },
  // The hands lie over the armrest ends.
  wrist_l: { flex: -70 }, wrist_r: { flex: -70 },
  // The gaze: up, and toward the figure's right, which the turn puts at the viewer's upper left.
  neck: { flex: -24, twist: -30 }, head: { flex: -12, twist: -15 },
};
/** Broad, heavy proportions: wide shoulders and hips, a full-size head. */
export const BROAD: Proportions = { shoulderX: 1.28, hipX: 1.12 };
/** Limb and trunk thickness, 1 = canon. */
export const BUILD = 1.3;
/** The plinth: steps of this rise and tread, in canon units (the canon figure stands 24 tall). */
export const STEPS = 3, RISE = 0.85, TREAD = 1.4;
/** The trouser hem's height above the ankle, and how far past the wrist the armrest runs, in canon units. */
export const HEM = 0.9, PALM = 1.45;

/** A level frame: `z` the way it faces, `x` its left. */
export interface Frame { origin: THREE.Vector3; x: THREE.Vector3; z: THREE.Vector3 }

export function frameAt(origin: THREE.Vector3, yaw: number): Frame {
  return { origin: origin.clone().setY(0), x: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), z: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)) };
}
/** A world point in the frame: across (x), up (y), forward (z). */
export const toFrame = (f: Frame, p: THREE.Vector3) => {
  const d = p.clone().sub(f.origin);
  return new THREE.Vector3(d.dot(f.x), p.y, d.dot(f.z));
};
/** A frame point in the world. */
export const fromFrame = (f: Frame, x: number, y: number, z: number) => f.origin.clone().addScaledVector(f.x, x).addScaledVector(f.z, z).setY(y);
/** A box in the frame, x0..x1 across, y0..y1 up, z0..z1 forward, as a slab. */
export function frameBox(f: Frame, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, beat = 0): Slab {
  const c = fromFrame(f, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const sl = solid(c.x, c.y, c.z, x1 - x0, y1 - y0, z1 - z0, beat, 'stack');
  sl.ry = Math.atan2(f.z.x, f.z.z);
  return sl;
}

/** The plinth's top, in world units, for a figure of standing height `height`. */
export const plinthTop = (height: number) => STEPS * RISE * height / 24;

/** The seated skeleton: pelvis over `anchor`, turned by `yaw` (radians), feet on the plinth. */
export function seatedSkeleton(height: number, anchor: THREE.Vector3, yaw: number): Skeleton {
  const k = height / 24;
  const pose = withPose(POSES.sit, SIT, { yaw: THREE.MathUtils.radToDeg(yaw) });
  // Lifted so the feet (the leg tubes' ends, as thick as a shoe) stand on the plinth, not through it.
  return poseSkeleton(pose, { height, proportions: BROAD, position: new THREE.Vector3(anchor.x, plinthTop(height) + (0.5 * BUILD + 0.14) * k, anchor.z) });
}

/** How far forward of the frame origin the plinth's top step and its bottom step reach. */
export function plinthFronts(s: Skeleton, f: Frame, k: number): { top: number; bottom: number } {
  const toes = Math.max(...(['l', 'r'] as Side[]).map(side => toFrame(f, s.at(`ankle_${side}`, true)).z));
  const top = toes + 1.3 * k;
  return { top, bottom: top + (STEPS - 1) * TREAD * k };
}

/** The jacket: the trunk's cloth stops at the open front (the lapels and the shirt) and below the collar. */
function jacketed(trunk: Tube): Tube {
  const mask = (u: number, v: number) => {
    if (u > 0.9) return false;
    return !(u >= BUTTON - 0.02 && u <= COLLAR + 0.04 && front(v) < opening(u) + lapel(u));
  };
  return Object.assign(Object.create(Object.getPrototypeOf(trunk)) as Tube, trunk, { mask });
}

export interface Colossus {
  skeleton: Skeleton;
  body: Body;
  /** Height scale: world units per canon unit (the canon figure stands 24 tall). */
  k: number;
  /** Where each limb's cloth stops along its tube: ankles and wrists. */
  stops: Map<string, number>;
  /** The head: its centre, its radius, its up axis, the way it faces. */
  head: { centre: THREE.Vector3; r: number; axis: THREE.Vector3; face: THREE.Vector3; side: THREE.Vector3 };
  /** Seat, armrests, back, then the plinth's steps from the top down. */
  throne: Slab[];
  /**
   * The hands and shoes, each one faceted tube, one form: a mitten from inside the cuff, flat on the
   * armrest's end and curling over its front edge; a low blunt shoe from inside the trouser hem down
   * to the step and forward to a square toe.
   */
  hands: Tube[];
  shoes: Tube[];
  frame: Frame;
  /** The plinth's bottom step in the frame: what the avenue must stand clear of. */
  base: { x0: number; x1: number; z0: number; z1: number };
}

/** Where along a tube its spine comes nearest a point. */
function uNear(t: Tube, p: THREE.Vector3): number {
  let best = 0, d = Infinity;
  for (let i = 0; i <= 500; i++) { const q = t.centre(i / 500).distanceTo(p); if (q < d) { d = q; best = i / 500; } }
  return best;
}

/** The head the helix replaces: centre, radius and axes of the skull. */
export function headOf(s: Skeleton, k: number): Colossus['head'] {
  const hj = s.joints.get('head')!, ax = s.axes('head');
  return { centre: hj.origin.clone().lerp(hj.end, 0.55), r: 1.6 * k, axis: ax.y, face: ax.z, side: ax.x };
}

/** The helix's head: an egg-shaped coil from the chin to the crown, wound round the head's axis. */
export function headCoil(h: Colossus['head'], turns = 2.1): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const N = 220;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const along = (-0.8 + 1.95 * t) * h.r;
    const egg = Math.sqrt(Math.max(0.04, 1 - (along / (1.12 * h.r)) ** 2)) * (along > 0 ? 1 : 0.88 + 0.12 * (1 + along / h.r));
    const th = 2 * Math.PI * turns * t + Math.PI / 2;
    pts.push(h.centre.clone().addScaledVector(h.axis, along)
      .addScaledVector(h.side, Math.cos(th) * egg * h.r).addScaledVector(h.face, Math.sin(th) * egg * h.r));
  }
  return pts;
}

/** The seated colossus and the throne fitted to it, a small clearance kept between them everywhere. */
export function colossus(height: number, anchor: THREE.Vector3, yaw: number): Colossus {
  const k = height / 24;
  const s = seatedSkeleton(height, anchor, yaw);
  const flow = flowBody(s, { facets: 6, build: BUILD, bow: 0.015 });
  const body: Body = { ...flow, trunk: jacketed(flow.trunk), head: undefined };
  // The sleeves stop at the wrists. The trousers stop at a level hem a little above the ankle,
  // where the shin is plumb, so the shoe can stand under it.
  const stops = new Map<string, number>();
  for (const side of ['l', 'r'] as Side[]) {
    const leg = body.limbs.find(t => t.id === `leg_${side}`)!, arm = body.limbs.find(t => t.id === `arm_${side}`)!;
    const uKnee = uNear(leg, s.at(`knee_${side}`)), uAnkle = uNear(leg, s.at(`ankle_${side}`));
    const hemY = s.at(`ankle_${side}`).y + HEM * k;
    let u = uKnee;
    while (u < uAnkle && leg.centre(u).y > hemY) u += 0.001;
    stops.set(leg.id, u);
    stops.set(arm.id, uNear(arm, s.at(`wrist_${side}`)));
  }
  const head = headOf(s, k);

  // The throne, fitted in its own frame round everything the figure puts near it.
  const f = frameAt(anchor, yaw);
  const gap = 0.06 * k;
  const P = plinthTop(height);
  const samples = (t: Tube, u0 = 0, u1 = 1) => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= 160; i++) for (let j = 0; j < 24; j++) out.push(toFrame(f, t.point(u0 + (u1 - u0) * i / 160, j / 24)));
    return out;
  };
  const legs = body.limbs.filter(t => t.id.startsWith('leg')), arms = body.limbs.filter(t => t.id.startsWith('arm'));
  const trunkPts = samples(body.trunk), legPts = legs.flatMap(t => samples(t));
  const coilPts = headCoil(head).map(p => toFrame(f, p));
  const knees = (['l', 'r'] as Side[]).map(side => toFrame(f, s.at(`knee_${side}`)));
  const kneeZ = Math.min(...knees.map(q => q.z)), kneeY = Math.min(...knees.map(q => q.y));
  // The back stands behind the body and the head; its front face is the throne's rear.
  const zBack = Math.min(...trunkPts.map(q => q.z), ...coilPts.map(q => q.z - 0.35 * k)) - gap;
  // The seat: from the back to just behind the calves, its top just under the thighs.
  // The calves: leg points below the thighs' undersides.
  const shins = legPts.filter(q => q.y < kneeY - 1.8 * BUILD * k);
  const seatFront = Math.min(kneeZ - 1.15 * k, Math.min(...shins.map(q => q.z)) - gap);
  const seatTop = Math.min(...[...trunkPts, ...legPts].filter(q => q.z > zBack && q.z < seatFront).map(q => q.y)) - gap;
  // An armrest each side of the seat, under the forearm and clear of the thigh beside it: broad, so
  // the far one shows past the thighs, and long enough for the palm to lie flat on its end.
  const rests = (['l', 'r'] as Side[]).map(side => {
    const sign = side === 'l' ? 1 : -1;
    const elbow = toFrame(f, s.at(`elbow_${side}`)), wrist = toFrame(f, s.at(`wrist_${side}`));
    const fore = elbow.clone().lerp(wrist, 0.5);
    const thigh = legPts.filter(q => Math.sign(q.x) === sign && q.y > seatTop && q.z < seatFront + 2 * k);
    const inner = Math.max(Math.abs(fore.x) - 0.7 * k, Math.max(...thigh.map(q => Math.abs(q.x))) + 2 * gap);
    const outer = Math.max(inner + 2.6 * k, Math.abs(fore.x) + 1.7 * k);
    const arm = arms.find(t => t.id === `arm_${side}`)!;
    const uElbow = uNear(arm, s.at(`elbow_${side}`)), uWrist = stops.get(arm.id)!;
    const top = Math.min(...samples(arm, uElbow - 0.06, uWrist).map(q => q.y)) - gap;
    return { side, sign, inner, outer, zFront: wrist.z + PALM * k, top, wrist };
  });
  const [L, R] = rests;
  const crown = Math.max(...coilPts.map(q => q.y));
  const backZ0 = zBack - 1.5 * k;
  const fronts = plinthFronts(s, f, k);
  const throne: Slab[] = [
    frameBox(f, -R.inner, L.inner, P, seatTop, zBack, seatFront),
    frameBox(f, L.inner, L.outer, P, L.top, zBack, L.zFront),
    frameBox(f, -R.outer, -R.inner, P, R.top, zBack, R.zFront),
    frameBox(f, -R.outer, L.outer, P, crown + 2.6 * k, backZ0, zBack),
  ];
  let base = { x0: 0, x1: 0, z0: 0, z1: 0 };
  for (let i = 0; i < STEPS; i++) {
    const out = (0.5 + 0.8 * i) * k;
    base = { x0: -R.outer - out, x1: L.outer + out, z0: backZ0 - out, z1: fronts.top + i * TREAD * k };
    throne.push(frameBox(f, base.x0, base.x1, P - (i + 1) * RISE * k, P - i * RISE * k, base.z0, base.z1));
  }

  // The hands: each one mitten, a single faceted tube that leaves the cuff, lies flat along the
  // armrest's end and curls over its front edge to hang down its face, fingertips blunt. Its section
  // is broad and flat, six planes round, the flat side down.
  const hands: Tube[] = [];
  const hw = 0.7 * k, ht = 0.22 * k;
  for (const r of rests) {
    const sg = r.sign, zF = r.zFront, T = r.top;
    const hx = sg * Math.max(Math.abs(r.wrist.x), r.inner + hw + 2 * gap);
    const lie = T + gap + 0.9 * ht;
    const spine = [
      new THREE.Vector3(sg * Math.abs(r.wrist.x), lie + 0.35 * k, r.wrist.z - 0.3 * k),
      new THREE.Vector3(hx, lie, r.wrist.z + 0.5 * k),
      new THREE.Vector3(hx, lie, zF - 0.35 * k),
      new THREE.Vector3(hx, T + 0.24 * k, zF + 0.24 * k),
      new THREE.Vector3(hx, T - 0.35 * k, zF + gap + 0.9 * ht),
      new THREE.Vector3(hx, T - 0.95 * k, zF + gap + 0.9 * ht),
    ].map(p => fromFrame(f, p.x, p.y, p.z));
    hands.push(new Tube(`hand_${r.side}`, spine, [[0, 0.62 * hw, 1.6 * ht], [0.2, hw, ht], [0.75, hw, ht], [1, 0.9 * hw, 0.9 * ht]],
      f.z.clone().add(new THREE.Vector3(0, 1, 0)).normalize(), 1, [0, 0.3 * k], undefined, 6));
  }
  // The shoes: each one low blunt shoe, a single faceted tube from inside the trouser hem down to the
  // heel and forward along the step to a square toe, its flat sole planted just above the step.
  const shoes: Tube[] = [];
  const sw = 0.62 * k, sh = 0.42 * k;
  for (const side of ['l', 'r'] as Side[]) {
    const a = toFrame(f, s.at(`ankle_${side}`)), toe = toFrame(f, s.at(`ankle_${side}`, true));
    const fy = Math.atan2(toe.x - a.x, toe.z - a.z);
    const ff = frameAt(fromFrame(f, a.x, 0, a.z), Math.atan2(f.z.x, f.z.z) + fy);
    const hem = s.at(`ankle_${side}`).y + HEM * k, sole = P + gap + 0.87 * sh;
    const spine = [
      new THREE.Vector3(0, hem + 0.3 * k, 0),
      new THREE.Vector3(0, sole + 0.55 * k, 0.05 * k),
      new THREE.Vector3(0, sole, 0.9 * k),
      new THREE.Vector3(0, sole, 2.6 * k),
    ].map(p => fromFrame(ff, p.x, p.y, p.z));
    shoes.push(new Tube(`shoe_${side}`, spine, [[0, 0.82 * sw, 0.82 * sw], [0.3, sw, 1.25 * sh], [0.62, sw, sh], [1, sw, 0.9 * sh]],
      ff.z.clone().add(new THREE.Vector3(0, 1, 0)).normalize(), 1, [0, 0.14 * k], undefined, 6));
  }
  return { skeleton: s, body, k, stops, head, throne, hands, shoes, frame: f, base };
}

/** A tube's surface only up to `stop` along it: the sleeve or trouser without the hand or foot. */
export function cutTube(t: Tube, stop: number): Tube {
  return Object.assign(Object.create(Object.getPrototypeOf(t)) as Tube, t, {
    point: (u: number, v: number, lift = 0) => t.point(u * stop, v, lift),
    normal: (u: number, v: number) => t.normal(u * stop, v),
    centre: (u: number) => t.centre(u * stop),
  });
}
