import * as THREE from 'three';
import { bodyMeshes, contourTube, type Body } from '../../kit/mannequin/body.ts';
import { ELONGATED, figureBands, flowBody, ribbonStrokes, squareRef } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { poseSkeleton, type Pose, type Side, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { Tube, type ClothStroke, type Key, type ViewEnv } from '../../kit/mannequin/tube.ts';
import type { Stroke } from '../../kit/types.ts';

/**
 * The Magician as a body, built the way the Lovers and the Devil build theirs: the kit's mannequin,
 * bare, in plain carbon, fuller than the canon, one tube to each limb so a hand and a foot are one
 * silhouette each. The arms end in a fist (a short, rounded swelling in place of the open hand).
 */
export interface Figure { skeleton: Skeleton; body: Body }

/** Ink and group for the figure: all carbon. */
const FIGURE_LOOK: Look = { ...LOOK, cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure-edge', family: 'hatch' };
const PROPORTIONS = { ...ELONGATED, head: 0.95, neck: 1.35 };
const BUILD = 1.3;

/** The arm on `side` as one tube, shoulder to a clenched fist: the kit's arm, its hand drawn in to a fist. */
function armWithFist(s: Skeleton, side: Side): Tube {
  const k = s.height / 24 * BUILD;
  const h: 1 | -1 = side === 'l' ? 1 : -1;
  const sh = s.axes(`shoulder_${side}`), elbow = s.axes(`elbow_${side}`);
  const wrist = s.at(`wrist_${side}`), tip = s.at(`wrist_${side}`, true);
  const chain = [s.at(`shoulder_${side}`), s.at(`elbow_${side}`), wrist, wrist.clone().lerp(tip, 0.62)];
  const bows = [sh.x.clone().multiplyScalar(h), elbow.z, null];
  const radii = [0.95, 0.8, 0.58, 0.64, 0.4, 0.62, 0.5];
  const bow = 0.06;
  const lengths = chain.slice(1).map((p, i) => p.distanceTo(chain[i]));
  const total = lengths.reduce((a, b) => a + b, 0);
  const pts = [chain[0]];
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
  return new Tube(`arm_${side}`, pts, keys.map(([u, rx, ry]): Key => [u, rx * k, ry * k]), squareRef(chain, [sh.z, sh.x]), h, [0.8 * k, 0.42 * k]);
}

/** The body for `pose`, `height` tall, standing with its feet on the ground at `position`. */
export function bodyFigure(pose: Pose, height: number, position: THREE.Vector3): Figure {
  const skeleton = poseSkeleton(pose, { height, position, proportions: PROPORTIONS });
  const body = flowBody(skeleton, { build: BUILD, toes: 'point' });
  const limbs = body.limbs.map(t => t.id === 'arm_l' ? armWithFist(skeleton, 'l') : t.id === 'arm_r' ? armWithFist(skeleton, 'r') : t);
  return { skeleton, body: { ...body, limbs } };
}

/** The figure's closed surfaces, for the depth pass. */
export const figureMeshes = (f: Figure): THREE.BufferGeometry[] => bodyMeshes(f.body, 0.7);

/**
 * A head's outline on the page: the hull of its surface as the eye sees it, drawn through the surface
 * points that make it. The kit's `silhouettes` trace along the tube and so miss a crown or a chin
 * seen nearly end-on, which is how a head tipped back is seen from this low an eye.
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
 * smaller card (`figureBands`), where a figure a few millimetres tall would crowd them.
 */
export function figureStrokes(f: Figure, env: ToneEnv & ViewEnv): Stroke[] {
  const out: ClothStroke[] = ribbonStrokes({ ...f.body, head: undefined }, env, FIGURE_LOOK, { fill: 0.58, twist: 0.3, lines: 6, bands: figureBands() });
  const head = f.body.head!;
  out.push(...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.35) }, FIGURE_LOOK, f.skeleton.height * 0.012),
    headOutline(head, env.screen, FIGURE_LOOK));
  return out.map(st => ({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points }));
}
