import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n } from '../../kit/params.ts';
import { atPage } from '../../kit/perspective.ts';
import { MOON_DIST } from './crescent.ts';

/**
 * The moon as a station built into a moon: a dark body of rock, nearly round, with a long spine of
 * slabs driven into it and standing far out past its limb, a collar of slabs where the spine goes in,
 * a ring of slabs for a dock on its flank and small blocks scattered over the lit ground. Everything
 * is lit only from the side its sun is on; nothing on it shines. The rock is ruled with field lines
 * that wrap it square to the spine, dense over the dark side and opening to paper on the lit limb.
 */
export interface Station {
  centre: THREE.Vector3;
  /** Mean radius, and the rock's radius along a unit direction (a little irregular). */
  radius: number; surface: (dir: THREE.Vector3) => number;
  /** The field lines' axis, and two directions square to it. */
  axis: THREE.Vector3; b1: THREE.Vector3; b2: THREE.Vector3;
  spine: Slab[]; collar: Slab[]; dock: Slab[]; scatter: Slab[];
  /** Craters on the lit ground: a direction and an angular radius each. */
  craters: { dir: THREE.Vector3; size: number }[];
  /** Toward the sun. */
  light: THREE.Vector3;
  /** Toward the eye, from the centre. */
  toEye: THREE.Vector3;
  /** A slow field over the rock, -1..1: dark ground where it is high. */
  ground: (dir: THREE.Vector3) => number;
}

/** A slab at `at` whose local axes are `x`, `y` (its height) and `z` (its depth), each a unit vector, right-handed. */
function placed(at: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, w: number, h: number, d: number, beat: number): Slab {
  const sl = solid(at.x, at.y, at.z, w, h, d, beat, 'stack');
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z), 'XYZ');
  sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
  return sl;
}

/** Two unit vectors square to `a` and to each other, right-handed with it as (b1, a, b2). */
function square(a: THREE.Vector3, hint: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const b1 = hint.clone().addScaledVector(a, -hint.dot(a)).normalize();
  const b2 = b1.clone().cross(a).normalize();
  return [b1, b2];
}

