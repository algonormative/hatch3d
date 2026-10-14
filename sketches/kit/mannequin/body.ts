import * as THREE from 'three';
import { slabGeometry, solid, type Slab } from '../slabs.ts';
import type { Ink } from '../types.ts';
import { LOOK, TIER, perpendicular, runs, stride, tierOf, type Look, type ToneEnv } from './hatch.ts';
import type { JointName, Side, Skeleton } from './skeleton.ts';
import { BUTTON, COLLAR, HEMS, front, lapel, opening, pinstripeTube, suitFront } from './suit.ts';
import { Tube, silhouettes, type ClothStroke, type Key, type ViewEnv } from './tube.ts';

/**
 * A body built on a posed skeleton: a trunk tube from pelvis to neck, limb tubes bone by bone, slab
 * hands and feet, and an egg head. Sections follow the Plenipotentiary's proportions, scaled by the
 * figure's height. Every renderer (bare, suit, and later robe and outfits) draws over this one body.
 */
export interface Body {
  skeleton: Skeleton;
  trunk: Tube;
  /** Limb tubes keyed by part and side: thigh_l, shin_l, upper_l, fore_l, and so on. */
  limbs: Tube[];
  head?: Tube;
  /** Hands and feet as slabs. */
  blocks: Slab[];
}

export interface BodyOptions {
  /** Planes per tube section (0 = smooth). */
  facets?: number;
  /** Broader or slighter build, 1 = canon. */
  build?: number;
  /** Head as an egg tube, or left out (for a helix head, a censor, a crown of the card's own). */
  head?: 'egg' | 'none';
  /** Mask the trunk for a jacket opening (the suit's lapel V and shirt). */
  jacket?: boolean;
}

const scaleKeys = (keys: Key[], k: number): Key[] => keys.map(([u, rx, ry]) => [u, rx * k, ry * k]);

/** A slab aligned to a joint's frame, centred along its bone. */
function blockOn(s: Skeleton, joint: JointName, w: number, h: number, d: number, along = 0.5, beat = 0): Slab {
  const j = s.joints.get(joint)!;
  const c = j.origin.clone().lerp(j.end, along);
  const e = new THREE.Euler().setFromQuaternion(j.rot, 'XYZ');
  const slab = solid(c.x, c.y, c.z, w, h, d, beat, 'stub');
  slab.rx = e.x; slab.ry = e.y; slab.rz = e.z;
  return slab;
}

export function buildBody(s: Skeleton, options: BodyOptions = {}): Body {
  const k = s.height / 24 * (options.build ?? 1);
  const cut = options.facets && options.facets >= 3 ? options.facets : 0;
  const ax = (j: JointName) => s.axes(j);
  // Trunk: from below the hip joints up the spine to the base of the skull.
  const pelvis = s.joints.get('pelvis')!, neck = s.joints.get('neck')!;
  const spine = [
    pelvis.origin.clone().addScaledVector(ax('pelvis').y, -0.03 * s.height),
    s.at('spine'), s.at('chest'), s.at('chest').lerp(s.at('neck'), 0.6), s.at('neck'), neck.end,
  ];
  const mask = options.jacket ? (u: number, v: number) => {
    if (u > 0.9) return false;
    const o = front(v);
    return !(u >= BUTTON - 0.02 && u <= COLLAR + 0.04 && o < opening(u) + lapel(u));
  } : undefined;
  const trunk = new Tube('trunk', spine,
    scaleKeys([[0, 2.15, 1.45], [0.2, 1.95, 1.32], [0.5, 2.45, 1.46], [0.74, 2.95, 1.3], [0.82, 2.5, 1.12], [0.885, 1.15, 0.92], [0.92, 0.72, 0.7], [1, 0.66, 0.64]], k),
    ax('pelvis').z, 1, [1.1 * k, 0], mask, cut);
  const limbs: Tube[] = [];
  const limb = (id: string, from: JointName, keys: Key[], hand: 1 | -1, caps: [number, number]) => {
    const j = s.joints.get(from)!;
    const mid = j.origin.clone().lerp(j.end, 0.5);
    limbs.push(new Tube(id, [j.origin, mid, j.end], scaleKeys(keys, k), ax(from).z, hand, [caps[0] * k, caps[1] * k], undefined, cut));
  };
  for (const side of ['l', 'r'] as Side[]) {
    const h: 1 | -1 = side === 'l' ? 1 : -1;
    limb(`thigh_${side}`, `hip_${side}`, [[0, 1.5, 1.4], [0.45, 1.36, 1.24], [1, 1.02, 0.98]], h, [0, 1.0]);
    limb(`shin_${side}`, `knee_${side}`, [[0, 1.0, 0.98], [0.3, 0.92, 0.95], [1, 0.62, 0.66]], -h as 1 | -1, [0.95, 0]);
    limb(`upper_${side}`, `shoulder_${side}`, [[0, 1.0, 0.95], [0.5, 0.9, 0.86], [1, 0.8, 0.78]], h, [0.9, 0.78]);
    limb(`fore_${side}`, `elbow_${side}`, [[0, 0.78, 0.76], [0.6, 0.7, 0.66], [1, 0.6, 0.55]], -h as 1 | -1, [0.76, 0]);
  }
  const blocks: Slab[] = [];
  for (const side of ['l', 'r'] as Side[]) {
    // A broad block hand along the hand bone; a blunt shoe along the foot.
    blocks.push(blockOn(s, `wrist_${side}`, 1.25 * k, s.joints.get(`wrist_${side}`)!.length * 1.05, 0.5 * k, 0.5, blocks.length));
    blocks.push(blockOn(s, `ankle_${side}`, 1.25 * k, 0.9 * k, s.joints.get(`ankle_${side}`)!.length * 1.2, 0.5, blocks.length));
    const shoe = blocks[blocks.length - 1];
    // The shoe's length runs along the foot bone (its local z); swap its depth onto that axis.
    shoe.d = s.joints.get(`ankle_${side}`)!.length * 1.25; shoe.h = 0.85 * k;
  }
  let head: Tube | undefined;
  if (options.head !== 'none') {
    const j = s.joints.get('head')!;
    head = new Tube('head', [j.origin, j.origin.clone().lerp(j.end, 0.5), j.end],
      scaleKeys([[0, 0.8, 0.85], [0.45, 1.3, 1.4], [1, 1.05, 1.1]], k), ax('head').z, 1, [0.4 * k, 1.2 * k], undefined, cut);
  }
  return { skeleton: s, trunk, limbs, head, blocks };
}

