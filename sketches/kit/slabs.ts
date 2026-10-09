import * as THREE from 'three';
import type { Point, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { FORMAT, MIN_FEATURE, PITCH_SCALE } from './format.ts';
import { n } from './params.ts';
import { pageOf } from './perspective.ts';
import type { Ink } from './types.ts';

/**
 * Slabs: the box that every Breach architecture is built from, and the two ways the family hatches
 * one. `slabStrokes` is the cathedral hatch (slanted front courses, side and top ticks); `facetStrokes`
 * is the Tower card's raking-light hatch (contour rings, crossed diagonal fields on dark faces).
 *
 * On a small card (`kit/format.ts`) a slab's outline needs trimming: a face seen nearly edge-on prints as two
 * strokes closer than the pen holds apart, and the depth test lets the back edges through within a pixel or two of
 * the outline, where they double it. `facetStrokes`' `trim` option draws the outline as `slabEdges` does instead
 * (none of that at tabloid), and `pageExtent` measures a slab on the page, for culls by size or place.
 */
export type Role = 'stack' | 'pier' | 'stub' | 'fallen' | 'debris';
export type Slab = {
  x: number; y: number; z: number; w: number; h: number; d: number;
  rx: number; ry: number; rz: number;
  beat: number; role: Role;
  /** Where the solid stood before the collapse moved it. */
  home: { x: number; y: number; z: number };
  /** Local hatch loudness, 0..1; quiet slabs read as open masonry. */
  tone: number;
};

/** The poster frame the cathedral hatch is tuned to: half the view height in world units, and its mm scale. */
export const POSTER_HALF_H = 13.0;
export const POSTER_HALF_W = POSTER_HALF_H * TABLOID_PAGE.width / TABLOID_PAGE.height;
/** Page millimetres per world unit in that frame. */
export const POSTER_MM_PER_UNIT = TABLOID_PAGE.height / (2 * POSTER_HALF_H);
// World-unit pitches below are tuned on tabloid; the format's pitch scale (1 at tabloid) holds them on paper.
// Slanted front hatch loses ~7% to its slant; keep the perpendicular gap at 0.5 mm or more.
export const SLAB_MIN_PITCH = 0.56 / POSTER_MM_PER_UNIT * PITCH_SCALE;
// The facet floor is relative to facetStrokes' `pitch`, so it scales with it, together with the tone spacings.
const FACET_MIN_PITCH = 0.072; // world units at pitch 1: about 0.6 mm on the sheet at the tower's depth

/** A 0..1 density level: `sparse` at 0, `neutral` at 0.55, `dense` at 1. For counts and other unitless amounts. */
export function densityLevel(density: number, sparse: number, neutral: number, dense: number): number {
  return density < 0.55
    ? sparse + (neutral - sparse) * density / 0.55
    : neutral + (dense - neutral) * (density - 0.55) / 0.45;
}

/** Hatch pitch, in world units, for a 0..1 density: the level times the format's pitch scale, so floors and tone scale together. */
export function densityPitch(density: number, sparse: number, neutral: number, dense: number): number {
  return densityLevel(density, sparse, neutral, dense) * PITCH_SCALE;
}

export function solid(x: number, y: number, z: number, w: number, h: number, d: number, beat: number, role: Role): Slab {
  return { x, y, z, w, h, d, rx: 0, ry: 0, rz: 0, beat, role, home: { x, y, z }, tone: 1 };
}

export function slabMatrix(s: Slab): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
}

export function slabGeometry(s: Slab): THREE.BufferGeometry {
  const mesh = new THREE.BoxGeometry(s.w, s.h, s.d);
  mesh.applyMatrix4(slabMatrix(s));
  return mesh;
}

/** A stroke of the cathedral hatch: tower slabs draw as `tower`, fallen and debris ones as `collapse`. */
export type SlabStroke = { ink: Ink; group: 'tower' | 'collapse'; points: THREE.Vector3[] };

/**
 * A slab drawn in the cathedral hatch. The first six strokes are its outline edges (front, back,
 * four depth edges); everything after is hatch.
 */
