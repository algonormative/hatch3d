import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../src/projection.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { TABLOID_PAGE, TALL_ART, posterArtTransform } from '../phase-garden/poster.ts';
import { densityPitch, slabGeometry, slabMatrix, slabStrokes, solid, type Role, type Slab } from '../kit/slabs.ts';
import { clipToRect } from '../kit/page.ts';
import { hatchedBar, type Bar } from '../kit/fills.ts';
import type { Ink } from '../kit/types.ts';
import { clamp, n, smooth } from '../kit/params.ts';
import { barPattern, restPattern } from '../kit/rhythm.ts';
import { HEMS, BUTTON, COLLAR, Tube, TIER, front, lapel, opening, perpendicular, pinstripeTube, ribbonTube, runs, silhouettes, stride, suitFront, tierOf, toneField,
  type ClothStroke, type ToneEnv, type ViewEnv } from '../kit/mannequin/index.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../kit/strokes.ts';
import { clearBands, knockOut, planSlogans, sloganSettings, type SloganSurface } from '../kit/lettering.ts';

/**
 * Breach Cathedral: Agent. The living force from Breach Cathedral has put on the system's suit:
 * a seated figure wound from the helix membrane, enthroned on the slab architecture, its head the
 * twin helix unwinding. Value is lit from the head, so the force shows itself as light.
 */
export type Group = 'system' | 'throne' | 'rays' | 'figure' | 'force' | 'contour' | 'slogan' | 'title';
type Stroke = ClothStroke;

const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const GROUPS: Group[] = ['system', 'throne', 'rays', 'figure', 'force', 'contour', 'slogan', 'title'];
// Depth pixels: two per page millimetre, as in the Tower.
const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const ART = { x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width, y0: TALL_ART.y, y1: TALL_ART.y + TALL_ART.height };
/** Clip a page polyline to the art window. */
const clipArt = (points: Point[]): Point[][] => clipToRect(points, ART);
const HALF_H = 13.0;
const HALF_W = HALF_H * TABLOID_PAGE.width / TABLOID_PAGE.height;
const MM_PER_UNIT = TABLOID_PAGE.height / (2 * HALF_H);
const TAU = Math.PI * 2;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function camera(ctx: SketchContext): THREE.OrthographicCamera {
  // From the right and below: the agent turns to the viewer's upper left and towers over the eye.
  const turn = n(ctx, 'turn', 26, -40, 40) * Math.PI / 180;
  const tilt = n(ctx, 'tilt', -7, -16, 24) * Math.PI / 180;
  const view = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 80);
  const target = V(0, 0.2, 0.6);
  view.up.set(0, 1, 0);
  view.position.copy(target).add(V(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt)).multiplyScalar(24));
  view.lookAt(target);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

// ---------------------------------------------------------------- the figure

/** Where the head looks: `face` is the gaze, `axis` the crown, both world unit vectors. */
export type Gaze = { face: THREE.Vector3; axis: THREE.Vector3; side: THREE.Vector3 };
export type Legs = 'apart' | 'together' | 'crossed';
export type Pose = { tubes: Tube[]; slabs: Slab[]; head: THREE.Vector3; trunk: Tube; neck: THREE.Vector3; gaze: Gaze; legs: Legs };

