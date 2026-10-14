import * as THREE from 'three';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import type { Family, Ink } from '../types.ts';
import { clamp, smooth } from '../params.ts';

const TAU = Math.PI * 2;

/**
 * A world-space stroke from the mannequin parts. `family` is set only when the caller asks for one. `role` is what the
 * stroke draws, for a card that ranks or thins its strokes by kind: the kit sets `outline` on `silhouettes`' curves (and on
 * `drapeStrokes`' neckline, hem, opening and silhouette), `ring` on `contourTube`'s rings and plane edges, and `fold` on
 * `drapeStrokes`' fall hatch and creases. A card's own strokes may name their own; the other makers leave it unset.
 */
export type ClothStroke = { ink: Ink; group: string; family?: Family; points: THREE.Vector3[]; owner?: number; role?: string };

/** A section key along a tube: `u` is the position on the spine, `rx` and `ry` the section radii. */
export type Key = [u: number, rx: number, ry: number];

/**
 * A limb or trunk: a spine curve with sections sampled into a lookup table. Sections are ellipses,
 * or, with `facets`, polygons inscribed in them, so the body is cut into planes like the slabs, or,
 * with `square` above 2, superellipses: boxes with rounded corners, for stiff tailoring.
 * Coordinates are (u along the spine, v round it); `ref` picks the side the section's x axis faces.
 */
export class Tube {
  readonly length: number;
  readonly circ: number;
  private readonly table: { c: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; rx: number; ry: number }[];
  constructor(readonly id: string, spine: THREE.Vector3[], keys: Key[], ref: THREE.Vector3,
    readonly hand: 1 | -1, readonly caps: [number, number] = [0, 0], readonly mask?: (u: number, v: number) => boolean,
    readonly facets = 0, readonly square = 2) {
    const curve = new THREE.CatmullRomCurve3(spine, false, 'centripetal');
    this.length = curve.getLength();
    const M = 480;
    this.table = [];
    let circ = 0;
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      const c = curve.getPointAt(u), t = curve.getTangentAt(u);
      const nn = new THREE.Vector3().crossVectors(t, ref).normalize();
      const b = new THREE.Vector3().crossVectors(nn, t).normalize();
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1][0] < u) k++;
      const [u0, rx0, ry0] = keys[k], [u1, rx1, ry1] = keys[k + 1];
      const f = smooth(u0, u1, u);
      // Round caps: a dome of the end radius over the last stretch of spine.
      const s = u * this.length, e = this.length - s;
      let cap = 1;
      if (caps[0] > 0 && s < caps[0]) cap = Math.sqrt(Math.max(0, 1 - ((caps[0] - s) / caps[0]) ** 2));
      if (caps[1] > 0 && e < caps[1]) cap = Math.min(cap, Math.sqrt(Math.max(0, 1 - ((caps[1] - e) / caps[1]) ** 2)));
      const rx = (rx0 + (rx1 - rx0) * f) * cap, ry = (ry0 + (ry1 - ry0) * f) * cap;
      circ = Math.max(circ, Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))));
      this.table.push({ c, n: nn, b, rx, ry });
    }
    this.circ = circ;
  }
  point(u: number, v: number, lift = 0): THREE.Vector3 {
    const x = clamp(u, 0, 1) * (this.table.length - 1);
    const i = Math.min(this.table.length - 2, Math.floor(x)), f = x - i;
    const a = this.table[i], b = this.table[i + 1];
    const rx = a.rx + (b.rx - a.rx) * f + lift, ry = a.ry + (b.ry - a.ry) * f + lift;
    const c = a.c.clone().lerp(b.c, f);
    const nn = a.n.clone().lerp(b.n, f), bb = a.b.clone().lerp(b.b, f);
    const angle = TAU * v;
    let k = 1;
    if (this.facets >= 3) {
      const seg = TAU / this.facets;
      const local = ((angle % seg) + seg) % seg - seg / 2;
      k = Math.cos(seg / 2) / Math.cos(local);
    } else if (this.square !== 2) {
      const p = this.square;
      k = (Math.abs(Math.cos(angle)) ** p + Math.abs(Math.sin(angle)) ** p) ** (-1 / p);
    }
    return c.addScaledVector(nn, rx * k * Math.cos(angle)).addScaledVector(bb, ry * k * Math.sin(angle));
  }
  centre(u: number): THREE.Vector3 {
    const x = clamp(u, 0, 1) * (this.table.length - 1);
    const i = Math.min(this.table.length - 2, Math.floor(x));
    return this.table[i].c.clone().lerp(this.table[i + 1].c, x - i);
  }
  normal(u: number, v: number): THREE.Vector3 {
    const e = 1e-3;
    // Keep the v difference inside one facet so a plane gets its own normal, not an edge average.
    let v0 = v - e, v1 = v + e;
    if (this.facets >= 3) {
      const k = Math.floor(v * this.facets);
      v0 = Math.max(v0, k / this.facets + 1e-5); v1 = Math.min(v1, (k + 1) / this.facets - 1e-5);
    }
    const pu = this.point(Math.min(1, u + e), v).sub(this.point(Math.max(0, u - e), v));
    const pv = this.point(u, v1).sub(this.point(u, v0));
    const out = new THREE.Vector3().crossVectors(pu, pv);
    if (out.lengthSq() < 1e-14) return this.point(u, v).sub(this.centre(u)).normalize();
    out.normalize();
    if (out.dot(this.point(u, v).sub(this.centre(u))) < 0) out.negate();
    return out;
  }
  /** The closed surface for the depth pass; lower `uSegs`/`vSegs` for scenes with many figures. */
  mesh(uSegs = 200, vSegs = this.facets >= 3 ? this.facets * 6 : 56): THREE.BufferGeometry {
    return buildSurfaceMesh((u, v) => this.point(u, v), {}, uSegs, vSegs);
  }
}