export function slabStrokes(s: Slab, globalDensity: number, interrupt: boolean): SlabStroke[] {
  const out: SlabStroke[] = [];
  const group: SlabStroke['group'] = s.role === 'stack' || s.role === 'pier' ? 'tower' : 'collapse';
  const m = slabMatrix(s);
  const line = (ink: Ink, ...pts: THREE.Vector3[]) => out.push({ ink, group, points: pts.map(p => p.applyMatrix4(m)) });
  // Tone never pushes a course past the densest legal pitch.
  const density = Math.min(1, globalDensity * s.tone);
  const x0 = -s.w / 2, x1 = s.w / 2, y0 = -s.h / 2, y1 = s.h / 2;
  const zf = s.d / 2 + 0.006, zb = -s.d / 2;
  const p = (x: number, y: number, z = zf) => new THREE.Vector3(x, y, z);
  // All twelve edges; the depth pass decides which ones the eye can see.
  const e = 0.006;
  line('carbon', p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0));
  line('carbon', p(x0, y0, zb - e), p(x1, y0, zb - e), p(x1, y1, zb - e), p(x0, y1, zb - e), p(x0, y0, zb - e));
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    line('carbon', p(x + Math.sign(x) * e, y + Math.sign(y) * e, zb), p(x + Math.sign(x) * e, y + Math.sign(y) * e, zf));
  }
  const pitch = Math.max(SLAB_MIN_PITCH, densityPitch(density, 0.12, 0.044, 0.032));
  const margin = 0.07;
  const across = Math.floor((s.w - 2 * margin) / pitch);
  for (let j = 0; j <= across; j++) {
    if (interrupt && j % 5 < 2 && j > across * 0.27 && j < across * 0.76) continue;
    const x = x0 + margin + j * (s.w - 2 * margin) / Math.max(1, across);
    const ycut = y0 + margin + (j % 4) * Math.min(0.045, s.h * 0.08);
    line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x, ycut), p(Math.min(x + 0.2, x1 - margin), y1 - margin));
  }
  if (s.w > 2.2 && s.beat % 3 !== 1) {
    const rows = Math.ceil(s.h / densityPitch(density, 0.28, 0.12, 0.07));
    for (let j = 1; j < rows; j++) {
      const y = y0 + j * s.h / rows;
      const inset = 0.13 + (j % 3) * 0.035;
      line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x0 + inset, y), p(x1 - inset, Math.min(y + 0.11, y1 - 0.06)));
    }
  }
  if (s.h > 0.3) {
    const sideRows = Math.ceil(s.h / densityPitch(density, 0.17, 0.065, 0.045));
    for (let j = 1; j < sideRows; j++) {
      const y = y0 + j * s.h / sideRows;
      line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x1 + 0.007, y, zb + 0.04), p(x1 + 0.007, Math.min(y + 0.09, y1 - 0.02), zf - 0.04));
    }
  }
  if (s.role !== 'debris' && s.tone > 0.35) for (let k = 1; k <= 3; k++) {
    const y = y0 + k * s.h / 4;
    line(k === 2 ? 'ultramarine' : 'carbon', p(x0 + 0.09, y), p(x1 - 0.09, y));
  }
  const topRows = Math.ceil(s.w / densityPitch(density, 0.28, 0.12, 0.07));
  for (let k = 1; k < topRows; k++) {
    const x = x0 + k * s.w / topRows;
    line('ultramarine', p(x, y1 + 0.006, zb + 0.03), p(x, y1 + 0.006, zf - 0.03));
    // The underside shows from this low eye; score it more sparsely.
    if (k % 3 === 0 && s.tone > 0.55) line('carbon', p(x, y0 - 0.006, zb + 0.03), p(x, y0 - 0.006, zf - 0.03));
  }
  return out;
}