/** The seated agent: trunk, limbs, block hands and shoes, all in world units (page ≈ 26 tall). */
function figure(ctx: SketchContext): Pose {
  const rng = ctx.random('agent-pose');
  const facets = Math.round(n(ctx, 'facets', 6, 0, 16));
  const cut = facets >= 3 ? facets : 0;
  const spread = n(ctx, 'stance', 0.5, 0, 1);
  const legRoll = rng();
  const picked = typeof ctx.params.legs === 'string' && ['apart', 'together', 'crossed'].includes(ctx.params.legs) ? ctx.params.legs as Legs | 'seed' : 'seed';
  const legs: Legs = picked !== 'seed' ? picked : legRoll < 0.4 ? 'apart' : legRoll < 0.65 ? 'together' : 'crossed';
  const crossing: 1 | -1 = rng() < 0.5 ? 1 : -1;
  // The gaze: up and toward the figure's right, which this camera puts at the viewer's upper left.
  const yaw = (n(ctx, 'gazeTurn', 48, 0, 80) + (rng() - 0.5) * 20) * Math.PI / 180;
  const pitch = (n(ctx, 'gazeLift', 24, 0, 60) + (rng() - 0.5) * 14) * Math.PI / 180;
  const level = V(-Math.sin(yaw), 0, Math.cos(yaw));
  const face = level.clone().multiplyScalar(Math.cos(pitch)).add(V(0, Math.sin(pitch), 0)).normalize();
  const axis = V(0, Math.cos(pitch), 0).addScaledVector(level, -Math.sin(pitch)).normalize();
  const gaze: Gaze = { face, axis, side: new THREE.Vector3().crossVectors(axis, face).normalize() };
  // A slight recline and a turn of the shoulders toward the gaze.
  const twist = -0.35 * Math.sin(yaw);
  const sh = (y: number) => y > 0 ? twist * y / 6 : 0;
  const spineAt = (y: number, z: number) => V(sh(y) * 0.6, y, z - 0.06 * Math.max(0, y));
  const kx = legs === 'together' ? 1.35 : 1.55 + 0.9 * spread;
  const trunk = new Tube('trunk', [spineAt(-2.7, -0.55), spineAt(-0.8, -0.72), spineAt(2.2, -0.82), spineAt(4.3, -0.86), spineAt(5.4, -0.82), spineAt(6.15, -0.76)],
    [[0, 2.2, 1.5], [0.2, 2.0, 1.36], [0.5, 2.65, 1.52], [0.74, 3.25, 1.36], [0.82, 2.7, 1.16], [0.885, 1.2, 0.95], [0.92, 0.74, 0.72], [1, 0.68, 0.66]],
    V(0, 0, 1), 1, [1.1, 0],
    (u, v) => {
      if (u > 0.9) return false; // the collar and neck belong to the shirt
      const o = front(v);
      return !(u >= BUTTON - 0.02 && u <= COLLAR + 0.04 && o < opening(u) + lapel(u));
    }, cut);
  const tubes: Tube[] = [trunk];
  const slabs: Slab[] = [];
  const block = (x: number, y: number, z: number, w: number, h: number, d: number, rx = 0, ry = 0, rz = 0, role: Role = 'stub') =>
    slabs.push({ ...solid(x, y, z, w, h, d, 40 + slabs.length, role), rx, ry, rz });
  /** A shoe: a thin sole slab under a blunt upper, turned about x so it can dangle. */
  const shoe = (x: number, y: number, z: number, ry: number, tip = 0) => {
    const c = Math.cos(tip), s = Math.sin(tip);
    block(x, y, z, 1.34, 0.72, 2.5, tip, ry, 0);
    block(x, y - 0.46 * c, z - 0.46 * s + 0.08, 1.44, 0.2, 2.72, tip, ry, 0);
  };
  for (const side of [-1, 1] as const) {
    const hip = V(side * 1.55, -2.65, -0.25);
    let knee = V(side * kx, -2.05 + 0.25 * rng(), 5.05);
    let ankle = V(side * (kx + 0.05), -8.95, 4.6 + 0.4 * rng());
    let planted = true;
    if (legs === 'crossed' && side === crossing) {
      // The crossing thigh rests over the other knee; its shin hangs outside it, the shoe off the floor.
      knee = V(-side * 0.7, -0.7, 5.25);
      ankle = V(-side * 2.75, -7.0, 6.0);
      planted = false;
    }
    tubes.push(new Tube(`thigh${side}`, [hip, hip.clone().lerp(knee, 0.5).add(V(0, 0.18, 0)), knee],
      [[0, 1.55, 1.42], [0.45, 1.4, 1.26], [1, 1.04, 1.0]], V(0, 1, 0), side === 1 ? 1 : -1, [0, 1.02], undefined, cut));
    tubes.push(new Tube(`shin${side}`, [knee.clone().add(V(0, 0.1, -0.15)), knee.clone().lerp(ankle, 0.45).add(V(0, 0, 0.25)), ankle],
      [[0, 1.02, 1.0], [0.3, 0.94, 0.96], [1, 0.62, 0.66]], V(0, 0, 1), side === 1 ? -1 : 1, [0.97, 0], undefined, cut));
    if (planted) shoe(ankle.x, -9.6, ankle.z + 0.45, side * 0.08);
    else shoe(ankle.x, ankle.y - 0.55, ankle.z + 0.55, side * 0.15, 0.55);
    const shoulder = V(side * 2.95 + sh(4) * 0.6, 3.95, -0.92), elbow = V(side * 4.12, 0.35, -0.98);
    const wrist = V(side * 4.42, -0.12, 3.05);
    tubes.push(new Tube(`upper${side}`, [shoulder, shoulder.clone().lerp(elbow, 0.5).add(V(side * 0.14, 0, 0)), elbow],
      [[0, 1.08, 1.0], [0.5, 0.94, 0.9], [1, 0.82, 0.8]], V(0, 0, 1), side === 1 ? 1 : -1, [0.95, 0.8], undefined, cut));
    tubes.push(new Tube(`fore${side}`, [elbow.clone().add(V(0, -0.1, 0.05)), elbow.clone().lerp(wrist, 0.5).add(V(0, 0.08, 0)), wrist],
      [[0, 0.8, 0.78], [0.6, 0.72, 0.68], [1, 0.62, 0.57]], V(0, 1, 0), side === 1 ? -1 : 1, [0.78, 0], undefined, cut));
    // Hands: a broad palm and four three-knuckled fingers. Resting fingers drape over the
    // armrest end; a clutching hand wraps them back under it.
    const clutch = rng() < 0.45;
    const wx = side * 4.46;
    block(wx, -0.3, 3.62, 1.42, 0.5, 1.3, 0.06, 0, 0);
    block(wx + side * 0.04, -0.12, 3.45, 1.2, 0.18, 0.9, 0.06, 0, 0);
    for (let f = 0; f < 4; f++) {
      const x = wx + side * (-0.53 + 0.355 * f);
      const reach = f === 0 || f === 3 ? 0.9 : 1;
      const droop = 0.12 * rng();
      const joints = clutch
        ? [V(x, -0.28, 4.18), V(x, -0.3, 4.62 - 0.1 * (1 - reach)), V(x, -0.95, 4.82), V(x, -1.5 - droop, 4.38)]
        : [V(x, -0.28, 4.18), V(x, -0.36, 4.68 + 0.06 * (f % 2)), V(x, -0.95 - 0.08 * (f === 1 || f === 2 ? 1 : 0), 4.82), V(x, -1.5 - droop, 4.7)];
      const width = f === 3 ? 0.27 : 0.31;
      for (let j = 0; j < 3; j++) {
        const a = joints[j], b = joints[j + 1], d = b.clone().sub(a);
        const c = a.clone().lerp(b, 0.5);
        // Local y along the segment, which lies in the y–z plane; each knuckle a touch narrower.
        block(c.x, c.y, c.z, width * (1 - 0.08 * j), d.length() + 0.06, 0.33 * (1 - 0.08 * j), Math.atan2(d.z, d.y), 0, 0);
      }
    }
    // Thumb along the inner face of the armrest.
    const tx = side * 3.82;
    block(tx, -0.6, 3.8, 0.27, 0.72, 0.3, -0.9, 0, 0);
    block(tx, -0.95, 4.28, 0.25, 0.58, 0.27, clutch ? -2.2 : -1.9, 0, 0);
  }
  const neck = trunk.centre(0.96);
  const head = neck.clone().addScaledVector(axis, 1.15).addScaledVector(face, 0.35);
  return { tubes, slabs, head, trunk, neck, gaze, legs };
}

