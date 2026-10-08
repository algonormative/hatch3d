import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n } from '../../kit/params.ts';
import { atPage } from '../../kit/perspective.ts';

/** How far off the moon hangs, in world units: far behind everything that stands. */
export const MOON_DIST = 4000;

export interface Crescent {
  slabs: Slab[];
  /** The disc's centre, its radius, and its plane's frame (local z toward the eye, then turned). */
  centre: THREE.Vector3; radius: number; frame: THREE.Quaternion;
  /** The local angle of the lit limb's middle, and of each horn from it. */
  bulge: number; horns: number;
  /** The light on the crescent, from the side its sun is on. */
  light: THREE.Vector3;
}

/**
 * The moon as a crescent of cantilevered slabs, corbelled: a few courses of long straight slabs laid
 * round the lit limb, the outer course running nearly horn to horn, each course inside it shorter and
 * every other one stepped out toward the eye, so the crescent is thickest at its middle and thins to
 * the horns in steps, and reads as built, not drawn. The disc's plane faces the eye, turned a little on its upright
 * and tipped back. Its light comes from the side the crescent bulges toward, where a sun below the
 * horizon would be: none of the moon's light is its own.
 */
export function crescent(ctx: SketchContext, view: THREE.PerspectiveCamera, focal: number): Crescent {
  const rng = ctx.random('moon-crescent');
  const page = { x: n(ctx, 'moonX', 178, 120, 245), y: n(ctx, 'moonY', 108, 55, 160) };
  const centre = atPage(view, page, MOON_DIST);
  const unit = centre.distanceTo(view.position) / focal;
  const R = n(ctx, 'moonSize', 50, 25, 55) * unit;
  // Local frame: z toward the eye, y up, x to the right; then turned on its upright and tipped back.
  const z = view.position.clone().sub(centre).normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(n(ctx, 'moonTip', 0.12, -0.6, 0.6), n(ctx, 'moonTurn', -0.35, -1, 1), 0, 'YXZ')));
  const bulge = THREE.MathUtils.degToRad(n(ctx, 'moonBulge', -38, -180, 180));
  // The dark disc is the same disc shifted away from the bulge by `e`: the crescent lies between them.
  const e = n(ctx, 'moonPhase', 0.42, 0.15, 0.7) * R;
  const thick = (d: number) => R + e * Math.cos(d) - Math.sqrt(Math.max(0, R * R - e * e * Math.sin(d) ** 2));
  const horns = Math.acos(-e / (2 * R));
  const courses = Math.round(n(ctx, 'moonCourses', 4, 1, 5));
  const t = e / courses;
  const depth = t * n(ctx, 'moonDepth', 1.8, 0.5, 3);
  const most = THREE.MathUtils.degToRad(n(ctx, 'moonSlabArc', 40, 12, 60));
  const slabs: Slab[] = [];
  for (let c = 0; c < courses; c++) {
    // A course runs where the crescent is thick enough to hold it; the outer one nearly to the horns.
    let reach = 0;
    while (reach < horns && thick(reach + 0.005) > (c + (c === 0 ? 0.2 : 0.5)) * t) reach += 0.005;
    if (reach < 0.05) continue;
    // Slab joints are staggered course to course: odd counts on the outer course, even on the next, and so on.
    let count = Math.max(1, Math.ceil(2 * reach / most));
    if ((count + c) % 2 === 0) count++;
    const step = 2 * reach / count;
    // Every other course stands a slab's depth (and a hair) nearer the eye, so neighbouring courses overlap without touching.
    const zc = (c % 2) * depth * 1.04;
    for (let k = 0; k < count; k++) {
      const d = -reach + (k + 0.5) * step;
      const a = bulge + d;
      // The slab is as thick as the crescent leaves room for, so the end slabs taper to the horns.
      const h = Math.max(0.3 * t, Math.min(t, thick(d) - c * t)) * (0.96 + 0.06 * rng());
      const rc = R - c * t - h / 2;
      // Straight chords, cut short of the joint at their inner edge so neighbours never meet.
      const length = 2 * (rc - h / 2) * Math.sin(step / 2) * (0.985 - 0.02 * rng());
      const local = new THREE.Vector3(rc * Math.cos(a), rc * Math.sin(a), zc);
      const at = centre.clone().add(local.applyQuaternion(frame));
      const sl = solid(at.x, at.y, at.z, length, h, depth, slabs.length, 'stack');
      const q = frame.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2 + (rng() - 0.5) * 0.04, 'XYZ')));
      const eu = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      sl.rx = eu.x; sl.ry = eu.y; sl.rz = eu.z;
      sl.tone = n(ctx, 'moonTone', 0.6, 0, 1) * (0.4 + 1.2 * rng());
      slabs.push(sl);
    }
  }
  const light = new THREE.Vector3(Math.cos(bulge) * 0.75, Math.sin(bulge) * 0.75, n(ctx, 'moonFront', 0.55, 0, 1.5)).normalize().applyQuaternion(frame);
  return { slabs, centre, radius: R, frame, bulge, horns, light };
}

/** A point on the moon's disc rim at local angle `a`, in its plane. */
export function rimPoint(c: Crescent, a: number, r = c.radius): THREE.Vector3 {
  return c.centre.clone().add(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0).applyQuaternion(c.frame));
}