/** Every closed surface of the body, for the depth pass. */
export function bodyMeshes(b: Body, detail = 1): THREE.BufferGeometry[] {
  const mesh = (t: Tube) => t.mesh(Math.round(120 * detail), t.facets >= 3 ? t.facets * 4 : Math.round(32 * detail));
  return [mesh(b.trunk), ...b.limbs.map(mesh), ...(b.head ? [mesh(b.head)] : []), ...b.blocks.map(slabGeometry)];
}

/** Cross-contour rings round a tube, as many as its tone asks for: the bare body's hatch. Its strokes are `ring`s (`ClothStroke.role`). */
export function contourTube(t: Tube, env: ToneEnv, look: Look = LOOK, spacing = 0.3): ClothStroke[] {
  const out: ClothStroke[] = [];
  const R = Math.max(8, Math.round(t.length / spacing)) * 4;
  const around = Math.max(120, Math.round(t.circ / 0.06));
  for (let i = 0; i < R; i++) {
    const u = (i + 0.5) / R;
    const tier = tierOf(i);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let q = 0; q <= around; q++) {
      const v = q / around;
      const p = t.point(u, v);
      pts.push(p);
      if (t.mask && !t.mask(u, v)) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, t.point(u, v + 1 / around), t.point(u + 1 / R, v)));
      keep.push(i % s === 0 && env.dark(p, t.normal(u, v)) > TIER[tier]);
    }
    runs(pts, keep, i % 8 === 0 ? look.accent : look.cloth, look.figure, out, look.family, 'ring');
  }
  // A faceted body shows its plane edges, end to end.
  if (t.facets >= 3) for (let f = 0; f < t.facets; f++) {
    const pts = Array.from({ length: 121 }, (_, i) => t.point(i / 120, f / t.facets, 0.004));
    out.push({ ink: look.crease, group: look.figure, family: look.family, points: pts, role: 'ring' });
  }
  return out;
}

/** Edge strokes of a slab's twelve edges, for block hands and shoes. */
function blockEdges(slab: Slab, ink: Ink, group: string): ClothStroke[] {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(slab.x, slab.y, slab.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(slab.rx, slab.ry, slab.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
  const hx = slab.w / 2, hy = slab.h / 2, hz = slab.d / 2;
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x * hx, y * hy, z * hz).applyMatrix4(m);
  const sq = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  const out: ClothStroke[] = [
    { ink, group, points: sq.map(([x, y]) => P(x, y, 1)) },
    { ink, group, points: sq.map(([x, y]) => P(x, y, -1)) },
  ];
  for (const [x, y] of sq.slice(0, 4)) out.push({ ink, group, points: [P(x, y, -1), P(x, y, 1)] });
  return out;
}

export type BodyStyle = 'bare' | 'suit';

/** Draw a body: bare (cross-contour rings and outlines) or suited (pinstripes, seams, lapels, tie). */
export function bodyStrokes(b: Body, env: ToneEnv & ViewEnv, style: BodyStyle, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const tubes = [b.trunk, ...b.limbs, ...(b.head ? [b.head] : [])];
  for (const t of tubes) {
    if (style === 'suit' && t !== b.head) {
      const part = t.id.replace(/_[lr]$/, '');
      out.push(...pinstripeTube(t, env, HEMS[part] ?? { seams: [0, 0.5], hems: [] }, look));
    } else out.push(...contourTube(t, env, look));
    out.push(...silhouettes(t, env, { ink: look.edge, group: look.contour, family: look.family }));
  }
  if (style === 'suit') out.push(...suitFront(b.trunk, env, look));
  for (const slab of b.blocks) out.push(...blockEdges(slab, look.crease, look.figure));
  return out;
}
