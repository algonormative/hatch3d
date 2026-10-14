import * as THREE from 'three';
import { facetStrokes, slabMatrix, type Slab } from '../../kit/slabs.ts';
import type { Stroke } from '../../kit/types.ts';

/**
 * A slab drawn as plain stone: the twelve outline edges, and on each face that sees the eye one
 * family of dense parallel hatch, with no inset window. Faces turned from the light (the fronts
 * and the undersides, under a light from behind) take the hatch at `pitch` units; the tops,
 * which the light reaches, take it `topOpen` times as open. `angle` is the hatch's direction on a
 * face, in radians from its horizontal edge; `course` alternates it so neighbouring courses
 * read apart. Given the card's camera (`view`), off tabloid the outline is trimmed (kit/slabs.ts' `SlabTrim`: no back
 * edges, and a face narrower on paper than the smallest feature folded into it).
 */
export function stoneStrokes(sl: Slab, eye: THREE.Vector3, pitch: number, course: number, group: string, topOpen = 3, view?: THREE.Camera): Stroke[] {
  const out: Stroke[] = [];
  for (const st of facetStrokes(sl, new THREE.Vector3(0, 0, -1), eye, true, undefined, view ? { view } : undefined)) out.push({ ink: st.ink, group, family: st.family, points: st.points });
  const m = slabMatrix(sl);
  const rot = new THREE.Matrix4().extractRotation(m);
  const hx = sl.w / 2, hy = sl.h / 2, hz = sl.d / 2;
  const faces: { c: THREE.Vector3; U: THREE.Vector3; V: THREE.Vector3; open: number; angle: number }[] = [
    { c: new THREE.Vector3(0, 0, hz), U: new THREE.Vector3(hx, 0, 0), V: new THREE.Vector3(0, hy, 0), open: 1, angle: (course % 2 ? 1 : -1) * 0.95 },
    { c: new THREE.Vector3(0, -hy, 0), U: new THREE.Vector3(hx, 0, 0), V: new THREE.Vector3(0, 0, hz), open: 1, angle: 0.6 },
    { c: new THREE.Vector3(0, hy, 0), U: new THREE.Vector3(hx, 0, 0), V: new THREE.Vector3(0, 0, hz), open: topOpen, angle: 0.6 },
  ];
  const e = 0.006, margin = 0.06;
  for (const { c, U, V, open, angle } of faces) {
    const normal = c.clone().normalize().applyMatrix4(rot);
    const centre = c.clone().applyMatrix4(m).addScaledVector(normal, e);
    if (eye.clone().sub(centre).dot(normal) <= 0) continue;
    const a = U.length() - margin, b = V.length() - margin;
    if (a <= 0 || b <= 0) continue;
    const Ud = U.clone().normalize().applyMatrix4(rot), Vd = V.clone().normalize().applyMatrix4(rot);
    const at = (u: number, v: number) => centre.clone().addScaledVector(Ud, u).addScaledVector(Vd, v);
    const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    const step = pitch * open;
    const reach = Math.hypot(a, b);
    for (let k = -reach + step / 2; k < reach; k += step) {
      const span = clipRect(nx * k, ny * k, dx, dy, a, b);
      if (span) out.push({ ink: 'carbon', group, family: 'hatch', points: [at(nx * k + dx * span[0], ny * k + dy * span[0]), at(nx * k + dx * span[1], ny * k + dy * span[1])] });
    }
  }
  return out;
}

/** Clip the line o + s·dir to |u| ≤ a, |v| ≤ b: the parameter range, or null when it misses. */
function clipRect(ox: number, oy: number, dx: number, dy: number, a: number, b: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [o, d, h] of [[ox, dx, a], [oy, dy, b]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(o) > h) return null; continue; }
    const t0 = (-h - o) / d, t1 = (h - o) / d;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}
