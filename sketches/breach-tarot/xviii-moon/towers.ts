import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n } from '../../kit/params.ts';
import { atPage, pageOf } from '../../kit/perspective.ts';
import { CARD, HORIZON_Y } from '../card.ts';

/**
 * The Moon card's towers as the howl: the strike broke the moon, the broken moon's pull tears at the land, and
 * the two towers answer it as the wild and the tame. Built from the towers as they stand (their feet, widths and
 * heights); the pool's false city is untouched.
 */
export type TowerForm = 'stack' | 'howl';

export interface TowerSet {
  near: Slab[]; far: Slab[]; spears: Slab[];
  /** The courses the phrase may be cut into, when not every course of a tower should carry a word. */
  words?: { near: Slab[]; far: Slab[] };
  /** Ground that hides what is driven into it: drawn into the towers' depth pass only. */
  ground?: THREE.BufferGeometry[];
}

/** What the howl needs of the moon: where it hangs on the sheet and how big, and the line its slabs are driven along. */
export interface MoonMark { page: { x: number; y: number }; radius: number; volley: Slab[] }

/** The slab's three axes, as world unit vectors. */
function axesOf(s: Slab): THREE.Vector3[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ'));
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(v => v.applyQuaternion(q));
}

/** Whether two slabs come within `margin` of each other (separating-axis test on the two boxes, each grown by half the margin). */
export function touches(a: Slab, b: Slab, margin = 0): boolean {
  const A = axesOf(a), B = axesOf(b);
  const ea = [a.w / 2 + margin / 2, a.h / 2 + margin / 2, a.d / 2 + margin / 2], eb = [b.w / 2 + margin / 2, b.h / 2 + margin / 2, b.d / 2 + margin / 2];
  const t = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const axes = [...A, ...B];
  for (const u of A) for (const v of B) { const c = u.clone().cross(v); if (c.lengthSq() > 1e-9) axes.push(c.normalize()); }
  for (const L of axes) {
    const ra = ea.reduce((acc, e, i) => acc + e * Math.abs(A[i].dot(L)), 0);
    const rb = eb.reduce((acc, e, i) => acc + e * Math.abs(B[i].dot(L)), 0);
    if (Math.abs(t.dot(L)) > ra + rb) return false;
  }
  return true;
}

/** Half the slab's extent up the world's vertical. */
function halfHeight(s: Slab): number {
  const [x, y, z] = axesOf(s);
  return Math.abs(x.y) * s.w / 2 + Math.abs(y.y) * s.h / 2 + Math.abs(z.y) * s.d / 2;
}

/** A slab turned by quaternion `q` on top of its own turn. */
function turned(s: Slab, q: THREE.Quaternion): Slab {
  const e = new THREE.Euler().setFromQuaternion(q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ'))), 'XYZ');
  return { ...s, rx: e.x, ry: e.y, rz: e.z };
}

/** Restack slabs bottom up so each clears the one below by `gap(i)`: boxes separated by level planes never touch. */
function restack(slabs: Slab[], gap: (i: number) => number): Slab[] {
  let top = 0;
  return slabs.map((s, i) => {
    const half = halfHeight(s);
    const y = (i === 0 ? 0 : top + gap(i)) + half;
    top = y + half;
    return { ...s, y };
  });
}

/** A thin slab along `dir` through `through`, `before` and `after` long either side, `w` wide and `t` thick. */
function spear(through: THREE.Vector3, dir: THREE.Vector3, before: number, after: number, w: number, t: number, roll: number, beat: number): Slab {
  const up0 = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
  const side = dir.clone().cross(up0).normalize();
  const y = up0.clone().multiplyScalar(Math.cos(roll)).addScaledVector(side, Math.sin(roll));
  const z = dir.clone().cross(y).normalize();
  const mid = through.clone().addScaledVector(dir, (after - before) / 2);
  const sl = solid(mid.x, mid.y, mid.z, before + after, w, t, beat, 'stack');
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, y, z), 'XYZ');
  sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
  return sl;
}

/**
 * The howl: the strike broke the moon, the broken moon's pull tears at the land, and the two towers answer it
 * as the wild and the tame.
 * - The wolf (the near tower) answers the pull: its lower courses stay seated; above them it comes apart, its
 *   courses tearing loose and streaming up and away toward the moon in a rising, turning, widening column of
 *   slabs that sheds shards as it goes, the gaps growing toward the top.
 * - The dog (the far tower) is pinned: thin slabs at the volley's angle on the sheet are driven down through it
 *   into the ground like stakes. Its courses strain upward against them, lifted a little and cracked where struck,
 *   but it holds.
 */