export function station(ctx: SketchContext, view: THREE.PerspectiveCamera, focal: number): Station {
  const rng = ctx.random('moon-station');
  const page = { x: n(ctx, 'stationX', 176, 120, 240), y: n(ctx, 'stationY', 128, 80, 170) };
  const centre = atPage(view, page, MOON_DIST);
  const unit = centre.distanceTo(view.position) / focal;
  const R = n(ctx, 'stationSize', 50, 35, 65) * unit;
  // The view's frame at the moon: z toward the eye, y up the sheet, x across it.
  const zc = view.position.clone().sub(centre).normalize();
  const xc = new THREE.Vector3(0, 1, 0).cross(zc).normalize();
  const yc = zc.clone().cross(xc);
  // The rock: a sphere with a few slow swells, so its rim is never quite true.
  const swells = Array.from({ length: 4 }, () => ({
    dir: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), f: 2 + 2.5 * rng(), ph: rng() * Math.PI * 2,
  }));
  const rough = n(ctx, 'stationRough', 0.04, 0, 0.1);
  const surface = (dir: THREE.Vector3) => R * (1 + rough * swells.reduce((acc, s) => acc + Math.sin(s.f * dir.dot(s.dir) + s.ph), 0) / 2);
  // The spine: driven in from the upper left, its far end leaning toward the eye.
  const lean = THREE.MathUtils.degToRad(n(ctx, 'spineLean', 52, -80, 80));
  const tip = THREE.MathUtils.degToRad(n(ctx, 'spineTip', 30, -45, 60));
  const inPlane = yc.clone().multiplyScalar(Math.cos(lean)).addScaledVector(xc, -Math.sin(lean));
  const S = inPlane.clone().multiplyScalar(Math.cos(tip)).addScaledVector(zc, Math.sin(tip)).normalize();
  // Its broad face turned a little off the eye, so one flank shows.
  const [sx0, sz0] = square(S, xc);
  const turn = n(ctx, 'spineTurn', 0.45, -1.2, 1.2);
  const sx = sx0.clone().multiplyScalar(Math.cos(turn)).addScaledVector(sz0, Math.sin(turn));
  const sz = sx.clone().cross(S).normalize();
  const width = n(ctx, 'spineWidth', 0.36, 0.12, 0.5) * R, thick = width * 0.32;
  const reach = n(ctx, 'spineReach', 1.2, 0.2, 1.6) * R;
  const segments = Math.round(n(ctx, 'spineSegments', 6, 2, 10));
  const s0 = 0.72 * R, s1 = surface(S) + reach;
  const spine: Slab[] = [];
  const step = (s1 - s0) / segments;
  for (let k = 0; k < segments; k++) {
    const w = width * (0.9 + 0.2 * rng()), d = thick * (0.9 + 0.2 * rng());
    const slide = (rng() - 0.5) * 0.08 * width;
    const yaw = (rng() - 0.5) * 0.08;
    const x = sx.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(sz, Math.sin(yaw));
    const z = x.clone().cross(S).normalize();
    const at = centre.clone().addScaledVector(S, s0 + (k + 0.5) * step).addScaledVector(sx, slide);
    spine.push(placed(at, x, S, z, w, step * 0.965, d, k));
  }
  // The collar: two rings of slabs round the spine where it goes in. The rock under it is cut level: the outer ring
  // is seated on the highest ground its footprint covers and runs down into the rock, the inner ring stands on it.
  const collar: Slab[] = [];
  const ring = n(ctx, 'collarSize', 1, 0.6, 1.6);
  const heightAt = (r: number, a: number) => {
    const u = sx.clone().multiplyScalar(Math.cos(a)).addScaledVector(sz, Math.sin(a));
    const dir = S.clone().multiplyScalar(Math.sqrt(Math.max(0, R * R - r * r))).addScaledVector(u, r).normalize();
    return Math.sqrt(Math.max(0, surface(dir) ** 2 - r * r));
  };
  let seat = 0;
  for (let k = 0; k < 36; k++) for (const r of [0.22, 0.3, 0.39]) seat = Math.max(seat, heightAt(r * ring * R, k * Math.PI / 18));
  // Each tier: radius round the spine, slabs, centre height above the seat, height, depth (all in radii).
  const tiers: [number, number, number, number, number][] = [[0.34 * ring, 8, -0.02, 0.16, 0.08], [0.27 * ring, 6, 0.1, 0.07, 0.06]];
  tiers.forEach(([r, count, lift, tall, deep]) => {
    const radius = r * R;
    const spin = rng() * Math.PI;
    for (let k = 0; k < count; k++) {
      const a = spin + k * 2 * Math.PI / count;
      const u = sx.clone().multiplyScalar(Math.cos(a)).addScaledVector(sz, Math.sin(a));
      const at = centre.clone().addScaledVector(S, seat + lift * R).addScaledVector(u, radius);
      const x = S.clone().cross(u).normalize();
      collar.push(placed(at, x, S, u, 2 * Math.PI * radius / count * 0.86, tall * R, deep * R, 100 + collar.length));
    }
  });
  // The dock: a ring of slabs set into the lower flank.
  const dock: Slab[] = [];
  if (n(ctx, 'dock', 1, 0, 1) > 0.5) {
    const nd = xc.clone().multiplyScalar(-0.5).addScaledVector(yc, -0.5).addScaledVector(zc, 0.72).normalize();
    const [d1, d2] = square(nd, yc);
    const radius = 0.13 * R, count = 9;
    for (let k = 0; k < count; k++) {
      const a = k * 2 * Math.PI / count;
      const u = d1.clone().multiplyScalar(Math.cos(a)).addScaledVector(d2, Math.sin(a));
      const at = centre.clone().addScaledVector(nd, surface(nd) - 0.005 * R).addScaledVector(u, radius);
      dock.push(placed(at, nd.clone().cross(u).normalize(), nd, u, 2 * Math.PI * radius / count * 0.78, 0.05 * R, 0.04 * R, 200 + k));
    }
  }
  // The sun: from the left and a little behind and above, so the lit limb faces the towers it lights, and the spine stands in it.
  const light = xc.clone().multiplyScalar(n(ctx, 'sunSide', -0.85, -1.5, 1.5)).addScaledVector(yc, 0.3).addScaledVector(zc, -n(ctx, 'sunBehind', 0, -0.5, 1.2)).normalize();
  // The field lines wrap the rock square to the spine's line across the sheet, tipped a little so they bow.
  const bow = THREE.MathUtils.degToRad(n(ctx, 'fieldBow', 10, -40, 40));
  const axis = inPlane.clone().multiplyScalar(Math.cos(bow)).addScaledVector(zc, Math.sin(bow)).normalize();
  const axisOf = () => axis;
  // Small blocks over the ground the sun reaches, clear of the spine and the dock. None on the night side: nothing there shines.
  const scatter: Slab[] = [];
  const want = Math.round(n(ctx, 'scatter', 20, 0, 60));
  const nd = dock.length ? new THREE.Vector3(dock[0].x, dock[0].y, dock[0].z).sub(centre).normalize() : null;
  for (let tries = 0; scatter.length < want && tries < 4000; tries++) {
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    const len = dir.length();
    const spinR = rng(), sz1 = rng(), sz2 = rng(), sz3 = rng();
    if (len > 1 || len < 0.1) continue;
    dir.divideScalar(len);
    if (dir.dot(zc) < 0.2 || dir.dot(light) < -0.05 || dir.angleTo(S) < 0.55 || (nd && dir.angleTo(nd) < 0.32)) continue;
    if (scatter.some(o => new THREE.Vector3(o.x, o.y, o.z).sub(centre).normalize().angleTo(dir) < 0.12)) continue;
    const size = R * (0.025 + 0.04 * sz1 ** 2);
    // Laid along the field lines, a few a little askew, as if set out by the same hand.
    const [a1, a2] = square(dir, yc);
    const along = new THREE.Vector3().crossVectors(axisOf(), dir).normalize();
    const a = Math.atan2(along.dot(a2), along.dot(a1)) + (spinR < 0.7 ? 0 : (spinR - 0.85) * 1.2);
    const x = a1.clone().multiplyScalar(Math.cos(a)).addScaledVector(a2, Math.sin(a));
    const z = x.clone().cross(dir).normalize();
    const h = size * (0.6 + 0.8 * sz2);
    const at = centre.clone().addScaledVector(dir, surface(dir) + 0.1 * h);
    scatter.push(placed(at, x, dir, z, size * (1 + sz3), h, size * (0.8 + 0.5 * sz3), 300 + scatter.length));
  }
  for (const sl of [...spine, ...collar, ...dock, ...scatter]) sl.tone = 0.6 + 0.4 * rng();
  // The collar and the dock are pale stone, so only their faces turned well away from the sun are hatched.
  for (const sl of [...collar, ...dock]) sl.tone *= n(ctx, 'collarTone', 0.6, 0.2, 1.2);
  const [b1, b2] = square(axis, zc);
  // Craters on the lit ground, clear of the blocks.
  const craters: { dir: THREE.Vector3; size: number }[] = [];
  const pits = Math.round(n(ctx, 'craters', 6, 0, 20));
  for (let tries = 0; craters.length < pits && tries < 4000; tries++) {
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    const len = dir.length(), size = 0.025 + 0.035 * rng() ** 1.5;
    if (len > 1 || len < 0.1) continue;
    dir.divideScalar(len);
    if (dir.dot(zc) < 0.25 || dir.dot(light) < 0.12 || dir.angleTo(S) < 0.6 || (nd && dir.angleTo(nd) < 0.35)) continue;
    if (craters.some(c => c.dir.angleTo(dir) < c.size + size + 0.04)) continue;
    if (scatter.some(o => new THREE.Vector3(o.x, o.y, o.z).sub(centre).normalize().angleTo(dir) < size + 0.03)) continue;
    craters.push({ dir, size });
  }
  // Dark ground and pale ground: a slow field over the rock, so the lit face is mottled like any moon's.
  const grain = Array.from({ length: 3 }, () => ({ dir: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), f: 3 + 4 * rng(), ph: rng() * Math.PI * 2 }));
  const ground = (dir: THREE.Vector3) => grain.reduce((acc, g) => acc + Math.sin(g.f * dir.dot(g.dir) + g.ph), 0) / 3;
  return { centre, radius: R, surface, axis, b1, b2, spine, collar, dock, scatter, craters, light, toEye: zc, ground };
}

/** The rock as a mesh, for the depth pass and the sky's knockout. */
export function rockMesh(st: Station): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 120, 80);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const p = st.centre.clone().addScaledVector(v, st.surface(v));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeBoundingSphere();
  return g;
}

/** A point on the rock, a hair proud of it, in direction `dir`. */
export function onRock(st: Station, dir: THREE.Vector3, proud = 0.004): THREE.Vector3 {
  return st.centre.clone().addScaledVector(dir, st.surface(dir) * (1 + proud));
}