// ---------------------------------------------------------------- light and screen

interface Env extends ToneEnv, ViewEnv {
  view: THREE.Camera;
}

// ---------------------------------------------------------------- the force

/** `from` is where along the strand it starts: the second strand joins only at the crown, to unwind. */
export type ForceStrand = { theta0: number; hand: 1 | -1; turns: number; width: number; phase: number; lift: number; from: number };

/** The head: two ribbons wound into a skull, then unwinding upward and flaring into the architecture. */
export function forceStrands(ctx: SketchContext): ForceStrand[] {
  const rng = ctx.random('agent-force');
  const hand: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const turns = n(ctx, 'headTurns', 4.2, 1, 6) + (rng() - 0.5) * 0.4;
  const theta0 = rng() * TAU;
  const width = n(ctx, 'headWidth', 0.5, 0.25, 1.4);
  return [
    { theta0, hand, turns, width, phase: rng() * TAU, lift: 1, from: 0 },
    { theta0: theta0 + Math.PI * (0.85 + 0.3 * rng()), hand, turns, width: width * (0.85 + 0.2 * rng()), phase: rng() * TAU, lift: 0.82 + 0.2 * rng(), from: 0.5 },
  ];
}

function forcePoint(s: ForceStrand, neck: THREE.Vector3, gaze: Gaze, rise: number, along: number, v: number): THREE.Vector3 {
  const t = s.from + (1 - s.from) * along;
  // Head 0..0.6 of t; the flare above it climbs `rise` units and pours out along the gaze.
  // Built in a head frame (x = side, y = crown, z = face), then turned onto the gaze.
  const headTop = 2.9;
  const above = t < 0.6 ? 0 : (t - 0.6) / 0.4;
  const y = t < 0.6 ? headTop * t / 0.6 : headTop + above * rise * s.lift;
  const hy = clamp(y / headTop, 0, 1);
  // An egg: narrow at the neck, widest just above the middle, closing in under the crown.
  const skull = 0.5 + 0.85 * Math.sin(Math.PI * Math.min(1, 0.04 + 0.92 * hy)) ** 0.75 - 0.15 * hy;
  const flare = above ** 1.6 * 2.8;
  const r = skull * (1 - 0.2 * above) + flare + 0.05 * Math.sin(7 * TAU * t + s.phase);
  const th = s.theta0 + s.hand * TAU * s.turns * t * (1 - 0.25 * above);
  const radial = V(Math.cos(th), 0, Math.sin(th) * 0.9);
  const taper = s.from > 0 && t < 0.6 ? smooth(s.from, 0.6, t) : t < 0.6 ? 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, t / 0.6 * 0.9 + 0.1)) ** 0.5 : 1 - 0.75 * above;
  // The face: where the ribbons pass in front of it they narrow, leaving an opening that looks out.
  const facing = Math.sin(th);
  const opening = t < 0.6 ? smooth(0.1, 0.75, facing) * Math.sin(Math.PI * clamp((hy - 0.12) / 0.8, 0, 1)) ** 0.6 : 0;
  const width = s.width * taper * (1 - 0.85 * opening);
  const tangent = V(-Math.sin(th) * r * s.hand * TAU * s.turns, 1, Math.cos(th) * 0.9 * r * s.hand * TAU * s.turns).normalize();
  const across = new THREE.Vector3().crossVectors(radial, tangent).normalize();
  if (across.y < 0) across.negate();
  const roll = (t < 0.6 ? 0 : 0.5) * Math.sin(TAU * 1.4 * t + s.phase);
  const dir = across.multiplyScalar(Math.cos(roll)).addScaledVector(radial, Math.sin(roll));
  const local = V(0, y - 0.5, 1.6 * above ** 1.3 * rise * s.lift * 0.45).addScaledVector(radial, r).addScaledVector(dir, v * width);
  return neck.clone().addScaledVector(gaze.side, local.x).addScaledVector(gaze.axis, local.y).addScaledVector(gaze.face, local.z);
}

