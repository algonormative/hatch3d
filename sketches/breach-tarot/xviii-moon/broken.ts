import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n } from '../../kit/params.ts';
import { atPage, pageOf } from '../../kit/perspective.ts';
import { CARD } from '../card.ts';

/**
 * The moon broken: a small, far rock cracked into a few big pieces that have drifted a little apart,
 * still one moon, with a few long thin slabs driven right through it at different angles and standing
 * well out on both sides, and small blocks floating round it. It is lit only from the side its sun is
 * on, and nothing on it shines. The rock is ruled with field lines square to the first slab, dense over
 * the night side and opening to paper on the lit limb; each piece is turned a little, so its light
 * differs from its neighbour's and the cracks show.
 */

/** How far off the broken moon hangs, in world units: further than the station was. */
export const BROKEN_DIST = 7000;

export interface Piece {
  /** The point it turns about (its middle, relative to the moon's centre), how far it has drifted, and its turn. */
  pivot: THREE.Vector3; drift: THREE.Vector3; turn: THREE.Quaternion;
}

export interface Broken {
  centre: THREE.Vector3;
  radius: number; surface: (dir: THREE.Vector3) => number;
  /** The cracks: planes `dir·m·r = o` through the rock, relative to its centre. */
  cracks: { m: THREE.Vector3; o: number }[];
  pieces: Map<number, Piece>;
  /** Which piece a direction from the centre falls in. */
  pieceOf: (dir: THREE.Vector3) => number;
  axis: THREE.Vector3; b1: THREE.Vector3; b2: THREE.Vector3;
  piercers: Slab[]; debris: Slab[];
  light: THREE.Vector3; toEye: THREE.Vector3;
  /** A slow field over the rock, -1..1: dark ground where it is high. */
  ground: (dir: THREE.Vector3) => number;
}

function placed(at: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, w: number, h: number, d: number, beat: number): Slab {
  const sl = solid(at.x, at.y, at.z, w, h, d, beat, 'stack');
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z), 'XYZ');
  sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
  return sl;
}

/** Closest distance between two segments a0–a1 and b0–b1. */
function segmentGap(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): number {
  let best = Infinity;
  for (let i = 0; i <= 40; i++) {
    const p = a0.clone().lerp(a1, i / 40);
    const ab = b1.clone().sub(b0);
    const t = Math.max(0, Math.min(1, p.clone().sub(b0).dot(ab) / ab.lengthSq()));
    best = Math.min(best, p.distanceTo(b0.clone().addScaledVector(ab, t)));
  }
  return best;
}

