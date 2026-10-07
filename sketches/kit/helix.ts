import * as THREE from 'three';
import type { SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../src/projection.ts';
import { clamp, n } from './params.ts';
import { POSTER_HALF_H, POSTER_HALF_W, POSTER_MM_PER_UNIT, SLAB_MIN_PITCH, densityPitch } from './slabs.ts';
import type { Ink } from './types.ts';

/**
 * The twin helix: two seeded strands of one membrane, each a ribbon wound around a vertical axis,
 * with lamination, ribs and pulses drawn along it. The strand lives in its own space (axis up +y);
 * callers place it by editing the strand's x/y/z, ends and radius, or by a matrix on the strokes.
 */
export type Strand = {
  id: 'a' | 'b'; theta0: number; turns: number; hand: 1 | -1; radius: number; depth: number;
  width: number; twist: number; phase: number; y0: number; y1: number; swell: number; centre: number;
  x: number; y: number; z: number;
};

/** A helix stroke: strand `a` and `b` draw into their own groups. */
export type HelixStroke = { ink: Ink; group: 'strand-a' | 'strand-b'; points: THREE.Vector3[] };

/** The cathedral tower's height range, in world units: strands scatter their ends over it, and the breach sits within it. */
export const TOWER_BOT = -10.9, TOWER_TOP = 10.6;

export type Collapse = { centre: number; half: number; intensity: number };

/** Where the breach sits in the tower's height and how hard it is (seeded, from `collapse`, `levels` and `collapseHeight`). */
export function collapseBand(ctx: SketchContext): Collapse {
  const rng = ctx.random('tower-collapse-band');
  const intensity = n(ctx, 'collapse', 0.6, 0, 1);
  const levels = Math.round(n(ctx, 'levels', 17, 15, 21));
  const step = (TOWER_TOP - TOWER_BOT) / (levels - 1);
  const frac = clamp(0.2 + 0.56 * n(ctx, 'collapseHeight', 0.5, 0, 1) + (rng() - 0.5) * 0.2, 0.14, 0.82);
  return { centre: TOWER_BOT + (TOWER_TOP - TOWER_BOT) * frac, half: step * (0.9 + 2.5 * intensity), intensity };
}

/**
 * What a structure tells the helix about itself: the height `centre` and strength `intensity` (0..1)
 * of its breach, where the strands swell and where lamination crowds, and the `bot`..`top` extent
 * their ends are scattered over.
 */
export interface HelixFrame { centre: number; intensity: number; bot: number; top: number }

/** The default frame: the tower's own breach band and height range. */
export function towerFrame(ctx: SketchContext): HelixFrame {
  const band = collapseBand(ctx);
  return { centre: band.centre, intensity: band.intensity, bot: TOWER_BOT, top: TOWER_TOP };
}

/** Two seeded strands of one helix: shared turns and handedness, offset phase, staggered ends. */
export function helixStrands(ctx: SketchContext, frame: HelixFrame = towerFrame(ctx)): Strand[] {
  const rng = ctx.random('twin-helix');
  const hand: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const turns = Math.max(0.6, n(ctx, 'helixTurns', 1.6, 0.6, 3.4) + (rng() - 0.5) * 0.5);
  const theta0 = rng() * Math.PI * 2;
  const offset = Math.PI * (0.55 + 0.9 * n(ctx, 'strandOffset', 0.5, 0, 1)) + (rng() - 0.5) * 0.4 * Math.PI;
  const radius = n(ctx, 'helixRadius', 2.7, 1.6, 4.2);
  const width = n(ctx, 'shellWidth', 1.4, 0.4, 2.4);
  const twist = n(ctx, 'shellTwist', 0.62, 0, 1);
  const x = n(ctx, 'worldX', 0, -1.5, 1.5) + (n(ctx, 'focusX', 0.5, 0, 1) - 0.5) * 2.4;
  const y = n(ctx, 'worldY', 0, -1.5, 1.5) + (n(ctx, 'focusY', 0.5, 0, 1) - 0.5) * 2.4;
  const z = n(ctx, 'worldZ', 0, -2, 2);
  const swell = 0.35 + 1.1 * frame.intensity;
  const ends = () => [frame.bot - 0.6 + rng() * 1.8, frame.top + 0.3 - rng() * 1.8];
  const [a0, a1] = ends(), [b0, b1] = ends();
  return [
    { id: 'a', theta0, turns, hand, radius, depth: 0.74, width, twist, phase: rng() * Math.PI * 2,
      y0: a0, y1: a1, swell, centre: frame.centre, x, y, z },
    { id: 'b', theta0: theta0 + offset, turns, hand, radius: radius * (0.92 + rng() * 0.1), depth: 0.74,
      width: width * (0.88 + rng() * 0.14), twist, phase: rng() * Math.PI * 2,
      y0: b0, y1: b1, swell: swell * (0.7 + rng() * 0.4), centre: frame.centre, x, y, z },
  ];
}

/**
 * Where a strand's surface point lies: `t` runs along the strand (0..1), `v` across its width (-1..1).
 */
export function strandPoint(s: Strand, t: number, v: number): THREE.Vector3 {
  const yy = s.y0 + t * (s.y1 - s.y0);
  const th = s.theta0 + s.hand * 2 * Math.PI * s.turns * t;
  const pressure = Math.sin(Math.PI * t) ** 2;
  // The living strands swell outward where the stack has failed.
  const swell = s.swell * Math.exp(-(((yy - s.centre) / 2.4) ** 2));
  const r = s.radius * (1 + 0.14 * Math.sin(2 * Math.PI * 1.7 * t + s.phase)) + swell
    + 0.15 * Math.sin(9 * th + s.phase) * pressure;
  const radial = new THREE.Vector3(Math.cos(th), 0, Math.sin(th) * s.depth);
  const twist = s.twist <= 0.62 ? s.twist : 0.62 + (s.twist - 0.62) * 1.8;
  const roll = twist * (0.95 * Math.sin(2 * Math.PI * 2.3 * t + s.phase) + 0.45 * Math.cos(2 * Math.PI * 4.1 * t + s.phase * 0.5));
  const taper = 0.16 + 0.93 * Math.sin(Math.PI * t) ** 0.55;
  const width = s.width * taper * (0.86 + 0.17 * Math.sin(2 * Math.PI * 5.5 * t + s.phase));
  // Width runs across the strand (radial × tangent), rolled toward the radial by the twist.
  const speed = s.hand * 2 * Math.PI * s.turns * r;
  const tangent = new THREE.Vector3(-Math.sin(th) * speed, s.y1 - s.y0, Math.cos(th) * s.depth * speed).normalize();
  const across = new THREE.Vector3().crossVectors(radial, tangent).normalize();
  if (across.y < 0) across.negate();
  const dir = across.multiplyScalar(Math.cos(roll)).addScaledVector(radial, Math.sin(roll));
  return new THREE.Vector3(s.x, s.y + yy + 0.3 * Math.sin(2 * th + s.phase * 0.3) * pressure, s.z + 0.25)
    .addScaledVector(radial, r + 0.13 * (1 - v * v))
    .addScaledVector(dir, v * width);
}

function trace(ink: Ink, group: HelixStroke['group'], count: number, fn: (t: number) => THREE.Vector3): HelixStroke {
  return { ink, group, points: Array.from({ length: count + 1 }, (_, i) => fn(i / count)) };
}

const BARS = 16;
/** Closest two lamination lines may sit on the sheet, in millimetres. */
const MIN_SPACING_MM = 0.55;

export function strandStrokes(s: Strand, density: number, interruption: number, ctx: SketchContext, view: THREE.Camera): HelixStroke[] {
  const out: HelixStroke[] = [];
  const group: HelixStroke['group'] = s.id === 'a' ? 'strand-a' : 'strand-b';
  const rng = ctx.random(`lamellar-${s.id}`);
  const screen = (p: THREE.Vector3) => {
    const q = p.clone().project(view);
    return { x: q.x * POSTER_HALF_W * POSTER_MM_PER_UNIT, y: q.y * POSTER_HALF_H * POSTER_MM_PER_UNIT };
  };
  const at = (t: number, v: number) => screen(strandPoint(s, t, v));
  for (const v of [-1, 1]) out.push(trace('vermilion', group, 480, t => strandPoint(s, t, v)));
  const gates = Array.from({ length: BARS }, (_, bar) => bar === 0 || bar === BARS - 1 || rng() > interruption * 0.73);
  const pitch = Math.max(SLAB_MIN_PITCH, densityPitch(density, 0.09, 0.034, 0.032));
  const contours = Math.max(6, Math.round(2 * s.width * 0.95 / pitch));
  // Screen-space lamination spacing per bar: tapers and edge-on folds thin the course.
  const stride = (start: number, end: number) => {
    let spacing = Infinity;
    for (let i = 0; i <= 6; i++) {
      const t = start + (end - start) * i / 6;
      const a = at(t, -1), b = at(t, 1);
      const t0 = at(Math.max(0, t - 0.002), 0), t1 = at(Math.min(1, t + 0.002), 0);
      const tx = t1.x - t0.x, ty = t1.y - t0.y, tl = Math.hypot(tx, ty) || 1;
      const perp = Math.abs(((b.x - a.x) * ty - (b.y - a.y) * tx) / tl);
      spacing = Math.min(spacing, perp * (1.95 / contours) / 2);
    }
    let k = 1;
    while (spacing * k < MIN_SPACING_MM && k < 64) k *= 2;
    return k;
  };
  for (let bar = 0; bar < BARS; bar++) {
    const start = bar / BARS + 0.0015, end = (bar + 1) / BARS - 0.0015;
    // Laminations crowd toward the breach and open out toward the strand ends.
    const mid = s.y0 + (start + end) / 2 * (s.y1 - s.y0);
    const loud = Math.exp(-(((mid - s.centre) / 5.5) ** 2));
    const open = !gates[bar] || (loud < 0.25 && bar % 3 === 1);
    // Strides per sub-piece; nested powers of two keep surviving contours continuous.
    const SUB = 6;
    const strides = Array.from({ length: SUB }, (_, q) =>
      stride(start + (end - start) * q / SUB, start + (end - start) * (q + 1) / SUB));
    for (let j = 0; j < contours; j++) {
      if (bar % 2 === 1 && j % 17 === 0) continue;
      const v = -0.975 + 1.95 * (j + 0.5) / contours;
      const ink: Ink = j % 13 === 0 ? 'vermilion'
        : s.id === 'a' ? (j % 4 === 0 ? 'violet' : 'ultramarine') : 'violet';
      let q = 0;
      while (q < SUB) {
        const keep = (k: number) => j % k === 0 && (!open || j % (6 * k) === 0);
        if (!keep(strides[q])) { q++; continue; }
        let r = q;
        while (r + 1 < SUB && keep(strides[r + 1])) r++;
        const a0 = start + (end - start) * q / SUB, a1 = start + (end - start) * (r + 1) / SUB;
        out.push(trace(ink, group, 5 * (r - q + 1), t => strandPoint(s, a0 + (a1 - a0) * t, v)));
        q = r + 1;
      }
    }
  }
  if (s.id === 'a') out.push(trace('acid', group, 480, t => strandPoint(s, t, 0)));
  const ribs = Math.round(densityPitch(density, 40, 120, 170));
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= ribs; i++) {
    const u = i / ribs;
    const group8 = Math.floor(i / 8);
    if (rng() < interruption * (group8 % 2 ? 1.0 : 0.42)) continue;
    const here = at(u, 0);
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < 1.1) continue;
    last = here;
    const ink: Ink = s.id === 'a'
      ? (i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine')
      : (i % 8 === 0 ? 'vermilion' : i % 3 === 0 ? 'ultramarine' : 'violet');
    out.push(trace(ink, group, 14, t => strandPoint(s, u, -0.96 + t * 1.92)));
  }
  if (s.id === 'a') {
    // Sixty-four offset pulses along the leading edge: 8 bars of 8 with built-in rests.
    for (let i = 0; i < 64; i++) {
      const bar = Math.floor(i / 8), beat = i % 8;
      if ((beat === 2 || beat === 5) && bar % 2 === 0) continue;
      if (rng() < interruption * 0.38) continue;
      const u = 0.04 + 0.92 * (i + 0.5) / 64;
      out.push(trace(bar % 2 ? 'violet' : 'acid', group, 5, t => strandPoint(s, u, -1.12 - 0.15 * t)));
    }
  }
  return out;
}

