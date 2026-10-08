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
  // The stream's course is laid on the sheet: an arc that rises from the tower's throat and bends over toward the
  // moon, receding as it goes (from the tower's distance to `wolfAway` times it).
  const d0 = start.distanceTo(eye), away = n(ctx, 'wolfAway', 1.9, 1, 3);
  const span = Math.hypot(endPage.x - startPage.x, endPage.y - startPage.y);
  const ctrl = { x: startPage.x + (endPage.x - startPage.x) * 0.15, y: Math.min(startPage.y, endPage.y) - span * n(ctx, 'wolfRise', 0.25, 0, 1) };
  const pageAt = (u: number) => ({
    x: (1 - u) ** 2 * startPage.x + 2 * u * (1 - u) * ctrl.x + u * u * endPage.x,
    y: (1 - u) ** 2 * startPage.y + 2 * u * (1 - u) * ctrl.y + u * u * endPage.y,
  });
  const path = {
    getPointAt: (u: number) => atPage(view, pageAt(u), d0 * (1 + (away - 1) * u)),
    getTangentAt: (u: number) => atPage(view, pageAt(Math.min(1, u + 0.01)), d0 * (1 + (away - 1) * Math.min(1, u + 0.01))).sub(atPage(view, pageAt(Math.max(0, u - 0.01)), d0 * (1 + (away - 1) * Math.max(0, u - 0.01)))).normalize(),
  };
  // The stream is laid out by length on the sheet, not in the world: it recedes as it rises, and spacing by world
  // length would bunch it up where it goes back. Spacing grows steadily with height, as its spread does.
  const SAMPLES = 240;
  const along: number[] = [0];
  let prev = startPage;
  for (let i = 1; i <= SAMPLES; i++) {
    const q = pageOf(view, path.getPointAt(i / SAMPLES));
    along.push(along[i - 1] + Math.hypot(q.x - prev.x, q.y - prev.y));
    prev = q;
  }
  const uAt = (share: number) => {
    const want = share * along[SAMPLES];
    let i = 1;
    while (i < SAMPLES && along[i] < want) i++;
    const span = along[i] - along[i - 1] || 1;
    return (i - 1 + (want - along[i - 1]) / span) / SAMPLES;
  };
  const flyers = near.slice(seat);
  const count = flyers.length + Math.round(n(ctx, 'wolfStream', 16, 0, 40));
  const spread = n(ctx, 'wolfSpread', 2.2, 0, 3);
  const tumble = n(ctx, 'wolfTumble', 1, 0, 2.5);
  const ease = n(ctx, 'wolfEase', 1.1, 0.6, 2.5);
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
    // A slab that would touch one already flying is tried again near the same place along the stream, at a new offset,
    // so the stream stays evenly filled instead of piling up further along.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) { draws[2] = rng(); draws[3] = rng(); }
      const share = Math.min(1, ((k + 0.6 + (attempt > 0 ? (rng() - 0.5) * 0.8 : 0)) / count) ** ease);
      const u = uAt(share);
      const at = path.getPointAt(u);
      const tangent = path.getTangentAt(u);
      const side = tangent.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
      // Spread in world units scaled by distance, so on the sheet it widens steadily with height.
      const sigma = W * (0.12 + spread * share) * at.distanceTo(eye) / d0;
      at.addScaledVector(side, sigma * (draws[2] - 0.5) * 2).addScaledVector(new THREE.Vector3(0, 0, 1), sigma * 0.6 * (draws[3] - 0.5) * 2);
      const shrink = (k < flyers.length ? 1 : 0.55 + 0.4 * draws[4]) * (1 - n(ctx, 'wolfShrink', 0.5, 0, 0.8) * share);
      const body = shard
        ? solid(at.x, at.y, at.z, W * (0.7 + 0.6 * draws[4]) * (1 - 0.4 * share), W * 0.06, W * (0.14 + 0.1 * draws[5]), 800 + k, 'stack')
        : { ...course, x: at.x, y: at.y, z: at.z, w: course.w * shrink, h: course.h * shrink, d: course.d * shrink };
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((draws[6] - 0.5) * 1.6 * share * tumble, (draws[7] - 0.5) * 2.2 * share * tumble, (draws[8] - 0.5) * 1.4 * share * tumble + (shard ? (draws[5] - 0.5) * 2 : 0)));
      const slab = turned({ ...body, ry: shard ? 0 : course.ry, rx: 0, rz: 0 }, q);
      if (!moonClear(slab)) continue;
      if (placedW.some(o => touches(slab, o, W * 0.05)) || others.some(o => touches(slab, o, W * 0.1))) continue;
      placedW.push(slab);
      break;
    }
  }

  // The dog: lifted a little course by course as it strains, then staked.
  const Wd = far[0].w;
  const strain = (i: number) => Wd * 0.012 + far[0].h * n(ctx, 'dogStrain', 0.05, 0, 0.3) * (i / far.length);
  const lifted = restack(far, strain);
  const heightD = Math.max(...lifted.map(s => s.y + halfHeight(s)));
  // The stakes' slope on the sheet, travelling down it to the left: `stakeSlope` degrees, or (at 0) the volley's own,
  // the steepest of its slabs (toward the mean by `stakeSteep`). At seed 1 the volley lies nearly level (one slab at
  // 32°), and stakes at that slope read as rails leaning on the dog; steep ones read as driven down from the sky.
  const slopes = moon.volley.map(sl => {
    const [x] = axesOf(sl);
    const c = new THREE.Vector3(sl.x, sl.y, sl.z);
    const a = pageOf(view, c.clone().addScaledVector(x, -sl.w / 2)), b = pageOf(view, c.clone().addScaledVector(x, sl.w / 2));
    let dx = b.x - a.x, dy = b.y - a.y;
    if (dx < 0) { dx = -dx; dy = -dy; }
    return Math.atan2(-dy, dx);
  });
  const steep = n(ctx, 'stakeSteep', 1, 0, 1);
  const mean = slopes.reduce((acc, v) => acc + v, 0) / Math.max(1, slopes.length);
  const override = n(ctx, 'stakeSlope', 68, 0, 80);
  const slope = override > 0 ? THREE.MathUtils.degToRad(override) : slopes.length ? mean + (Math.max(...slopes) - mean) * steep : 0.6;
  const toward = n(ctx, 'stakeToward', -0.5, -1, 1);
  const stakes: Slab[] = [];
  const footD = new THREE.Vector3(lifted[0].x, 0, lifted[0].z);
  const stakeCount = Math.round(n(ctx, 'stakes', 3, 1, 3));
  const high = n(ctx, 'stakeHigh', 0.7, 0.2, 0.9), low = n(ctx, 'stakeLow', 0.42, 0.05, 0.8);
  const heights = Array.from({ length: stakeCount }, (_, i) => stakeCount === 1 ? high : low + (high - low) * i / (stakeCount - 1));
  const bury = Wd * 0.3;
  for (const [i, frac] of heights.entries()) {
    const cross = footD.clone().setY(heightD * frac).add(new THREE.Vector3((n(ctx, 'stakeShift', 0.3, -0.5, 0.5) + (rng() - 0.5) * 0.2) * Wd, 0, (rng() - 0.5) * 0.25 * Wd));
    const cp = pageOf(view, cross);
    // The world direction, down and to the left in the plane facing the eye, whose line on the sheet has the volley's slope.
    let best = new THREE.Vector3(-1, -1, 0).normalize(), err = Infinity;
    for (let a = 1; a < 180; a++) {
      const phi = a / 180 * Math.PI / 2;
      const d = new THREE.Vector3(-Math.cos(phi), -Math.sin(phi), toward * Math.sin(phi)).normalize();
      const q = pageOf(view, cross.clone().addScaledVector(d, Wd));
      const e = Math.abs(Math.atan2(q.y - cp.y, cp.x - q.x) - slope);
      if (e < err) { err = e; best = d; }
    }
    const down = cross.y / -best.y + bury;
    // Up toward the sky as far as the card allows.
    let up = Wd * n(ctx, 'stakeReach', 3, 0.8, 6);
    const inCard = (p: THREE.Vector3) => { const q = pageOf(view, p); return q.x < CARD.x1 - 6 && q.y > CARD.y0 + 8; };
    while (up > Wd * 0.6 && !inCard(cross.clone().addScaledVector(best, -up))) up -= Wd * 0.04;
    const w = Wd * (0.09 + 0.03 * rng()), t = w * 0.5;
    const stake = spear(cross.clone().addScaledVector(best, -up), best, 0, up + down, w, t, (rng() - 0.5) * 0.4, 900 + i);
    if (stakes.some(o => touches(stake, o, Wd * 0.04)) || placedW.some(o => touches(stake, o, Wd * 0.05))) continue;
    stakes.push(stake);
  }
  // Cracked where struck: a course a stake is driven through breaks once, where its most central stake crosses it,
  // and the two pieces kink up away from the break, so the break slants; down the tower the breaks follow the stake.
  // The stakes run on through the pieces (hidden inside). The levels are stacked again so nothing touches.
  const kink = n(ctx, 'dogKink', 0.14, 0, 0.3);
  const levels = lifted.map(course => {
    const [x, , z] = axesOf(course);
    const c = new THREE.Vector3(course.x, course.y, course.z);
    const cuts: number[] = [];
    for (const st of stakes) {
      if (!touches(course, st, Wd * 0.02)) continue;
      // Where the stake's axis passes closest to the course's long axis, along the course.
      const [D] = axesOf(st);
      const q0 = new THREE.Vector3(st.x, st.y, st.z);
      const r = c.clone().sub(q0), b = x.dot(D), dd = x.dot(r), e = D.dot(r);
      const den = 1 - b * b;
      const sAt = den > 1e-6 ? (b * e - dd) / den : 0;
      if (Math.abs(sAt) < course.w / 2 - Wd * 0.08) cuts.push(sAt);
    }
    if (!cuts.length) return [course];
    cuts.sort((p, q) => Math.abs(p) - Math.abs(q));
    cuts.length = 1;
    const crack = Wd * 0.02;
    const edges = [-course.w / 2, ...cuts, course.w / 2];
    const bits: Slab[] = [];
    for (let k = 0; k < edges.length - 1; k++) {
      const len = edges[k + 1] - edges[k] - crack;
      if (len < Wd * 0.08) continue;
      const mid = (edges[k] + edges[k + 1]) / 2;
      const piece = { ...course, w: len, x: course.x + x.x * mid, y: course.y + x.y * mid, z: course.z + x.z * mid };
      // End pieces kink up at their far ends; a piece between two stakes is held at both and only twists a little.
      const angle = k === 0 ? -kink : k === edges.length - 2 ? kink : (rng() - 0.5) * kink * 0.6;
      bits.push(turned(piece, new THREE.Quaternion().setFromAxisAngle(z, angle * (0.8 + 0.4 * rng()))));
    }
    return bits;
  });
  let roof = 0;
  const dog: Slab[] = [];
  levels.forEach((level, i) => {
    const below = Math.max(...level.map(s => halfHeight(s) - (s.y - level[0].y)));
    const above = Math.max(...level.map(s => halfHeight(s) + (s.y - level[0].y)));
    const y0 = i === 0 ? below : roof + strain(i) + below;
    const shift = y0 - level[0].y;
    for (const s of level) dog.push({ ...s, y: s.y + shift });
    roof = y0 + above;
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