export function broken(ctx: SketchContext, view: THREE.PerspectiveCamera, focal: number): Broken {
  const rng = ctx.random('moon-broken');
  const page = { x: n(ctx, 'brokenX', 178, 120, 240), y: n(ctx, 'brokenY', 108, 70, 160) };
  const centre = atPage(view, page, BROKEN_DIST);
  const unit = centre.distanceTo(view.position) / focal;
  const R = n(ctx, 'brokenSize', 25, 15, 40) * unit;
  const zc = view.position.clone().sub(centre).normalize();
  const xc = new THREE.Vector3(0, 1, 0).cross(zc).normalize();
  const yc = zc.clone().cross(xc);
  const swells = Array.from({ length: 4 }, () => ({
    dir: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), f: 2 + 2.5 * rng(), ph: rng() * Math.PI * 2,
  }));
  const surface = (dir: THREE.Vector3) => R * (1 + 0.04 * swells.reduce((acc, s) => acc + Math.sin(s.f * dir.dot(s.dir) + s.ph), 0) / 2);

  // The cracks: a few planes through the rock near its middle, each at its own angle.
  const crackCount = Math.round(n(ctx, 'cracks', 4, 1, 5));
  const cracks = Array.from({ length: crackCount }, (_, k) => {
    // Spread round the sheet so the pieces are wedges, not slices; each tipped a little out of the view.
    const a = (k + 0.3 * rng()) * Math.PI / crackCount + rng() * 0.4;
    const m = xc.clone().multiplyScalar(Math.cos(a)).addScaledVector(yc, Math.sin(a)).addScaledVector(zc, (rng() - 0.5) * 0.8).normalize();
    return { m, o: (rng() - 0.5) * 0.5 * R };
  });
  const keyOf = (p: THREE.Vector3) => cracks.reduce((key, c, k) => key | (p.dot(c.m) > c.o ? 1 << k : 0), 0);
  const pieceOf = (dir: THREE.Vector3) => keyOf(dir.clone().multiplyScalar(surface(dir)));
  // Each piece: where its middle is, then a drift outward from the moon's middle and a small turn.
  const sums = new Map<number, { s: THREE.Vector3; count: number }>();
  for (let i = 0; i < 3000; i++) {
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    if (dir.lengthSq() > 1 || dir.lengthSq() < 0.01) continue;
    dir.normalize();
    const p = dir.clone().multiplyScalar(surface(dir));
    const key = keyOf(p);
    const acc = sums.get(key) ?? { s: new THREE.Vector3(), count: 0 };
    acc.s.add(p); acc.count++;
    sums.set(key, acc);
  }
  const gap = n(ctx, 'brokenGap', 0.26, 0, 0.5) * R, twist = n(ctx, 'brokenTwist', 0.22, 0, 0.5);
  const pieces = new Map<number, Piece>();
  for (const [key, { s, count }] of [...sums.entries()].sort((a, b) => a[0] - b[0])) {
    const pivot = s.clone().multiplyScalar(1 / count).multiplyScalar(0.6);
    const out = pivot.lengthSq() > 1e-6 ? pivot.clone().normalize() : new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    const turnAxis = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    pieces.set(key, {
      pivot, drift: out.multiplyScalar(gap * (0.7 + 0.6 * rng())),
      turn: new THREE.Quaternion().setFromAxisAngle(turnAxis, (rng() - 0.5) * 2 * twist),
    });
  }

  // The piercing slabs: long and thin, a volley driven through from one seeded direction across the sheet, each
  // knocked off it by its own odd angle and passing through a different part of the rock, in its own depth so none
  // touches another; each stands out well on both sides, longer on one, and stops inside the card.
  const count = Math.round(n(ctx, 'piercers', 4, 2, 6));
  const heading = THREE.MathUtils.degToRad(n(ctx, 'pierceHeading', 18, -90, 90)) + (rng() - 0.5) * 0.3;
  const odd = n(ctx, 'pierceAngle', 0.32, 0, 0.8);
  const lanes = Array.from({ length: count }, (_, k) => ((k + 0.5) / count - 0.5) * 1.5 * R);
  const layers = Array.from({ length: count }, (_, k) => ((k + 0.5) / count - 0.5) * 0.8 * R);
  for (let i = layers.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [layers[i], layers[j]] = [layers[j], layers[i]]; }
  const piercers: Slab[] = [];
  const segs: [THREE.Vector3, THREE.Vector3, number][] = [];
  const reach = n(ctx, 'pierceReach', 1, 0.3, 2.5);
  const inCard = (p: THREE.Vector3) => { const q = pageOf(view, p); return q.x > CARD.x0 + 6 && q.x < CARD.x1 - 6 && q.y > CARD.y0 + 6 && q.y < n(ctx, 'debrisFloor', 176, 140, 240); };
  // A slab that would touch one already driven is tried again, a few times, at a new angle and depth.
  for (let k = 0, tries = 0; k < count && tries < count * 8; tries++) {
    const a = heading + (rng() < 0.5 ? -1 : 1) * odd * (0.3 + 0.7 * rng());
    const tip = (rng() - 0.5) * 0.7;
    const d = xc.clone().multiplyScalar(Math.cos(a)).addScaledVector(yc, Math.sin(a)).multiplyScalar(Math.cos(tip)).addScaledVector(zc, Math.sin(tip)).normalize();
    const across = zc.clone().cross(d).normalize();
    const mid = centre.clone().addScaledVector(across, lanes[k] + (rng() - 0.5) * 0.15 * R).addScaledVector(zc, layers[k] + (tries > k ? (rng() - 0.5) * 0.3 * R : 0));
    const off = mid.clone().sub(centre);
    const inside = Math.sqrt(Math.max(0.04 * R * R, R * R - (off.lengthSq() - off.dot(d) ** 2)));
    let near = inside + R * reach * (0.6 + 0.5 * rng()), far = inside + R * reach * (0.9 + 0.8 * rng());
    if (rng() < 0.5) [near, far] = [far, near];
    // Shortened from either end until it stops inside the card.
    while (near > inside + 0.3 * R && !inCard(mid.clone().addScaledVector(d, -near))) near -= 0.05 * R;
    while (far > inside + 0.3 * R && !inCard(mid.clone().addScaledVector(d, far))) far -= 0.05 * R;
    const w = R * (0.09 + 0.07 * rng()), t = w * (0.4 + 0.2 * rng());
    const a0 = mid.clone().addScaledVector(d, -near), a1 = mid.clone().addScaledVector(d, far);
    if (segs.some(([b0, b1, wb]) => segmentGap(a0, a1, b0, b1) < (w + wb) * 0.75)) continue;
    segs.push([a0, a1, w]);
    k++;
    // Length along local x, as the deck's slabs lie, rolled a little on its own length.
    const roll = (rng() - 0.5) * 0.9;
    const y = across.clone().multiplyScalar(Math.cos(roll)).addScaledVector(zc.clone().addScaledVector(d, -zc.dot(d)).normalize(), Math.sin(roll)).normalize();
    const z = d.clone().cross(y).normalize();
    piercers.push(placed(a0.clone().lerp(a1, 0.5), d, y, z, near + far, w, t, 400 + piercers.length));
  }

  const light = xc.clone().multiplyScalar(n(ctx, 'sunSide', -0.85, -1.5, 1.5)).addScaledVector(yc, 0.3).addScaledVector(zc, -n(ctx, 'sunBehind', 0, -0.5, 1.2)).normalize();

  // Things floating round it: small blocks and plates, sparse, clear of the slabs and of each other, kept in the sky.
  const debris: Slab[] = [];
  const want = Math.round(n(ctx, 'debris', 14, 0, 40));
  const spread = n(ctx, 'debrisSpread', 2.4, 1.4, 4);
  for (let tries = 0; debris.length < want && tries < 3000; tries++) {
    const a = rng() * Math.PI * 2, rho = R * (1.3 + (spread - 1.3) * rng() ** 0.8), dz = (rng() - 0.5) * 0.8 * R;
    const size = R * (0.07 + 0.11 * rng() ** 2);
    const shape = [rng(), rng(), rng()];
    const e = [rng(), rng(), rng()];
    const at = centre.clone().addScaledVector(xc, Math.cos(a) * rho).addScaledVector(yc, Math.sin(a) * rho).addScaledVector(zc, dz);
    if (!inCard(at)) continue;
    if (segs.some(([b0, b1, wb]) => segmentGap(at, at, b0, b1) < wb + size * 1.6)) continue;
    if (debris.some(o => at.distanceTo(new THREE.Vector3(o.x, o.y, o.z)) < (Math.max(o.w, o.h, o.d) + size) * 1.4)) continue;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0] * Math.PI, e[1] * Math.PI, e[2] * Math.PI));
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q), y = new THREE.Vector3(0, 1, 0).applyQuaternion(q), z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // Mostly blocks, a few long plates.
    const plate = shape[0] < 0.3;
    debris.push(placed(at, x, y, z, size * (plate ? 2.6 : 1 + shape[1]), size * (plate ? 0.25 : 0.6 + 0.6 * shape[2]), size * (0.7 + 0.5 * shape[1]), 500 + debris.length));
  }
  for (const sl of [...piercers, ...debris]) sl.tone = 0.6 + 0.4 * rng();

  // Field lines square to the first slab, their poles on the limb so they never ring a point; dark and pale ground as on any moon.
  const first = piercers.length ? new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(piercers[0].rx, piercers[0].ry, piercers[0].rz, 'XYZ')) : yc.clone();
  const inPlane = first.clone().addScaledVector(zc, -first.dot(zc)).normalize();
  const axis = inPlane.clone();
  const b1 = zc.clone().addScaledVector(axis, -zc.dot(axis)).normalize();
  const b2 = b1.clone().cross(axis).normalize();
  const grain = Array.from({ length: 3 }, () => ({ dir: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), f: 3 + 4 * rng(), ph: rng() * Math.PI * 2 }));
  const ground = (dir: THREE.Vector3) => grain.reduce((acc, g) => acc + Math.sin(g.f * dir.dot(g.dir) + g.ph), 0) / 3;
  return { centre, radius: R, surface, cracks, pieces, pieceOf, axis, b1, b2, piercers, debris, light, toEye: zc, ground };
}