/** The raking light: low from the bolt's side and a little toward the eye, so faces split into values. */
export function rakingLight(ctx: SketchContext): THREE.Vector3 {
  // Elevation from a few degrees (grazing: front faces fall dark, flanks blaze) to high (tops lit).
  const e = (4 + 56 * n(ctx, 'lightAngle', 0.3, 0, 1)) * Math.PI / 180;
  const toward = 0.15 + 0.5 * n(ctx, 'lightAngle', 0.3, 0, 1);
  return new THREE.Vector3(Math.cos(e), Math.sin(e) * 1.4, toward).normalize();
}

/** Face darkness under the raking light, 0 (paper) to 1, scaled by the slab's own tone. */
export function faceDarkness(normal: THREE.Vector3, light: THREE.Vector3, tone: number): number {
  const lit = Math.max(0, normal.dot(light));
  return Math.max(0, Math.min(1, (0.12 + 0.88 * (1 - lit) ** 1.3) * Math.min(1.15, 0.55 + 0.5 * tone)));
}

/** Clip the line o + s·dir to |x·U| ≤ a, |x·V| ≤ b in face coordinates (dir and o given as (u, v)). */
function clipRect(ox: number, oy: number, dx: number, dy: number, a: number, b: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [o, d, h] of [[ox, dx, a], [oy, dy, b]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(o) > h) return null; continue; }
    const t0 = (-h - o) / d, t1 = (h - o) / d;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/** A stroke of the raking-light hatch: outline `edge`s, and `hatch` (rings and fields) on faces that see the eye. */
export type FacetStroke = { ink: Ink; group: 'system'; family: 'edge' | 'hatch'; points: THREE.Vector3[] };

/** A slab's bounding box on the page: its centre and its larger side, in millimetres. */
export function pageExtent(view: THREE.Camera, s: Slab): { x: number; y: number; size: number } {
  const m = slabMatrix(s);
  const xs: number[] = [], ys: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const p = pageOf(view, new THREE.Vector3(x * s.w / 2, y * s.h / 2, z * s.d / 2).applyMatrix4(m));
    xs.push(p.x); ys.push(p.y);
  }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
}

/** A face's width on the page (its corners, in order): its area over its longest side, in millimetres. */
function faceWidth(quad: Point[]): number {
  let area = 0, longest = 0;
  for (let k = 0; k < 4; k++) {
    const p0 = quad[k], p1 = quad[(k + 1) % 4];
    area += p0.x * p1.y - p1.x * p0.y;
    longest = Math.max(longest, Math.hypot(p1.x - p0.x, p1.y - p0.y));
  }
  return Math.abs(area) / 2 / longest;
}

/**
 * A slab's twelve edges, each pushed a hair outward so the depth test keeps it, less the inner edges of any face
 * that sees the eye but is narrower on paper than `MIN_FEATURE`. Such a sliver (an arm's shaded side, seen nearly
 * edge-on) is drawn as part of its slab's outline instead of as two strokes closer than the pen can hold apart.
 * With `hidden`, the edges between two faces turned away are left out too: the depth test hides them, except
 * within a pixel or two of the outline, where on a small card they would double it. `view` is the card's camera
 * on the format's page. At tabloid (`MIN_FEATURE` 0) no face is a sliver, but the back edges still go with
 * `hidden`, so a card calls this only off tabloid (as `facetStrokes`' `trim` does).
 */
