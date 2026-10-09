import * as THREE from 'three';
import type { Point } from '../../../src/sketch/types.ts';
import { CARD, MIN_FEATURE, MIN_SPACING } from '../../kit/format.ts';
import { solid, type Slab } from '../../kit/slabs.ts';

/**
 * Solid slabs for the back's `composite` and `cathedral` forms, drawn without a depth buffer: every slab is an
 * axis-aligned box, and a mark is hidden where the line of sight from it to the eye passes through another box. That
 * test is exact for boxes, so the back's lines are where the solids put them at any size, with no raster to fray
 * against. A box in front can stand a halo clear of what lies behind it (`pad`): the deck's knockout, paper round the
 * nearer solid.
 *
 * The view is an oblique parallel projection (a box's front face square on, its depth sheared off to one side, as an
 * architect draws it), with world x and y in page millimetres from the card's centre and z toward the eye.
 */
export interface View {
  /** Where a world point lands on the page, in millimetres. */
  page(p: THREE.Vector3): Point;
  /** The unit direction from a world point toward the eye. */
  toward(p: THREE.Vector3): THREE.Vector3;
  /** How far along `toward` the eye lies from the point (Infinity for a parallel view). */
  reach(p: THREE.Vector3): number;
}

const centre = (): Point => ({ x: (CARD.x0 + CARD.x1) / 2, y: (CARD.top + CARD.bottom) / 2 });

/** An oblique parallel view: a point `z` toward the eye lands `(kx, ky) z` millimetres off its front-on place. */
export function obliqueView(kx: number, ky: number): View {
  const c = centre();
  const dir = new THREE.Vector3(-kx, -ky, 1).normalize();
  return {
    page: p => ({ x: c.x + p.x + kx * p.z, y: c.y + p.y + ky * p.z }),
    toward: () => dir.clone(),
    reach: () => Infinity,
  };
}

/** A slab box from its centre and full sizes, every rotation zero (so it is axis-aligned), with its tone. */
export function box(x: number, y: number, z: number, w: number, h: number, d: number, tone = 1, beat = 0): Slab {
  return { ...solid(x, y, z, w, h, d, beat, 'stack'), tone };
}