function ribbonStrokes(fn: (t: number, v: number) => THREE.Vector3, env: Env, rng: () => number, interruption: number, source: THREE.Vector3): Stroke[] {
  const out: Stroke[] = [];
  const along = 520;
  const trace = (ink: Ink, group: Group, count: number, f: (x: number) => THREE.Vector3) =>
    out.push({ ink, group, points: Array.from({ length: count + 1 }, (_, i) => f(i / count)) });
  for (const v of [-1, 1]) trace('vermilion', 'contour', along, t => fn(t, v));
  trace('acid', 'force', along, t => fn(t, 0));
  const N = Math.round(densityPitch(env.density, 8, 14, 18)) * 2;
  for (let j = 1; j < N; j++) {
    if (j === N / 2) continue;
    const v = -1 + 2 * j / N;
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= along; i++) {
      const t = i / along;
      const p = fn(t, v);
      pts.push(p);
      const s = stride(perpendicular(env, p, fn(Math.min(1, t + 0.002), v), fn(t, v + 2 / N)));
      const glow = env.dark(p, source.clone().sub(p).normalize());
      keep.push(j % s === 0 && (tierOf(j) === 0 || glow > TIER[tierOf(j)] - 0.1));
    }
    runs(pts, keep, j % 5 === 0 ? 'violet' : 'ultramarine', 'force', out);
  }
  const ribs = Math.round(densityPitch(env.density, 60, 130, 170));
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= ribs; i++) {
    const t = i / ribs;
    if (rng() < interruption * (Math.floor(i / 8) % 2 ? 0.9 : 0.35)) continue;
    const centre = fn(t, 0);
    if (i % 4 !== 0 && env.dark(centre, source.clone().sub(centre).normalize()) < 0.25) continue;
    const here = env.screen(centre);
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < 1.1) continue;
    last = here;
    trace(i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : 'ultramarine', 'force', 12, x => fn(t, -0.95 + 1.9 * x));
  }
  return out;
}