function howl(ctx: SketchContext, view: THREE.PerspectiveCamera, near: Slab[], far: Slab[], moon: MoonMark): TowerSet {
  const rng = ctx.random('moon-howl');
  const eye = view.position;
  // The wolf.
  const seat = Math.round(n(ctx, 'wolfSeat', 4, 2, 7));
  const seated = near.slice(0, seat);
  const W = near[0].w;
  const top = Math.max(...seated.map(s => s.y + halfHeight(s)));
  const start = new THREE.Vector3(near[0].x, top + W * 0.25, near[0].z);
  const startPage = pageOf(view, start);
  const reach = n(ctx, 'wolfReach', 0.72, 0.3, 0.95);
  const endPage = { x: startPage.x + (moon.page.x - startPage.x) * reach, y: startPage.y + (moon.page.y - startPage.y) * reach };
  const end = atPage(view, endPage, start.distanceTo(eye) * n(ctx, 'wolfAway', 1.9, 1, 3));
  // A curve that rises from the tower's throat, then bends toward the moon.
  const bend = start.clone().add(new THREE.Vector3(0, end.distanceTo(start) * n(ctx, 'wolfRise', 0.25, 0, 1), 0));
  const path = new THREE.QuadraticBezierCurve3(start, bend, end);
  const flyers = near.slice(seat);
  const count = flyers.length + Math.round(n(ctx, 'wolfStream', 24, 0, 40));
  const spread = n(ctx, 'wolfSpread', 1.8, 0, 3);
  const tumble = n(ctx, 'wolfTumble', 1, 0, 2.5);
  const placedW: Slab[] = [...seated];
  const others = far;
  const moonClear = (s: Slab) => {
    const q = pageOf(view, new THREE.Vector3(s.x, s.y, s.z));
    return Math.hypot(q.x - moon.page.x, q.y - moon.page.y) > moon.radius + 8 && q.y > CARD.y0 + 8 && q.y < HORIZON_Y - 6 && q.x > CARD.x0 + 6 && q.x < CARD.x1 - 6;
  };
  for (let k = 0; k < count; k++) {
    const draws = Array.from({ length: 9 }, () => rng());
    const course = flyers[k] ?? near[1 + Math.floor(draws[0] * (near.length - 1))];
    const shard = k >= flyers.length && draws[1] < 0.4;
    for (let attempt = 0; attempt < 8; attempt++) {
      const u = Math.min(1, ((k + 0.6 + attempt * 0.15) / count) ** 1.3);
      const at = path.getPointAt(u);
      const tangent = path.getTangentAt(u);
      const side = tangent.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
      const sigma = W * (0.12 + spread * u);
      at.addScaledVector(side, sigma * (draws[2] - 0.5) * 2).addScaledVector(new THREE.Vector3(0, 0, 1), sigma * 0.6 * (draws[3] - 0.5) * 2);
      const shrink = (k < flyers.length ? 1 : 0.55 + 0.4 * draws[4]) * (1 - n(ctx, 'wolfShrink', 0.3, 0, 0.8) * u);
      const body = shard
        ? solid(at.x, at.y, at.z, W * (0.7 + 0.6 * draws[4]) * (1 - 0.4 * u), W * 0.06, W * (0.14 + 0.1 * draws[5]), 800 + k, 'stack')
        : { ...course, x: at.x, y: at.y, z: at.z, w: course.w * shrink, h: course.h * shrink, d: course.d * shrink };
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((draws[6] - 0.5) * 1.6 * u * tumble, (draws[7] - 0.5) * 2.2 * u * tumble, (draws[8] - 0.5) * 1.4 * u * tumble + (shard ? (draws[5] - 0.5) * 2 : 0)));
      const slab = turned({ ...body, ry: shard ? 0 : course.ry, rx: 0, rz: 0 }, q);
      if (!moonClear(slab)) break;
      if (placedW.some(o => touches(slab, o, W * 0.05)) || others.some(o => touches(slab, o, W * 0.1))) continue;
      placedW.push(slab);
      break;
    }
  }

  // The dog: lifted a little course by course as it strains, then staked.
  const Wd = far[0].w;
  const lifted = restack(far, i => Wd * 0.012 + far[0].h * n(ctx, 'dogStrain', 0.05, 0, 0.3) * (i / far.length));
  const heightD = Math.max(...lifted.map(s => s.y + halfHeight(s)));
  // The volley's line on the sheet (the mean of its slabs' lines), and the world direction down through the dog along it.
  let vx = 0, vy = 0;
  for (const sl of moon.volley) {
    const [x] = axesOf(sl);
    const c = new THREE.Vector3(sl.x, sl.y, sl.z);
    const a = pageOf(view, c.clone().addScaledVector(x, -sl.w / 2)), b = pageOf(view, c.clone().addScaledVector(x, sl.w / 2));
    let dx = b.x - a.x, dy = b.y - a.y;
    if (dx < 0) { dx = -dx; dy = -dy; }
    const l = Math.hypot(dx, dy) || 1;
    vx += dx / l; vy += dy / l;
  }
  // Travelling down the sheet: the volley carries on down.
  if (vy < 0) { vx = -vx; vy = -vy; }
  const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
  const descent = THREE.MathUtils.degToRad(n(ctx, 'stakeDescent', 50, 10, 70));
  const stakes: Slab[] = [];
  const footD = new THREE.Vector3(lifted[0].x, 0, lifted[0].z);
  // Low through the dog, so each runs into the ground close by its feet, like a tent's stakes.
  const heights = [0.1, 0.21, 0.32].slice(0, Math.round(n(ctx, 'stakes', 3, 1, 3)));
  for (const [i, frac] of heights.entries()) {
    const cross = footD.clone().setY(heightD * frac).add(new THREE.Vector3((rng() - 0.5) * 0.2 * Wd, 0, (rng() - 0.5) * 0.2 * Wd));
    const cp = pageOf(view, cross);
    let best = new THREE.Vector3(), err = Infinity;
    for (let a = 0; a < 720; a++) {
      const al = a / 720 * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(al) * Math.cos(descent), -Math.sin(descent), Math.sin(al) * Math.cos(descent));
      const q = pageOf(view, cross.clone().addScaledVector(d, 1));
      const ex = q.x - cp.x, ey = q.y - cp.y, el = Math.hypot(ex, ey);
      const e = 1 - (ex * vx + ey * vy) / el;
      if (e < err) { err = e; best = d; }
    }
    const down = (cross.y + Wd * 0.05) / -best.y;
    let up = Wd * (1.1 + 0.5 * rng());
    const inCard = (p: THREE.Vector3) => { const q = pageOf(view, p); return q.x < CARD.x1 - 14 && q.y > CARD.y0 + 6; };
    while (up > Wd * 0.4 && !inCard(cross.clone().addScaledVector(best, -up))) up -= Wd * 0.05;
    const w = Wd * (0.1 + 0.03 * rng()), t = w * 0.5;
    const stake = spear(cross.clone().addScaledVector(best, -up), best, 0, up + down, w, t, (rng() - 0.5) * 0.4, 900 + i);
    if (stakes.some(o => touches(stake, o, Wd * 0.04)) || placedW.some(o => touches(stake, o, Wd * 0.05))) continue;
    stakes.push(stake);
  }
  // Cracked where struck: each course a stake is driven through breaks at a few uneven joints, its pieces slipped
  // and lifted a little against the stake; the stake runs on through them (hidden inside), and only a piece it
  // passes straight through the middle of is gone.
  const margin = Wd * 0.03;
  const axisGap = (b: Slab, st: Slab) => {
    const [x] = axesOf(st);
    const c = new THREE.Vector3(b.x - st.x, b.y - st.y, b.z - st.z);
    return c.addScaledVector(x, -c.dot(x)).length();
  };
  const dog = lifted.flatMap(course => {
    const hit = stakes.filter(st => touches(course, st, margin));
    if (!hit.length) return [course];
    const cuts = [0.2 + 0.15 * rng(), 0.5 + 0.12 * rng(), 0.78 + 0.1 * rng()];
    const [x] = axesOf(course);
    const crack = course.w * 0.012;
    const edges = [0, ...cuts, 1];
    const bits: Slab[] = [];
    for (let k = 0; k < edges.length - 1; k++) {
      const len = (edges[k + 1] - edges[k]) * course.w - crack;
      const off = -course.w / 2 + (edges[k] + edges[k + 1]) / 2 * course.w;
      const lift = course.h * 0.04 * rng();
      const yaw = (rng() - 0.5) * 0.06;
      bits.push(turned({ ...course, w: len, x: course.x + x.x * off, y: course.y + lift, z: course.z + x.z * off }, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)));
    }
    return bits.filter(b => !hit.some(st => axisGap(b, st) < Math.min(b.w, b.h) * 0.25));
  });
  // The ground the stakes go into, round the dog's feet: it hides their buried ends.
  const g = new THREE.PlaneGeometry(Wd * 14, Wd * 14).rotateX(-Math.PI / 2).translate(footD.x - Wd * 3, -0.02, footD.z);
  return { near: placedW, far: dog, spears: stakes, words: { near: seated, far: dog }, ground: [g] };
}

/** The towers for `form`: as they stand, or the howl (which needs the moon). */
export function towerVariant(ctx: SketchContext, form: TowerForm, near: Slab[], far: Slab[], view: THREE.PerspectiveCamera, moon?: MoonMark): TowerSet {
  if (form === 'howl' && moon) return howl(ctx, view, near, far, moon);
  return { near, far, spears: [] };
}
