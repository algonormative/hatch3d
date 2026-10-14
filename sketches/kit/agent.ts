import * as THREE from 'three';
import { solid, type Slab } from './slabs.ts';
import type { Body } from './mannequin/body.ts';
import { flowBody } from './mannequin/gesture.ts';
import { POSES, poseSkeleton, withPose, type JointAngles, type JointName, type Proportions, type Side, type Skeleton } from './mannequin/skeleton.ts';
import { BUTTON, COLLAR, front, lapel, opening } from './mannequin/suit.ts';
import { Tube } from './mannequin/tube.ts';

/**
 * The agent: the Plenipotentiary, a pinstriped suit with its limbs cut into flat planes and a helix
 * coil where the head would be. `agentFigure` poses and builds the suit's tubes (the jacketed trunk
 * and the limbs, no head) and measures where the sleeves and trouser legs stop and where the head
 * sits; the card draws them with `pinstripeTube` / `silhouettes` / `suitFront` and winds the helix
 * along `headCoil(head)`. Whatever the figure sits on or beside (a throne, a floor, a table) stays
 * in the card. The frame helpers below place such things in the figure's own level frame.
 *
 * Zoomed in (a bust from below that fills the sheet; `sketches/agent-bust/sketch.ts` is the worked example):
 * - Camera: a raw `THREE.PerspectiveCamera` (not `horizonCamera`, which keeps the horizon level) on the figure's
 *   front, below the head and looking up about 25 degrees, fitted so the shoulders fill the sheet's width.
 * - Scale: the pinstripe pitch is in world units (about 0.1 whatever the figure's size), so the figure must be built
 *   big enough for the stripes to land 0.55 to 1.1 mm apart on the page: `height / 24` of 6 or more. Below about 3 the
 *   stripes go sparse and the darkest tone is lost. Cost grows with the square of that scale.
 * - Depth: `fitDepthRange(view, geometries, 0.1, { exact: true })`. The default sphere fit lets one big background slab
 *   swallow the eye, `near` collapses to 0.5 and the slabs' hatch is cut to dashes.
 * - Hidden lines: `hiddenBias(view, 0.15 * k, distance)` for the figure, tested in bands of eye distance. The Emperor's
 *   0.45 * k lets back strokes near a silhouette through at this range.
 * - Outlines: `silhouettes(tube, { forward, eye })`; `forward` alone is up to 40 degrees off at this range.
 * - Tone: `toneField(ctx, head / k, { reach: 2 })`, since the default reach (3 to 8 canon units) covers a whole bust.
 * - Censor bar: a page-space `hatchedBar` 1.75 by 0.36 of the projected head (`2 * head.r` times the page millimetres
 *   per unit at the head), across the eyes.
 * - Background: `facetStrokes` slabs at `pitch = mm / mmPerUnit(slab)`, not `slabStrokes`, whose pitch is in world units
 *   and goes coarse when zoomed.
 */

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

/** The head the helix replaces: its centre, its radius, its up axis, the way it faces and its side. */
export interface AgentHead { centre: THREE.Vector3; r: number; axis: THREE.Vector3; face: THREE.Vector3; side: THREE.Vector3 }

/** Where along a tube its spine comes nearest a point. */
export function uNear(t: Tube, p: THREE.Vector3): number {
  let best = 0, d = Infinity;
  for (let i = 0; i <= 500; i++) { const q = t.centre(i / 500).distanceTo(p); if (q < d) { d = q; best = i / 500; } }
  return best;
}

/** The head the helix replaces: centre, radius and axes of the skull. */
export function headOf(s: Skeleton, k: number): AgentHead {
  const hj = s.joints.get('head')!, ax = s.axes('head');
  return { centre: hj.origin.clone().lerp(hj.end, 0.55), r: 1.6 * k, axis: ax.y, face: ax.z, side: ax.x };
}

