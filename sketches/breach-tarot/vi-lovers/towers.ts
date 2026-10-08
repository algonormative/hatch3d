import * as THREE from 'three';
import { facetStrokes, faceDarkness, slabMatrix, solid, type FacetStroke, type Slab } from '../../kit/slabs.ts';
import { clamp } from '../../kit/params.ts';

/**
 * The two towers: what each lover brought. One pattern of deep slab courses, cut twice, the second
 * cut its mirror and misregistered.
 */

/** One course of the shared pattern, in raw units (before a tower scales it to its own height). */
export interface Course { h: number; w: number; d: number; slip: number; split: number; tone: number }

/** The pattern both towers are cut from: deep courses of uneven height, a width that steps in and out, slips and split courses. */
export function coursePattern(rng: () => number, count: number, width: number): Course[] {
  const out: Course[] = [];
  let w = width;
  for (let i = 0; i < count; i++) {
    // Every course draws all its numbers, used or not, so one seed's pattern never shifts with another's choices.
    const deep = rng() < 0.18, hr = rng(), step = rng(), stepBy = rng(), slip = rng(), isSplit = rng() < 0.25, splitAt = rng(), tone = rng();
    const h = deep ? 3 + 1 * hr : 1.6 + 0.9 * hr;
    if (step < 0.3) w = clamp(w + (stepBy - 0.5) * 0.5 * width, width * 0.8, width * 1.2);
    out.push({ h, w, d: w * 0.8, slip: (slip - 0.5) * 0.2 * width, split: isSplit ? 0.3 + 0.4 * splitAt : 0, tone: 0.55 + 0.45 * tone });
  }
  return out;
}

/** One slab of a tower, with the course it belongs to and where in the tower's height it stands (0..1). */
export interface Piece { sl: Slab; course: number; piece: number; centre: number }
export interface Tower { id: 'near' | 'far'; pieces: Piece[]; top: THREE.Vector3; base: THREE.Vector3 }

export interface TowerSpec {
  id: Tower['id']; base: THREE.Vector3; yaw: number;
  /** Lean in the picture plane, radians: positive tips the top to the left. */
  lean: number;
  /** The height the roof stands at above the ground. */
  height: number;
  /** The courses, in order from the ground. */
  courses: Course[];
  /** +1, or -1 to mirror the pattern left for right. */
  mirror: number;
  /** Lateral shear per unit of height, and a one-off slide of every course from `slideFrom` up, both in world units. */
  shear: number; slide: number; slideFrom: number;
}

/** A tower of slab courses scaled to stand `height` tall along its (leaning) axis; its top is the centre of the roof. */
export function buildTower(spec: TowerSpec): Tower {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, spec.lean)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, spec.yaw, 0)));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q), side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const along = spec.height / axis.y;
  const scale = along / spec.courses.reduce((s, c) => s + c.h, 0);
  const pieces: Piece[] = [];
  const gap = 0.08 * scale;
  let y = 0;
  spec.courses.forEach((c, i) => {
    const h = c.h * scale, w = c.w * scale, d = c.d * scale;
    const yc = y + h / 2;
    const lateral = spec.shear * yc + (i >= spec.slideFrom ? spec.slide : 0) + c.slip * scale * spec.mirror;
    const centre = spec.base.clone().addScaledVector(axis, yc).addScaledVector(side, lateral);
    const split = i === spec.courses.length - 1 ? 0 : c.split;
    const parts: [number, number][] = split
      ? [[-w / 2 + w * split / 2, w * split - 0.3 * scale], [w * split / 2, w * (1 - split) - 0.3 * scale]]
      : [[0, w]];
    parts.forEach(([off, pw], k) => {
      const pc = centre.clone().addScaledVector(side, off * spec.mirror);
      const sl = solid(pc.x, pc.y, pc.z, pw, h - gap, d, pieces.length, 'stack');
      sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
      sl.tone = c.tone;
      pieces.push({ sl, course: i, piece: k, centre: yc / along });
    });
    y += h;
  });
  const roof = spec.base.clone().addScaledVector(axis, along).addScaledVector(side, spec.shear * along + (spec.courses.length - 1 >= spec.slideFrom ? spec.slide : 0));
  return { id: spec.id, pieces, top: roof, base: spec.base };
}

/**
 * A slab drawn in the raking-light hatch, calmed and in carbon only. The outline always shows; the
 * contour rings and the diagonal fields come only on the faces the light leaves darker than `calm`
 * (0..1), so lit faces stay blank paper and the hatch follows the light. Each stroke belongs to the
 * face whose plane it lies in.
 */
export function calmFacets(sl: Slab, light: THREE.Vector3, eye: THREE.Vector3, outlineOnly: boolean, pitch: number, calm: number): FacetStroke[] {
  const strokes = facetStrokes(sl, light, eye, outlineOnly, pitch);
  if (outlineOnly) return strokes.map(st => ({ ...st, ink: 'carbon' as const }));
  const m = slabMatrix(sl);
  const centre = new THREE.Vector3(sl.x, sl.y, sl.z);
  const rot = new THREE.Matrix4().extractRotation(m);
  const half = [sl.w / 2, sl.h / 2, sl.d / 2];
  const faces = [0, 1, 2].flatMap(axis => [1, -1].map(sign => {
    const normal = new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0).applyMatrix4(rot);
    return { normal, at: centre.clone().addScaledVector(normal, half[axis]), dark: faceDarkness(normal, light, sl.tone) };
  }));
  const out: FacetStroke[] = [];
  for (const st of strokes) {
    if (st.family === 'edge') { out.push({ ...st, ink: 'carbon' }); continue; }
    const p = st.points[0];
    let best = faces[0], gap = Infinity;
    for (const face of faces) { const d = Math.abs(p.clone().sub(face.at).dot(face.normal)); if (d < gap) { gap = d; best = face; } }
    if (best.dark >= calm) out.push({ ...st, ink: 'carbon' });
  }
  return out;
}