/** Where a point of the rock in direction `dir` (a hair proud of it) has gone, with its piece. */
export function brokenPoint(b: Broken, dir: THREE.Vector3, proud = 0.004, key = b.pieceOf(dir)): THREE.Vector3 {
  const piece = b.pieces.get(key);
  const p = dir.clone().multiplyScalar(b.surface(dir) * (1 + proud));
  if (!piece) return b.centre.clone().add(p);
  return b.centre.clone().add(p.sub(piece.pivot).applyQuaternion(piece.turn).add(piece.pivot).add(piece.drift));
}

/** The rock's outward normal at `dir`, turned with its piece. */
export function brokenNormal(b: Broken, dir: THREE.Vector3, key = b.pieceOf(dir)): THREE.Vector3 {
  const piece = b.pieces.get(key);
  return piece ? dir.clone().applyQuaternion(piece.turn) : dir.clone();
}

/** Each piece's shell as a mesh, for the depth pass and the sky's knockout. */
export function brokenMeshes(b: Broken): THREE.BufferGeometry[] {
  const sphere = new THREE.SphereGeometry(1, 128, 84).toNonIndexed();
  const pos = sphere.getAttribute('position');
  const byKey = new Map<number, number[]>();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < pos.count / 3; t++) {
    for (let j = 0; j < 3; j++) v[j].fromBufferAttribute(pos, t * 3 + j).normalize();
    const key = b.pieceOf(v[0].clone().add(v[1]).add(v[2]).normalize());
    const list = byKey.get(key) ?? [];
    for (let j = 0; j < 3; j++) { const p = brokenPoint(b, v[j], 0, key); list.push(p.x, p.y, p.z); }
    byKey.set(key, list);
  }
  sphere.dispose();
  return [...byKey.values()].map(list => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    g.computeBoundingSphere();
    return g;
  });
}

/** Only the triangles of some meshes that face the eye: a broken piece's near face, without the shell behind it. */
export function frontOf(geos: THREE.BufferGeometry[], eye: THREE.Vector3): THREE.BufferGeometry[] {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  return geos.map(g => {
    const pos = g.getAttribute('position');
    const keep: number[] = [];
    for (let t = 0; t < pos.count / 3; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      if (eye.clone().sub(a).dot(normal) > 0) keep.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
    return out;
  });
}