/** Light leaving the head: radial strokes on a plane behind the throne, dashed in a fixed 64-step rhythm. */
function rays(ctx: SketchContext, head: THREE.Vector3): Stroke[] {
  const amount = n(ctx, 'radiance', 0.5, 0, 1);
  if (amount <= 0) return [];
  const rng = ctx.random('agent-rays');
  const pattern = barPattern(rng, 0.7);
  const count = 8 * Math.round(6 + 12 * amount);
  const z = -4.3, growth = 1.13;
  const out: Stroke[] = [];
  for (let i = 0; i < count; i++) {
    const a = TAU * (i + 0.5) / count;
    const long = i % 8 === 0;
    const end = long ? 30 : 8 + 14 * amount;
    for (let k = 0, r = 2.5; r < end; k++, r *= growth) {
      if (!pattern[(k * 3 + i * 5) % 64]) continue;
      const r1 = r * (1 + (growth - 1) * 0.68);
      out.push({ ink: long ? 'vermilion' : 'acid', group: 'rays',
        points: [V(head.x + Math.cos(a) * r, head.y + Math.sin(a) * r, z), V(head.x + Math.cos(a) * r1, head.y + Math.sin(a) * r1, z)] });
    }
  }
  return out;
}

/** The gaze made visible: a cone of straight lines leaving the face toward the upper left. */
function beam(ctx: SketchContext, head: THREE.Vector3, gaze: Gaze): Stroke[] {
  const amount = n(ctx, 'beam', 0.5, 0, 1);
  if (amount <= 0) return [];
  const lines = Math.round(12 + 36 * amount);
  const spread = 0.12 + 0.2 * amount;
  const up = new THREE.Vector3().crossVectors(gaze.face, gaze.side).normalize();
  const out: Stroke[] = [];
  for (let i = 0; i < lines; i++) {
    // A sunflower disc of directions: even, deterministic, no clumps.
    const rho = Math.sqrt((i + 0.5) / lines) * spread, phi = i * 2.399963;
    const d = gaze.face.clone().addScaledVector(gaze.side, rho * Math.cos(phi)).addScaledVector(up, rho * Math.sin(phi)).normalize();
    const start = head.clone().addScaledVector(d, 1.7);
    out.push({ ink: i % 6 === 0 ? 'vermilion' : 'acid', group: 'rays', points: [start, start.clone().addScaledVector(d, 34)] });
  }
  return out;
}

// ---------------------------------------------------------------- the system