/** What `silhouettes` reads of the view: the camera's forward direction. */
export interface ViewEnv { forward: THREE.Vector3 }

/** How the silhouette strokes are tagged; omitted fields take the Agent's vermilion contour. */
export interface SilhouetteStyle { ink?: Ink; group?: string; family?: Family }

/** Silhouette curves: where the surface turns edge-on to the camera. */
export function silhouettes(t: Tube, env: ViewEnv, style: SilhouetteStyle = {}): ClothStroke[] {
  const { ink = 'vermilion', group = 'contour', family } = style;
  const out: ClothStroke[] = [];
  const NU = 220, NV = 96;
  type Track = { v: number; pts: THREE.Vector3[]; last: number };
  let tracks: Track[] = [];
  const close = (tr: Track) => {
    if (tr.pts.length > 1) out.push(family ? { ink, group, family, points: tr.pts, role: 'outline' } : { ink, group, points: tr.pts, role: 'outline' });
  };
  for (let i = 0; i <= NU; i++) {
    const u = i / NU;
    const g = (v: number) => t.normal(u, v).dot(env.forward);
    const roots: number[] = [];
    let prev = g(0);
    for (let j = 1; j <= NV; j++) {
      const v = j / NV, cur = g(v);
      if (Math.sign(cur) !== Math.sign(prev)) roots.push((j - 1 + prev / (prev - cur)) / NV);
      prev = cur;
    }
    const next: Track[] = [];
    for (let r of roots) {
      if (t.facets >= 3) r = Math.round(r * t.facets) / t.facets; // a faceted outline turns at a plane edge
      const p = t.point(u, r, 0.012);
      const match = tracks.find(tr => tr.last === i - 1 && Math.min(Math.abs(tr.v - r), 1 - Math.abs(tr.v - r)) < 0.08);
      if (match) { match.pts.push(p); match.v = r; match.last = i; next.push(match); tracks = tracks.filter(tr => tr !== match); }
      else next.push({ v: r, pts: [p], last: i });
    }
    for (const tr of tracks) close(tr);
    tracks = next;
  }
  for (const tr of tracks) close(tr);
  return out;
}