/** The helix's head: an egg-shaped coil from the chin to the crown, wound round the head's axis. */
export function headCoil(h: AgentHead, turns = 2.1): THREE.Vector3[] {
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

/** A tube's surface only up to `stop` along it: the sleeve or trouser without the hand or foot. */
export function cutTube(t: Tube, stop: number): Tube {
  return Object.assign(Object.create(Object.getPrototypeOf(t)) as Tube, t, {
    point: (u: number, v: number, lift = 0) => t.point(u * stop, v, lift),
    normal: (u: number, v: number) => t.normal(u * stop, v),
    centre: (u: number) => t.centre(u * stop),
  });
}

/** The jacket: the trunk's cloth stops at the open front (the lapels and the shirt) and below the collar. */
export function jacketed(trunk: Tube): Tube {
  const mask = (u: number, v: number) => {
    if (u > 0.9) return false;
    return !(u >= BUTTON - 0.02 && u <= COLLAR + 0.04 && front(v) < opening(u) + lapel(u));
  };
  return Object.assign(Object.create(Object.getPrototypeOf(trunk)) as Tube, trunk, { mask });
}

/** The trouser hem's height above the ankle, in canon units (the canon figure stands 24 tall). */
export const HEM = 0.9;

export interface AgentOptions {
  /** Standing height, world units. */
  height: number;
  /** Where the pelvis stands over (x, z); its y is the ground the skeleton's lowest point rests on, before `lift`. */
  anchor: THREE.Vector3;
  /** Which way it faces, radians about the vertical. */
  yaw: number;
  /** Joint overrides on top of `base`. */
  pose?: Partial<Record<JointName, JointAngles>>;
  /** The named pose the overrides start from (default 'sit'). */
  base?: keyof typeof POSES;
  /** Stylized proportions (default: the canon). */
  proportions?: Proportions;
  /** Limb and trunk thickness, 1 = canon (default 1). */
  build?: number;
  /** Planes per section, 0 = smooth (default 6). */
  facets?: number;
  /** How far each limb bows off the straight line between its joints (default 0.015). */
  bow?: number;
  /** The trouser hem's height above the ankle, canon units (default `HEM`). */
  hem?: number;
  /**
   * Added to `anchor.y`: how high the skeleton's lowest point rests. The leg tubes end at the ankle and
   * toe, as thick as a shoe, so a figure that stands on a surface is lifted by that thickness
   * (and by the surface's height); the Emperor passes its plinth's top plus that.
   */
  lift?: number;
}

export interface Agent {
  skeleton: Skeleton;
  /** The jacketed trunk and the limbs; the head is left out, the card winds the helix where it would be. */
  body: Body;
  /** Height scale: world units per canon unit (the canon figure stands 24 tall). */
  k: number;
  /** Where each limb's cloth stops along its tube: the trouser hems and the wrists. */
  stops: Map<string, number>;
  head: AgentHead;
}

/** The agent's posed skeleton alone: cheap, for laying a figure out before building it. */
export function agentSkeleton(o: Pick<AgentOptions, 'height' | 'anchor' | 'yaw' | 'pose' | 'base' | 'proportions' | 'lift'>): Skeleton {
  const pose = withPose(POSES[o.base ?? 'sit'], o.pose, { yaw: THREE.MathUtils.radToDeg(o.yaw) });
  return poseSkeleton(pose, { height: o.height, proportions: o.proportions, position: new THREE.Vector3(o.anchor.x, o.anchor.y + (o.lift ?? 0), o.anchor.z) });
}

/** The agent: posed, faceted, jacketed, its sleeves and trousers stopped at the wrists and a level hem, and its head. */
export function agentFigure(o: AgentOptions): Agent {
  const k = o.height / 24;
  const s = agentSkeleton(o);
  const flow = flowBody(s, { facets: o.facets ?? 6, build: o.build ?? 1, bow: o.bow ?? 0.015 });
  const body: Body = { ...flow, trunk: jacketed(flow.trunk), head: undefined };
  // The sleeves stop at the wrists. The trousers stop at a level hem a little above the ankle,
  // where the shin is plumb, so the shoe can stand under it.
  const stops = new Map<string, number>();
  for (const side of ['l', 'r'] as Side[]) {
    const leg = body.limbs.find(t => t.id === `leg_${side}`)!, arm = body.limbs.find(t => t.id === `arm_${side}`)!;
    const uKnee = uNear(leg, s.at(`knee_${side}`)), uAnkle = uNear(leg, s.at(`ankle_${side}`));
    const hemY = s.at(`ankle_${side}`).y + (o.hem ?? HEM) * k;
    let u = uKnee;
    while (u < uAnkle && leg.centre(u).y > hemY) u += 0.001;
    stops.set(leg.id, u);
    stops.set(arm.id, uNear(arm, s.at(`wrist_${side}`)));
  }
  return { skeleton: s, body, k, stops, head: headOf(s, k) };
}