/** The throne and the cathedral behind it; near the head the structure breaks and lifts away. */
function architecture(ctx: SketchContext, head: THREE.Vector3): Slab[] {
  const rng = ctx.random('agent-system');
  const breach = n(ctx, 'breach', 0.5, 0, 1);
  const out: Slab[] = [];
  const add = (x: number, y: number, z: number, w: number, h: number, d: number, role: Role = 'stack') => {
    const s = solid(x, y, z, w, h, d, out.length, role);
    out.push(s);
    return s;
  };
  // Throne: floor plinth, seat, armrests, legs, back posts and rails.
  add(0, -10.55, 2.6, 9.8 + 0.6 * rng(), 0.62, 6.4, 'pier');
  add(0, -4.55, 0.55, 8.6, 0.85, 6.2, 'pier');
  for (const side of [-1, 1]) {
    add(side * 4.56, -1.28, 0.9, 1.0, 0.76, 6.75, 'pier');
    add(side * 4.56, -5.95, 3.75, 0.86, 8.6, 0.86, 'pier');
    add(side * 4.45, -5.95, -2.2, 0.86, 8.6, 0.86, 'pier');
    add(side * 4.42, 2.6, -2.75, 0.86, 9.0, 0.86, 'pier');
    add(side * 4.56, -3.1, 1.2, 0.5, 0.5, 4.8, 'pier');
  }
  // Back rails behind the shoulders, and a crest that the head has broken open.
  add(0, 1.9, -2.95, 9.6, 0.8, 0.7);
  add(0, 4.9, -2.95, 10.6 + 1.2 * rng(), 0.72, 0.7);
  const crest = { y: 7.45 + 0.4 * rng(), w: 13 + 1.6 * rng() };
  const gapHalf = 1.6 + 2.6 * breach;
  for (const side of [-1, 1]) {
    const inner = gapHalf, outer = crest.w / 2;
    if (outer - inner > 0.6) add(side * (inner + outer) / 2, crest.y, -2.95, outer - inner, 0.95, 0.9);
  }
  // The broken crest pieces, lifted and turned by the force.
  const shards = 2 + Math.round(3 * breach);
  for (let i = 0; i < shards; i++) {
    const w = gapHalf * 2 / shards * (0.7 + 0.25 * rng());
    const x = -gapHalf + (i + 0.5) * gapHalf * 2 / shards;
    const s = add(x * (1.15 + 0.4 * breach), crest.y + 1.1 + (2.2 + 1.5 * rng()) * breach, -2.95 + (rng() - 0.5) * 1.4, w, 0.95, 0.9, 'fallen');
    s.rz = (rng() - 0.5) * 1.2 * breach + Math.sign(x) * 0.3 * breach; s.rx = (rng() - 0.5) * 0.7 * breach; s.ry = (rng() - 0.5) * 0.9 * breach;
  }
  // Cathedral behind: cantilevered slabs from both walls, the original slab grammar, pushed back from the head.
  const levels = Math.round(n(ctx, 'levels', 12, 8, 16));
  const z0 = -7.6;
  // Walls are laid out where the camera sees them: world x from a wanted screen x at this depth.
  const turn = n(ctx, 'turn', 26, -40, 40) * Math.PI / 180;
  const wx = (sx: number, z: number) => (sx + z * Math.sin(turn)) / Math.cos(turn);
  for (let i = 0; i < levels; i++) {
    const y = -11.2 + (23.6 * (i + 0.5)) / levels + (rng() - 0.5) * 0.5;
    for (const side of [-1, 1]) {
      if (rng() < 0.22) continue;
      const w = 2.6 + 3.6 * rng();
      const z = z0 + (rng() - 0.5) * 1.2;
      const x = wx(side * (8.7 - w / 2 + 0.6 * rng()), z);
      const s = add(x, y, z, w, 0.55 + 0.6 * rng(), 1.1 + 0.6 * rng());
      const away = V(s.x - head.x, s.y - head.y, 0);
      const d = away.length();
      const push = breach * 3.2 * Math.exp(-((d / 6.5) ** 2));
      if (push > 0.25) {
        away.normalize();
        s.x += away.x * push; s.y += away.y * push; s.z += 0.6 * push;
        s.rz = -side * 0.35 * push * (rng() < 0.2 ? -1 : 1); s.rx = (rng() - 0.5) * 0.4 * push;
        s.role = 'fallen';
      }
    }
  }
  for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
    if (rng() < 0.3) continue;
    add(wx(side * (7.4 + 0.4 * rng()), z0 - 1.1), -8 + 7.6 * k + rng(), z0 - 1.1, 0.7, 4.4 + 2 * rng(), 0.9, 'pier');
  }
  // Fragments rising off the breach around the head.
  const drng = ctx.random('agent-debris');
  const pieces = Math.round((6 + 34 * breach) * n(ctx, 'debris', 0.5, 0, 1) * 2);
  for (let i = 0; i < pieces; i++) {
    const a = Math.PI * (0.04 + 0.92 * drng());
    const r = 3.2 + 6.5 * drng() ** 0.8;
    const size = (1 - 0.5 * (r - 3) / 6.5) * (0.35 + 0.65 * drng());
    const x = head.x + Math.cos(a) * r, y = head.y + 0.6 + Math.sin(a) * r * 0.85;
    if (y > 10.6 || Math.abs(x) > 7.2 || (Math.abs(x - head.x) < 3.4 && y < head.y + 1)) continue;
    const s = add(x, y, -2.2 + 3 * drng(), 0.25 + 0.8 * size, 0.1 + 0.25 * size, 0.2 + 0.4 * size, 'debris');
    s.rx = (drng() - 0.5) * 2.4; s.ry = (drng() - 0.5) * 2.4; s.rz = (drng() - 0.5) * Math.PI;
  }
  // Tone: the structure is lit by the head, so it goes quiet near the force and loud at the base.
  for (const s of out) {
    const d = Math.hypot(s.x - head.x, s.y - head.y, (s.z - head.z) * 0.5);
    s.tone = s.role === 'debris' ? 0.3 + 0.4 * smooth(3, 10, d) : 0.16 + 1.1 * smooth(3.2, 15, d);
  }
  return out;
}