export function slabEdges(s: Slab, view: THREE.Camera, hidden = true): THREE.Vector3[][] {
  const m = slabMatrix(s);
  const half = [s.w / 2, s.h / 2, s.d / 2];
  const e = 0.006;
  const local = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  const others = (a: number) => [0, 1, 2].filter(b => b !== a);
  // A face is an axis and a side; its corners run round it.
  const corners = (a: number, side: number) => {
    const [i, j] = others(a);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const c = [0, 0, 0]; c[a] = side * half[a]; c[i] = u * half[i]; c[j] = v * half[j]; return local(c); });
  };
  const seen = (a: number, side: number) => {
    const c = [0, 0, 0], o = [0, 0, 0];
    c[a] = side * half[a]; o[a] = side * (half[a] + 1);
    const centre = local(c);
    return view.position.clone().sub(centre).dot(local(o).sub(centre)) > 0;
  };
  const narrow = (a: number, side: number) => faceWidth(corners(a, side).map(p => pageOf(view, p))) < MIN_FEATURE;
  const edges: THREE.Vector3[][] = [];
  for (let k = 0; k < 3; k++) {
    const [i, j] = others(k);
    for (const si of [-1, 1]) for (const sj of [-1, 1]) {
      const a = seen(i, si), b = seen(j, sj);
      if (a && b && (narrow(i, si) || narrow(j, sj))) continue;
      if (hidden && !a && !b) continue;
      const end = (sk: number) => { const c = [0, 0, 0]; c[k] = sk * half[k]; c[i] = si * (half[i] + e); c[j] = sj * (half[j] + e); return local(c); };
      edges.push([end(-1), end(1)]);
    }
  }
  return edges;
}

/**
 * A slab's shaded slivers, on a small card: a face that sees the eye but is narrower on paper than `MIN_FEATURE` (an
 * arm's side, seen nearly edge-on) loses its inner edge (`slabEdges`), and its hatch prints as specks (drop hatch
 * pieces shorter than `MIN_FEATURE` when bucketing). Where the print hatches that face (in shade, as `facetStrokes`
 * does from a darkness of 0.32), one line in `ink` runs down its middle instead, the length of the face, so the slab
 * keeps its shaded side. None at tabloid.
 */
export function sliverShade(s: Slab, view: THREE.Camera, light: THREE.Vector3, ink: Ink = 'ultramarine'): FacetStroke[] {
  if (!MIN_FEATURE) return [];
  const m = slabMatrix(s), rot = new THREE.Matrix4().extractRotation(m);
  const half = [s.w / 2, s.h / 2, s.d / 2];
  const e = 0.006;
  const local = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  const out: FacetStroke[] = [];
  for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
    const [i, j] = [0, 1, 2].filter(b => b !== a);
    const unit = [0, 0, 0];
    unit[a] = side;
    const normal = new THREE.Vector3(unit[0], unit[1], unit[2]).applyMatrix4(rot);
    const c = [0, 0, 0];
    c[a] = side * half[a];
    const centre = local(c).addScaledVector(normal, e);
    // Seen, and in shade: a face the print hatches.
    if (view.position.clone().sub(centre).dot(normal) <= 0 || faceDarkness(normal, light, s.tone) < 0.32) continue;
    const corner = (u: number, v: number) => { const q = [...c]; q[i] = u * half[i]; q[j] = v * half[j]; return pageOf(view, local(q)); };
    const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    if (faceWidth(quad) >= MIN_FEATURE) continue;
    // Down the middle along its long side.
    const along = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) >= Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) ? i : j;
    const end = (t: number) => { const q = [...c]; q[along] = t * half[along]; return local(q).addScaledVector(normal, e); };
    out.push({ ink, group: 'system', family: 'hatch', points: [end(-1), end(1)] });
  }
  return out;
}

/**
 * How `facetStrokes` trims a slab on a small card (ignored at tabloid, so the print stays byte-identical): the outline
 * as `slabEdges` draws it in the card's `view` (slivers folded into it; with `hidden`, the default, no back edges:
 * pass `false` where the card's occlusion control is off), and with `shade`, a line down each shaded sliver
 * (`sliverShade`, in the field hatch's ultramarine).
 */
export interface SlabTrim { view: THREE.Camera; hidden?: boolean; shade?: boolean }

/**
 * A slab drawn in the raking-light hatch: twelve outline edges; then on each face that sees the
 * eye, contour rings that follow its outline inward, as many as the face is dark; and inside them a
 * field of diagonal hatch, crossed by a second family on the darkest faces, for body. `pitch` scales
 * the hatch spacing, floor included (1 = the Tower's on tabloid, tuned to its depth), so slabs nearer or
 * farther keep the same spacing on the sheet. It defaults to the format's pitch scale, which holds the
 * Tower's spacing on any page; a caller that derives `pitch` from on-sheet millimetres already has it.
 * Off tabloid, `trim` draws the outline for a small card (see `SlabTrim`).
 */