/**
 * The matrix that stands a strand-space helix (axis up +y) along a ray: it lies on the ray at angle
 * `angle` (radians, counter-clockwise from +x in the xy plane) and starts at `from`.
 */
export function alongRay(from: THREE.Vector3, angle: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(from.x, from.y, from.z)
    .multiply(new THREE.Matrix4().makeRotationZ(angle - Math.PI / 2));
}

export interface AlongOptions {
  /** Strand radius round the curve, world units; the second strand sits `spread` wider. */
  radius: number;
  /** Ribbon width; the second strand is `narrow` slimmer. */
  width: number;
  /** Curve length per turn of the strands. */
  pitch: number;
  spread?: number;
  narrow?: number;
  /** Ribbon twist (the helix's shellTwist). */
  twist?: number;
  density?: number;
  interruption?: number;
}

/**
 * The twin helix laid along any curve: the two seeded strands are built in their own upright space
 * (starting at the curve's first point) and bent onto the curve, height along the strand becoming
 * arc length, the sideways offsets riding the curve's frame. Returns the strokes and the strands'
 * surfaces for the depth pass.
 */
export function helixAlong(ctx: SketchContext, view: THREE.Camera, curve: THREE.CatmullRomCurve3, o: AlongOptions): { strokes: HelixStroke[]; meshes: THREE.BufferGeometry[] } {
  const start = curve.getPointAt(0);
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: o.twist ?? 0.35 } });
  const strands: Strand[] = template.map((st, i) => ({
    ...st, x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: o.radius + (o.spread ?? 0.15) * i, depth: 1, width: o.width - (o.narrow ?? 0.1) * i,
    swell: 0, centre: -1e3, turns: length / o.pitch,
  }));
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - start.y) / length, 0, 1);
    const k = Math.min(400, Math.round(u * 400));
    return curve.getPointAt(u).addScaledVector(frames.normals[k], p.x - start.x).addScaledVector(frames.binormals[k], p.z - start.z - 0.25);
  };
  const strokes: HelixStroke[] = [];
  for (const st of strands) for (const h of strandStrokes(st, o.density ?? 0.35, o.interruption ?? 0.3, ctx, view)) strokes.push({ ...h, points: h.points.map(bend) });
  const meshes = strands.map(st => buildSurfaceMesh((u, v) => bend(strandPoint(st, u, 2 * v - 1)), {}, 320, 8));
  return { strokes, meshes };
}