// ---------------------------------------------------------------- assembly

/**
 * The censor: flat bars laid over the head on the sheet itself, no perspective, filled with
 * hatching instead of ink. Whatever the bars cover is knocked out; light still leaks round them.
 * Returns the bars as page-millimetre quads plus their hatch and outline paths.
 */
function censorBars(ctx: SketchContext, pose: Pose, screenMm: (p: THREE.Vector3) => Point): { quads: Point[][]; paths: Point[][] } {
  const empty = { quads: [], paths: [] };
  if (ctx.params.censor === false) return empty;
  const rng = ctx.random('agent-censor');
  const centre = screenMm(pose.neck.clone().addScaledVector(pose.gaze.axis, 1.35).addScaledVector(pose.gaze.face, 0.35));
  const tilt = (rng() < 0.5 ? -1 : 1) * (0.04 + 0.3 * n(ctx, 'censorAngle', 0.4, 0, 1) * (0.4 + rng()));
  const length = 64 + 22 * rng(), height = 12 + 5 * rng();
  const bars: Bar[] = [{ cx: centre.x, cy: centre.y, l: length, h: height }];
  if (rng() < 0.55) {
    // A second, thinner strip, as if the first did not quite cover it.
    const side = rng() < 0.5 ? -1 : 1, slide = (rng() - 0.5) * 0.4 * length;
    const h2 = height * (0.35 + 0.2 * rng());
    bars.push({ cx: centre.x + slide * Math.cos(tilt) - side * (height / 2 + h2 / 2 + 2.2) * Math.sin(tilt),
      cy: centre.y + slide * Math.sin(tilt) + side * (height / 2 + h2 / 2 + 2.2) * Math.cos(tilt), l: length * (0.45 + 0.25 * rng()), h: h2 });
  }
  const quads: Point[][] = [], paths: Point[][] = [];
  for (const b of bars) {
    // Two hatch families at ±60° to the bar, inside the inner rule: dense enough to read as a fill.
    const bar = hatchedBar(b, tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]]);
    quads.push(bar.quad);
    paths.push(...bar.paths);
  }
  return { quads, paths };
}