export function facetStrokes(s: Slab, light: THREE.Vector3, eye: THREE.Vector3, outlineOnly: boolean, pitch = PITCH_SCALE, trim?: SlabTrim): FacetStroke[] {
  const out: FacetStroke[] = [];
  const m = slabMatrix(s);
  const rot = new THREE.Matrix4().extractRotation(m);
  const hx = s.w / 2, hy = s.h / 2, hz = s.d / 2;
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const push = (ink: Ink, family: FacetStroke['family'], ...pts: THREE.Vector3[]) => out.push({ ink, group: 'system', family, points: pts });
  const e = 0.006;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  const trimmed = trim !== undefined && !FORMAT.tabloid;
  if (trimmed) for (const points of slabEdges(s, trim.view, trim.hidden ?? true)) push('carbon', 'edge', ...points);
  else {
    push('carbon', 'edge', ...corners.map(([x, y]) => P(x * hx, y * hy, hz + e)));
    push('carbon', 'edge', ...corners.map(([x, y]) => P(x * hx, y * hy, -hz - e)));
    for (const [x, y] of corners.slice(0, 4)) push('carbon', 'edge', P(x * (hx + e), y * (hy + e), -hz), P(x * (hx + e), y * (hy + e), hz));
  }
  if (outlineOnly) return out;
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0, 0, hz), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, 0, -hz), new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, 0, hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz)],
    [new THREE.Vector3(0, -hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, hz)],
  ];
  for (const [c0, U0, V0] of faces) {
    const normal = c0.clone().normalize().applyMatrix4(rot);
    const centre = c0.clone().applyMatrix4(m).addScaledVector(normal, e);
    if (eye.clone().sub(centre).dot(normal) <= 0) continue;
    const a = U0.length(), b = V0.length();
    const U = U0.clone().normalize().applyMatrix4(rot), V = V0.clone().normalize().applyMatrix4(rot);
    const at = (u: number, v: number) => centre.clone().addScaledVector(U, u).addScaledVector(V, v);
    const d = faceDarkness(normal, light, s.tone);
    // Contour rings: the outline repeated inward, spaced tighter the darker the face.
    const ring = Math.max(FACET_MIN_PITCH, 0.075 + 0.11 * (1 - d)) * pitch;
    const band = Math.min(a, b) * (0.12 + 0.6 * d);
    let t = ring;
    for (; t <= band && a - t > 0.03 && b - t > 0.03; t += ring) {
      push('carbon', 'hatch', at(-(a - t), -(b - t)), at(a - t, -(b - t)), at(a - t, b - t), at(-(a - t), b - t), at(-(a - t), -(b - t)));
    }
    // The middle: diagonal hatch on mid faces, crossed on the darkest, for body.
    const ia = a - t, ib = b - t;
    if (ia < 0.05 || ib < 0.05 || d < 0.32) continue;
    const families: [number, number, Ink][] = [[0.6, Math.max(FACET_MIN_PITCH, 0.07 + 0.3 * (1 - d) ** 1.5) * pitch, 'ultramarine']];
    if (d > 0.62) families.push([-0.95, Math.max(FACET_MIN_PITCH * 1.3, 0.1 + 0.35 * (1 - d)) * pitch, 'violet']);
    for (const [angle, step, ink] of families) {
      const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
      const reach = Math.hypot(ia, ib);
      for (let k = -reach + step / 2; k < reach; k += step) {
        const span = clipRect(nx * k, ny * k, dx, dy, ia, ib);
        if (!span) continue;
        push(ink, 'hatch', at(nx * k + dx * span[0], ny * k + dy * span[0]), at(nx * k + dx * span[1], ny * k + dy * span[1]));
      }
    }
  }
  if (trimmed && trim.shade) out.push(...sliverShade(s, trim.view, light));
  return out;
}