/** Whether the ray from `p` along `dir`, out to `reach`, passes through the box grown by `pad` on every side. */
function rayHits(s: Slab, p: THREE.Vector3, dir: THREE.Vector3, reach: number, pad: number): boolean {
  const lo = [s.x - s.w / 2 - pad, s.y - s.h / 2 - pad, s.z - s.d / 2 - pad];
  const hi = [s.x + s.w / 2 + pad, s.y + s.h / 2 + pad, s.z + s.d / 2 + pad];
  const o = [p.x, p.y, p.z], d = [dir.x, dir.y, dir.z];
  let t0 = 1e-6, t1 = reach;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[k] || o[k] > hi[k]) return false; continue; }
    const a = (lo[k] - o[k]) / d[k], b = (hi[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether a world point is hidden from the eye by any of `boxes` (each grown by `pad`), leaving out `self`. */
export function hidden(boxes: readonly Slab[], view: View, p: THREE.Vector3, pad: number, self?: Slab): boolean {
  const dir = view.toward(p), reach = view.reach(p);
  return boxes.some(b => b !== self && rayHits(b, p, dir, reach, pad));
}

/** A box's six faces: outward normal, centre, and two half-axes, in the order of the kit's `slabFaceNormal`. */
export function faces(s: Slab): { normal: THREE.Vector3; centre: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }[] {
  const hx = s.w / 2, hy = s.h / 2, hz = s.d / 2, o = new THREE.Vector3(s.x, s.y, s.z);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  return [
    [V(0, 0, 1), V(0, 0, hz), V(hx, 0, 0), V(0, hy, 0)], [V(0, 0, -1), V(0, 0, -hz), V(hx, 0, 0), V(0, hy, 0)],
    [V(1, 0, 0), V(hx, 0, 0), V(0, 0, hz), V(0, hy, 0)], [V(-1, 0, 0), V(-hx, 0, 0), V(0, 0, hz), V(0, hy, 0)],
    [V(0, 1, 0), V(0, hy, 0), V(hx, 0, 0), V(0, 0, hz)], [V(0, -1, 0), V(0, -hy, 0), V(hx, 0, 0), V(0, 0, hz)],
  ].map(([normal, c, u, v]) => ({ normal, centre: c.add(o), u, v }));
}

/** Whether a face of a box turns toward the eye. */
export const faceSeen = (view: View, face: { normal: THREE.Vector3; centre: THREE.Vector3 }): boolean => view.toward(face.centre).dot(face.normal) > 1e-9;

/**
 * A face's size on the page: page millimetres per world unit along each of its half-axes, and its narrower width in
 * millimetres (its area over its longer side, as a parallelogram). A hatch pitch held on paper divides by the smaller
 * scale; a face narrower than the smallest feature takes no hatch.
 */
export function faceOnPage(view: View, face: { centre: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }): { su: number; sv: number; width: number } {
  const at = (a: number, b: number) => view.page(face.centre.clone().addScaledVector(face.u, a).addScaledVector(face.v, b));
  const o = at(0, 0), pu = at(1, 0), pv = at(0, 1);
  const U = { x: 2 * (pu.x - o.x), y: 2 * (pu.y - o.y) }, V = { x: 2 * (pv.x - o.x), y: 2 * (pv.y - o.y) };
  const lu = Math.hypot(U.x, U.y), lv = Math.hypot(V.x, V.y);
  return { su: lu / (2 * face.u.length()), sv: lv / (2 * face.v.length()), width: Math.abs(U.x * V.y - U.y * V.x) / Math.max(lu, lv, 1e-9) };
}

/** A box's edges that the eye sees: each of the twelve with at least one seen face beside it, pushed a hair outward. */
export function seenEdges(s: Slab, view: View): THREE.Vector3[][] {
  const fs = faces(s), seen = fs.map(f => faceSeen(view, f));
  const half = [s.w / 2, s.h / 2, s.d / 2], o = [s.x, s.y, s.z];
  const e = 1e-3;
  const out: THREE.Vector3[][] = [];
  for (let k = 0; k < 3; k++) {
    const [i, j] = [0, 1, 2].filter(a => a !== k);
    for (const si of [-1, 1]) for (const sj of [-1, 1]) {
      // Faces 2a and 2a+1 are the +axis and -axis faces of axis a = (z, x, y) for a = 0, 1, 2.
      const faceOf = (axis: number, side: number) => 2 * [2, 0, 1].indexOf(axis) + (side > 0 ? 0 : 1);
      if (!seen[faceOf(i, si)] && !seen[faceOf(j, sj)]) continue;
      const end = (sk: number) => { const c = [...o]; c[k] += sk * half[k]; c[i] += si * (half[i] + e); c[j] += sj * (half[j] + e); return new THREE.Vector3(c[0], c[1], c[2]); };
      out.push([end(-1), end(1)]);
    }
  }
  return out;
}

/** Points along a world segment polyline no more than `step` world units apart. */
export function denseWorld(points: THREE.Vector3[], step: number): THREE.Vector3[] {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], k = Math.max(1, Math.ceil(a.distanceTo(b) / step));
    for (let j = 1; j <= k; j++) out.push(a.clone().lerp(b, j / k));
  }
  return out;
}

/**
 * A world stroke on the page: densified, projected, and cut into the runs a test keeps (by world point and by page
 * point). `step` is in world units.
 */
export function visibleRuns(points: THREE.Vector3[], view: View, keep: (w: THREE.Vector3, p: Point) => boolean, step: number): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const w of denseWorld(points, step)) {
    const p = view.page(w);
    if (keep(w, p)) run.push(p);
    else { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** The pen floor and the smallest feature, for the forms' own pitches and culls. */
export const FLOOR = { spacing: MIN_SPACING, feature: Math.max(MIN_FEATURE, 1) };