export function drawAgent(ctx: SketchContext): Part[] {
  const view = camera(ctx);
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const pose = figure(ctx);
  const density = n(ctx, 'hatchDensity', 0.55, 0, 1);
  const rawInterruption = n(ctx, 'interruption', 0.32, 0, 1);
  const env: Env = {
    view, forward, density,
    screen: p => { const q = p.clone().project(view); return { x: q.x * HALF_W * MM_PER_UNIT, y: q.y * HALF_H * MM_PER_UNIT }; },
    dark: toneField(ctx, pose.head, { noiseKey: 'agent-impression' }),
  };
  const system = architecture(ctx, pose.head);
  const solids = [...system, ...pose.slabs];
  const beatRng = ctx.random('agent-rests');
  const beats = restPattern(beatRng, rawInterruption);
  const strokes: Stroke[] = solids.flatMap((s, owner) => {
    const group: Group = owner < system.length && s.role !== 'stub' ? (s.z < -5 ? 'system' : 'throne') : 'figure';
    return slabStrokes(s, density, beats[(s.beat * 7) % 64]).map(stroke => ({ ...stroke, group, owner }));
  });
  const band = n(ctx, 'band', 1.25, 0.7, 2.2);
  const cloth = ctx.params.cloth === 'ribbon' ? 'ribbon' : 'pinstripe';
  pose.tubes.forEach((t, i) => {
    const restRng = ctx.random(`agent-band-${t.id}`);
    const rest = new Map<number, boolean>();
    const rests = (k: number) => {
      if (!rest.has(k)) rest.set(k, restRng() < rawInterruption * (Math.abs(k + i) % 8 < 4 ? 0.9 : 0.4));
      return rest.get(k)!;
    };
    if (cloth === 'ribbon') strokes.push(...ribbonTube(t, env, { band: band * (t.id === 'trunk' ? 1.15 : 1), gap: 0.13, rests }));
    else strokes.push(...pinstripeTube(t, env, HEMS[t.id.replace(/-?1$/, '')] ?? { seams: [0, 0.5], hems: [] }));
    strokes.push(...silhouettes(t, env));
  });
  strokes.push(...suitFront(pose.trunk, env));
  const strands = forceStrands(ctx);
  // The unwinding stops short of the art edge, so the force never reads as cropped.
  const room = (10.4 - pose.neck.y) / Math.max(0.5, pose.gaze.axis.y) - 2.4;
  const rise = Math.max(0.6, (0.35 + 0.65 * n(ctx, 'rise', 0.5, 0, 1)) * room);
  const forceFns = strands.map(s => (t: number, v: number) => forcePoint(s, pose.neck, pose.gaze, rise, t, v));
  const forceRng = ctx.random('agent-force-ribs');
  for (const fn of forceFns) strokes.push(...ribbonStrokes(fn, env, forceRng, rawInterruption, pose.head));
  strokes.push(...rays(ctx, pose.head), ...beam(ctx, pose.head, pose.gaze));

  const geometries = solids.map(slabGeometry);
  for (const t of pose.tubes) geometries.push(t.mesh());
  for (const fn of forceFns) geometries.push(buildSurfaceMesh((u, v) => fn(u, 2 * v - 1), {}, 520, 10));
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const surfaces: SloganSurface[] = [];
    system.forEach((s, id) => {
      if ((s.role === 'stack' || s.role === 'pier') && s.w > 1.2 && s.h > 0.3) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const pageMmPerPx = MM_Y * posterArtTransform(ctx, TABLOID_PAGE, TALL_ART).scale;
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: pageMmPerPx,
      art: { x0: ART.x0 / MM_X, x1: ART.x1 / MM_X, y0: ART.y0 / MM_Y, y1: ART.y1 / MM_Y },
    });
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', points });
    // The print title: one line on a low, clear slab face, always on the fine lettering pen.
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', points });
    const buckets = new PartBuckets();
    const removeHidden = ctx.params.occlusion !== false;
    const censor = censorBars(ctx, pose, p => { const q = p.clone().project(view); return { x: (q.x * 0.5 + 0.5) * W * MM_X, y: (-q.y * 0.5 + 0.5) * H * MM_Y }; });
    const censorPx = censor.quads.map(q => q.map(c => ({ x: c.x / MM_X, y: c.y / MM_Y })));
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      hidden: () => removeHidden,
      pieces: (c, stroke) => {
        const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
        return bands ? clearBands(c, bands, pageMmPerPx) : [c];
      },
      begin: stroke => {
        const key = `${stroke.group}-${stroke.ink}`;
        const text = stroke.group === 'slogan' || stroke.group === 'title';
        return shown => {
          const visible = censorPx.length && !text ? shown.flatMap(r => knockOut(r, censorPx)) : shown;
          for (const run of visible) {
            for (const path of clipArt(scalePoints(run, MM_X, MM_Y))) buckets.add(key, path, text);
          }
        };
      },
    });
    const bars = censor.paths.flatMap(clipArt);
    const parts = buckets.toParts(GROUPS, INKS);
    if (bars.length) parts.push({ id: 'censor-carbon', pen: 'carbon', paths: bars });
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
