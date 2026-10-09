import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, MIN_SPACING, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, halo, layoutLength, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { MIN_LENGTH_MM, PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { Clearance } from './clearance.ts';

/**
 * III The Empress: there will always be more. No figure: abundance as a crop that grew into a
 * skyline. Slab plants stand in furrows that run from the foreground to a vanishing point on the
 * horizon, evenly spaced along each furrow as if planted. A smooth noise field sets how far each
 * has grown, in whole patches: seedlings of one or two blocks, a middling crop, and ripe towers, a
 * column of courses much taller than it is wide, that rise well above the horizon and carry the
 * sky. The helix is the wind: one thin, smooth ribbon in a long shallow S over the ripe tops, and
 * the tops near it bend away from it, a stalk's lean growing with height. Near plants are hatched,
 * far ones outline only, the farthest ticks. The words are cut into plant faces from near to far.
 */
/** The card's depth raster at tabloid; on any other page, the format's. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/** The nearest row of plants, in world units from the eye. */
const NEAR = 22;
/** Hidden-line slack for slabs, in world units (these plants are a third the size of the cathedral's slabs, so a third of its 0.6). */
const SLAB_SLACK = 0.1;
/** Depth bands: each gets its own bias, so the slack is the same distance in the world near and far. */
const BAND_EDGES = [0, 28, 40, 58, 85, 125, 190, 300, 480, Infinity];
/** A plant's tallest course count (ripe), and how tall a course stands on average. */
const MAX_COURSES = 14;
const MEAN_COURSE = 1.2;

/** The card's camera, on the format's page. */
export function empressCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const eye = n(ctx, 'eye', 6, 3, 12);
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, eye, 0], target: [0, eye, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the crop is planted with, so every size and fit grows the same field, plant for plant. At tabloid it is `empressCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const eye = n(ctx, 'eye', 6, 3, 12);
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye, near: 8, far: 4000 });
}

/**
 * The Empress's world: the growth field, the wind and the crop it bends. The crop is planted with `worldCamera`, in
 * tabloid's frame (its culls and course counts are measured on tabloid's paper), so every size and fit builds the
 * same world, to the bit. The wind's curve and surfaces do not depend on the camera; `view` (the card's camera) only
 * draws its strokes.
 */
export function empressWorld(ctx: SketchContext, view: THREE.PerspectiveCamera): { wind: Wind; plants: Plant[]; ticks: THREE.Vector3[][] } {
  const field = fieldOf(ctx);
  const wind = windRibbon(ctx, view, field);
  return { wind, ...plantField(ctx, worldCamera(ctx), field, wind) };
}

/** Smooth 2D value noise over a seeded lattice, 0..1. */
function valueNoise(rng: () => number, size = 32): (x: number, y: number) => number {
  const lattice = Float32Array.from({ length: size * size }, () => rng());
  const at = (i: number, j: number) => lattice[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * How many courses a plant grows for a growth value 0..1, in three stages: a seedling of one or two
 * blocks, a middling crop of a few, and ripe, a tower of many.
 */
function coursesFor(g: number): number {
  if (g < 0.36) return g < 0.26 ? 1 : 2;
  if (g < 0.58) return Math.round(3 + (g - 0.36) / 0.22 * 5);
  return Math.min(MAX_COURSES, Math.round(9 + (g - 0.58) / 0.24 * 5));
}

// Oriented boxes, for keeping separate things apart.
interface Obb { c: THREE.Vector3; a: THREE.Vector3[]; h: [number, number, number]; r: number }
function obbOf(s: Slab, grow = 0): Obb {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ'));
  const h: [number, number, number] = [s.w / 2 + grow, s.h / 2 + grow, s.d / 2 + grow];
  return {
    c: new THREE.Vector3(s.x, s.y, s.z), h, r: Math.hypot(...h),
    a: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(v => v.applyQuaternion(q)),
  };
}
function obbOverlap(p: Obb, q: Obb): boolean {
  const t = q.c.clone().sub(p.c);
  if (t.length() > p.r + q.r) return false;
  const axes = [...p.a, ...q.a];
  for (const u of p.a) for (const v of q.a) axes.push(new THREE.Vector3().crossVectors(u, v));
  for (const ax of axes) {
    const len = ax.length();
    if (len < 1e-6) continue;
    ax.multiplyScalar(1 / len);
    const rp = p.h[0] * Math.abs(p.a[0].dot(ax)) + p.h[1] * Math.abs(p.a[1].dot(ax)) + p.h[2] * Math.abs(p.a[2].dot(ax));
    const rq = q.h[0] * Math.abs(q.a[0].dot(ax)) + q.h[1] * Math.abs(q.a[1].dot(ax)) + q.h[2] * Math.abs(q.a[2].dot(ax));
    if (Math.abs(t.dot(ax)) > rp + rq) return false;
  }
  return true;
}
/** Distance from a point to a box (0 inside). */
function distanceToObb(p: THREE.Vector3, b: Obb): number {
  const t = p.clone().sub(b.c);
  let sum = 0;
  for (let i = 0; i < 3; i++) { const o = Math.max(0, Math.abs(t.dot(b.a[i])) - b.h[i]); sum += o * o; }
  return Math.sqrt(sum);
}

export interface Plant { slabs: Slab[]; base: THREE.Vector3; top: THREE.Vector3; depth: number; outline: boolean }
export interface Wind { curve: THREE.CatmullRomCurve3; strokes: ReturnType<typeof helixAlong>['strokes']; meshes: THREE.BufferGeometry[]; clearance: number }
export interface Field { growth: (x: number, d: number) => number; breeze: (x: number, d: number) => number }

export function fieldOf(ctx: SketchContext): Field {
  const ripe = valueNoise(ctx.random('crop-field'));
  const fine = valueNoise(ctx.random('crop-field-fine'));
  const breeze = valueNoise(ctx.random('crop-breeze'));
  const patch = n(ctx, 'patch', 0.85, 0.5, 2.5), ripen = n(ctx, 'ripen', 0.15, -0.4, 0.6);
  // Patches keep their size on the sheet at any depth: noise over the angle off the axis and the log of the distance.
  const frame = (x: number, d: number) => [x / d * 5.5 / patch, Math.log(d / NEAR) * 2.1 / patch] as const;
  return {
    growth: (x, d) => {
      const [u, v] = frame(x, d);
      const g = 0.82 * ripe(u + 3.1, v) + 0.18 * fine(u * 2.7 + 9, v * 2.7 + 5);
      // Stretched, so whole patches are seedlings or ripe and the middling crop is the margin between.
      return clamp(0.5 + (g - 0.5) * 2.6 + ripen * (Math.log(d / NEAR) / 3.5 - 0.5), 0, 1);
    },
    breeze: (x, d) => { const [u, v] = frame(x, d); return breeze(u * 1.3 + 17, v * 1.3 + 11); },
  };
}

/**
 * The wind: one thin helix ribbon in a long S over the ripe tops, from the left or right edge, in the
 * helix's own inks. Its height follows the crop's own, smoothed: higher over ripe patches, lower over
 * seedlings, with a wave added so the S holds in every seed.
 */
export function windRibbon(ctx: SketchContext, view: THREE.PerspectiveCamera, field: Field): Wind {
  const rng = ctx.random('crop-wind');
  const dir = ctx.params.windFrom === 'right' ? -1 : 1;
  const depth = n(ctx, 'windDepth', 30, 18, 120) * (0.94 + 0.12 * rng());
  const swing = n(ctx, 'windSwing', 4, 2, 30) * (0.85 + 0.3 * rng());
  const phase = (rng() - 0.5) * 0.6;
  const slope = n(ctx, 'windSlope', 6, -30, 30);
  const clearance = n(ctx, 'windHigh', 1.6, 0.4, 4), radius = n(ctx, 'windRadius', 0.2, 0.08, 0.8);
  const spacing = n(ctx, 'furrow', 2.8, 2, 7), row = n(ctx, 'row', 3.4, 2.5, 8);
  const eye = view.position.y;
  const count = 18;
  // One full wave across the visible width of the card (the ribbon runs a little past each edge): a peak a quarter of
  // the way across and a trough at three quarters, or the other way up, a little skewed. It lifts the ribbon where it
  // brings it nearer and lowers it where it sends it back, so the S shows on the sheet whatever the crop does.
  const psi = (ctx.random('crop-wind-rise')() < 0.5 ? 0 : Math.PI) + phase;
  const at = Array.from({ length: count + 1 }, (_, i) => {
    const r = dir * (i / count * 2 - 1) * 0.44;
    const frac = (r + 0.287) / 0.574;
    const w = Math.sin(2 * Math.PI * frac + psi);
    const d = depth + slope * (frac - 0.5) - swing * w;
    return { x: r * d, d, w };
  });
  // The crop's typical height round each point: a row either side and a furrow either side.
  const tallest = at.map(p => {
    let sum = 0, k = 0;
    for (const dx of [-spacing, 0, spacing]) for (const dd of [-row, 0, row]) { sum += coursesFor(field.growth(p.x + dx, p.d + dd)) * MEAN_COURSE; k++; }
    return sum / k;
  });
  const smoothed = tallest.map((_, i) => {
    let s = 0, k = 0;
    for (let j = 0; j <= count; j++) { const w = Math.exp(-(((j - i) / 2) ** 2)); s += tallest[j] * w; k += w; }
    return s / k;
  });
  const mean = tallest.reduce((a, b) => a + b, 0) / tallest.length;
  // Height: the crop's own (half its smoothed local height, half its overall mean) lifted by a clearance, plus the
  // wave. The wave never dips under the horizon: the base is held up by its amplitude.
  const rise = n(ctx, 'windRise', 1.9, 0, 6);
  const pts = at.map((p, i) => {
    const base = Math.max(mean * 0.5 + smoothed[i] * 0.5 + clearance, eye + 1.2 + rise);
    return new THREE.Vector3(p.x, clamp(base + rise * p.w, eye + 1.2, eye + 14), -p.d);
  });
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  // The kit's helix wiggles by amounts fixed in world units (a third of a unit up and down, a seventh in and out),
  // which swamp a thin ribbon. So the ribbon is built four times the size, seen by a camera moved out to match, and
  // then brought back: the same picture with the wiggle a quarter as large.
  const S = 4;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const big = new THREE.CatmullRomCurve3(pts.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const made = helixAlong(ctx, sv, big, {
    radius: radius * S, width: radius * 0.9 * S, pitch: n(ctx, 'windPitch', 4.5, 1.5, 12) * S, spread: radius * 0.35 * S, narrow: 0.1, twist: 0.08, density: 0.1, interruption: 0.5,
  });
  const ribbon = {
    strokes: made.strokes.map(h => ({ ...h, points: h.points.map(q => q.clone().multiplyScalar(1 / S)) })),
    meshes: made.meshes.map(g => g.scale(1 / S, 1 / S, 1 / S)),
  };
  return { curve, strokes: ribbon.strokes, meshes: ribbon.meshes, clearance: 0.35 };
}

/** Every vertex of the ribbon's surfaces: what the plants must keep clear of. */
function ribbonPoints(wind: Wind): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const g of wind.meshes) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i += 2) out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  return out;
}

interface Spec { r: number[]; yaw: number }
/** How a plant leans: straight off `base` radians in all, then bending toward (x, z) up to `top` more at its tip. */
interface Tilt { x: number; z: number; base: number; top: number }
interface Attempt { lean: number; width: number; height: number }
const ATTEMPTS: Attempt[] = [
  { lean: 1, width: 1, height: 1 }, { lean: 1, width: 1, height: 0.85 }, { lean: 1, width: 0.95, height: 0.7 },
  { lean: 0.6, width: 0.9, height: 0.55 }, { lean: 0.3, width: 0.85, height: 0.4 }, { lean: 0, width: 0.8, height: 0.25 },
];

/**
 * A plant of `m` slab courses, `height` tall in all, standing on `base`. Like a stalk it bends: the
 * foot stays put and each course above tips a little further than the one below (tilt grows with
 * the course's height to the power 1.7), so the top courses slip most.
 */
function buildPlant(base: THREE.Vector3, m: number, height: number, w0: number, spec: Spec, tilt: Tilt, beat: number): Slab[] {
  const Y = new THREE.Vector3(0, 1, 0);
  const yawQ = new THREE.Quaternion().setFromAxisAngle(Y, spec.yaw);
  const weights = Array.from({ length: m }, (_, i) => 0.75 + 0.5 * spec.r[i * 4]);
  const total = weights.reduce((a, b) => a + b, 0);
  const hs = weights.map(w => height * w / total);
  const depth = Math.min(0.95, w0 * (0.65 + 0.2 * spec.r[63]));
  const angles: number[] = [];
  let climbed = 0;
  for (let i = 0; i < m; i++) { angles.push(tilt.base + tilt.top * ((climbed + hs[i] / 2) / height) ** 1.7); climbed += hs[i]; }
  const out: Slab[] = [];
  const foot = base.clone();
  for (let i = 0; i < m; i++) {
    const a = angles[i], h = hs[i];
    const dir = new THREE.Vector3(Math.sin(a) * tilt.x, Math.cos(a), Math.sin(a) * tilt.z).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(Y, dir).multiply(yawQ);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const shelf = spec.r[i * 4 + 2] < 0.1 ? 1.18 : 1;
    const w = w0 * (1 - 0.18 * i / Math.max(1, m)) * (0.9 + 0.2 * spec.r[i * 4 + 1]) * shelf * (i === 0 ? 1.08 : 1);
    const slip = (spec.r[i * 4 + 2] - 0.5) * 0.2 * w;
    // Courses tip by different amounts, so the gap between them grows with the turn, or their corners would meet.
    const turn = Math.max(Math.abs(a - (angles[i - 1] ?? a)), Math.abs((angles[i + 1] ?? a) - a));
    const hh = h - Math.min(0.2 * h, 0.04 + 0.7 * Math.max(w, depth) * turn);
    const centre = foot.clone().addScaledVector(dir, h / 2).addScaledVector(side, slip);
    const tone = 0.6 + 0.7 * ((spec.r[i * 4 + 3] * 7.3) % 1);
    // Now and then a course is split in two blocks with a gap.
    const split = spec.r[i * 4 + 3] < 0.08 && w > 0.9 ? 0.3 + 0.4 * ((spec.r[i * 4 + 1] * 11.7) % 1) : 0;
    const pieces = split ? [[-w / 2 + w * split / 2, w * split - 0.1], [w * split / 2, w * (1 - split) - 0.1]] : [[0, w]];
    for (const [off, pw] of pieces) {
      const pc = centre.clone().addScaledVector(side, off);
      const sl = solid(pc.x, pc.y, pc.z, pw, hh, depth, beat, 'stack');
      sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
      sl.tone = tone;
      out.push(sl);
    }
    foot.addScaledVector(dir, h);
  }
  // Stand the plant on the ground: its lowest corner touches it.
  let lowest = Infinity;
  for (const sl of out) {
    const b = obbOf(sl);
    lowest = Math.min(lowest, b.c.y - (Math.abs(b.a[0].y) * b.h[0] + Math.abs(b.a[1].y) * b.h[1] + Math.abs(b.a[2].y) * b.h[2]));
  }
  for (const s of out) { s.y -= lowest; s.home.y -= lowest; }
  return out;
}

/**
 * The crop. Plants stand at the crossings of furrows and rows, evenly spaced along each furrow and
 * every other furrow offset half a step, a very little off their marks. A smooth noise field sets
 * how far each has grown. Plants near the wind bend away from it, more toward the tip. No plant
 * touches the ribbon or another plant: one that would is first straightened, then slimmed, then cut
 * down, and left out if it still cannot stand.
 */
export function plantField(ctx: SketchContext, view: THREE.PerspectiveCamera, field: Field, wind: Wind): { plants: Plant[]; ticks: THREE.Vector3[][] } {
  // Planted in tabloid's frame: `view` is `worldCamera`, and every page measure here is tabloid's (see `empressWorld`).
  const rowRng = ctx.random('crop-rows'), plantRng = ctx.random('crop-plants');
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const eye = view.position.y;
  const spacing = n(ctx, 'furrow', 2.8, 2, 7), rowStep = n(ctx, 'row', 3.4, 2.5, 8), reach = n(ctx, 'reach', 400, 100, 1400);
  const windTop = THREE.MathUtils.degToRad(n(ctx, 'lean', 10, 0, 40));
  const yaw = n(ctx, 'vanish', 0.05, -0.3, 0.3);
  const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)), along = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  const mmAt = (d: number) => f / Math.max(1, d);
  // No tower may rise past the upper part of the card: its tip is held to a page height.
  const tipLimit = TABLOID_CARD.y0 + 50;
  const heightCap = (d: number) => eye + (TABLOID_HORIZON_Y - tipLimit) * d / f;

  // The wind's track on the ground, to measure each plant against.
  const track = Array.from({ length: 241 }, (_, i) => {
    const t = i / 240, p = wind.curve.getPointAt(t), tg = wind.curve.getTangentAt(t);
    return { x: p.x, y: p.y, z: p.z, tx: tg.x, tz: tg.z, t };
  });
  const cloud = ribbonPoints(wind);
  const wave = 2 * Math.PI / 17, wavePhase = rowRng() * Math.PI * 2;

  const plants: Plant[] = [];
  const ticks: THREE.Vector3[][] = [];
  const hash = new Map<string, Obb[]>();
  const keyOf = (x: number, z: number) => `${Math.floor(x / 6)},${Math.floor(z / 6)}`;
  const nearby = (x: number, z: number) => {
    const out: Obb[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(hash.get(`${Math.floor(x / 6) + i},${Math.floor(z / 6) + j}`) ?? []));
    return out;
  };

  // Far off, furrows and rows run together on the sheet. Each furrow and each row carries its own
  // fixed draw and drops out where the distance outruns it, so the few that last still converge.
  const thin = ctx.random('crop-thin');
  const furrowDraw = new Map<number, number>();
  const furrowAt = (k: number) => { if (!furrowDraw.has(k)) furrowDraw.set(k, thin()); return furrowDraw.get(k)!; };
  const latLimit = 18 * spacing, rowLimit = 16 * rowStep;
  let v = NEAR;
  let beat = 0;
  while (v < reach) {
    const step = Math.max(rowStep, 0.08 * v);
    const rowDraw = thin();
    const rowKeep = rowDraw < Math.min(1, rowLimit / v);
    const kmax = Math.ceil(0.5 * v / spacing) + Math.ceil(Math.abs(Math.tan(yaw)) * v / spacing) + 3;
    for (let k = -kmax; k <= kmax; k++) {
      const ju = rowRng() - 0.5, jv = rowRng() - 0.5;
      if (!rowKeep || furrowAt(k) > Math.min(1, latLimit / v)) continue;
      const u = (k + 0.1 * ju) * spacing, vv = v + ((k & 1) ? 0.5 * step : 0) + 0.06 * step * jv;
      const base = new THREE.Vector3().addScaledVector(right, u).addScaledVector(along, vv);
      const d = -base.z;
      if (d < NEAR - 1) continue;
      const at = pageOf(view, base, TABLOID_PAGE);
      if (at.x < TABLOID_CARD.x0 - 30 || at.x > TABLOID_CARD.x1 + 30 || at.y > TABLOID_PAGE.height) continue;
      const spec: Spec = { r: Array.from({ length: 64 }, () => plantRng()), yaw: (plantRng() - 0.5) * 0.2 };
      const miss = plantRng();
      const g = clamp(field.growth(base.x, d) + (spec.r[44] - 0.5) * 0.06, 0, 1);
      let logical = coursesFor(g);
      if (logical >= 3) logical = clamp(logical + (spec.r[40] < 0.25 ? -1 : spec.r[40] > 0.75 ? 1 : 0), 3, MAX_COURSES);
      const w0 = 0.85 + 0.4 * spec.r[45];
      const fullH0 = Math.min(logical * (1 + 0.4 * spec.r[46]), heightCap(d) * (0.8 + 0.2 * spec.r[39]));
      let near = track[0], best = Infinity;
      for (const s of track) { const dd = (s.x - base.x) ** 2 + (s.z - base.z) ** 2; if (dd < best) { best = dd; near = s; } }
      const dist = Math.sqrt(best);
      // Under the ribbon the crop stops just short of it: the wind has trimmed the tops.
      const fullH = dist < 2.6 ? Math.min(fullH0, Math.max(0.8, near.y - 0.9)) : fullH0;
      const mm = mmAt(d);
      if (fullH * mm < 1.1 || miss < 0.02) continue;
      // The wind: lean away from the nearest point of its track, strongest close by, in a travelling wave.

      let ax = base.x - near.x, az = base.z - near.z;
      if (dist < 0.5) { const sgn = spec.r[43] < 0.5 ? -1 : 1; ax = -near.tz * sgn; az = near.tx * sgn; } else { ax /= dist; az /= dist; }
      const reachR = 3.5 + 0.03 * d;
      const gust = Math.exp(-((dist / reachR) ** 2)) * (0.8 + 0.2 * Math.sin(wave * near.t * 240 + wavePhase));
      // A seedling hardly bends: the lean scales up with how tall the plant stands.
      const bend = windTop * gust * smooth(1.5, 7, fullH);
      // Tilt toward or away from the eye reads as a tumbled box; keep the bend mostly sideways in the picture.
      const bt = (field.breeze(base.x, d) - 0.5) * 2 * Math.PI;
      const dx = ax, dz = az * 0.55, dl = Math.hypot(dx, dz) || 1;
      const baseLean = THREE.MathUtils.degToRad(2.4) * (0.5 + spec.r[42]);
      const tilt: Tilt = { x: dx / dl, z: dz / dl, base: 0, top: bend };
      const breezeX = Math.cos(bt), breezeZ = Math.sin(bt) * 0.55;

      if (fullH * mm < 3 || w0 * mm < 2.2) {
        // Too small to draw as slabs: a tick, leaning with the rest.
        const lean = bend * 0.5;
        const topAt = base.clone().add(new THREE.Vector3(Math.sin(lean) * tilt.x, Math.cos(lean), Math.sin(lean) * tilt.z).multiplyScalar(fullH));
        ticks.push([base, topAt]);
        continue;
      }
      const keep = nearby(base.x, base.z);
      for (const a of ATTEMPTS) {
        const height = fullH * a.height;
        const m = clamp(Math.min(Math.max(1, Math.round(logical * a.height)), Math.floor(height * mm / 6)), 1, MAX_COURSES);
        // The breeze straightens or tips the whole plant a very little; the wind bends it more toward the tip.
        const lean = baseLean * a.lean;
        const tx = tilt.x * bend + breezeX * lean, tz = tilt.z * bend + breezeZ * lean;
        const mag = Math.hypot(tx, tz) || 1;
        const t2: Tilt = { x: tx / mag, z: tz / mag, base: lean, top: tilt.top * a.lean };
        const slabs = buildPlant(base, Math.max(1, m), height, w0 * a.width, spec, t2, beat++);
        const boxes = slabs.map(s => obbOf(s, 0.1));
        if (keep.some(o => boxes.some(b => obbOverlap(b, o)))) continue;
        if (dist < 14 && boxes.some(b => cloud.some(p => distanceToObb(p, b) < wind.clearance))) continue;
        const key = keyOf(base.x, base.z);
        hash.set(key, [...(hash.get(key) ?? []), ...boxes]);
        const top = slabs.reduce((hi, s) => (s.y + s.h / 2 > hi.y ? new THREE.Vector3(s.x, s.y + s.h / 2, s.z) : hi), new THREE.Vector3(0, -1, 0));
        const widest = slabs.reduce((hi, s) => Math.max(hi, s.w), 0);
        plants.push({ slabs, base, top, depth: d, outline: widest * mm < 8 });
        break;
      }
    }
    v += step;
  }
  return { plants, ticks };
}

/** The slabs of a plant grouped by course: the two blocks of a split course (same height and tone, side by side) go together. */
function courseGroups(slabs: Slab[]): Slab[][] {
  const groups: Slab[][] = [];
  for (const sl of slabs) {
    const last = groups[groups.length - 1];
    if (last && last[0].h === sl.h && last[0].tone === sl.tone) last.push(sl); else groups.push([sl]);
  }
  return groups;
}

/**
 * A far plant drawn quietly: not its courses but its outline, one line up the left side, across the top, down the
 * right and back along the foot, a hair in front of the faces so the hidden-line pass keeps it. The sides are smoothed over three courses, so
 * the slight differences in width between courses do not make the edge shiver.
 */
function silhouette(plant: Plant): THREE.Vector3[] {
  const e = 0.02;
  const groups = courseGroups(plant.slabs);
  const edge = (sl: Slab, x: number, y: number) => new THREE.Vector3(x * (sl.w / 2 + e), y * (sl.h / 2 + e), sl.d / 2 + e).applyMatrix4(slabMatrix(sl));
  const ends = groups.map(g => {
    // Left and right blocks of the course, by where they stand across it.
    const side = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(slabMatrix(g[0])));
    const sorted = [...g].sort((a, b) => (a.x * side.x + a.y * side.y + a.z * side.z) - (b.x * side.x + b.y * side.y + b.z * side.z));
    return { l: sorted[0], r: sorted[sorted.length - 1] };
  });
  const smoothed = (pts: THREE.Vector3[]) => pts.map((q, i) => i === 0 || i === pts.length - 1 ? q : pts[i - 1].clone().add(q).add(pts[i + 1]).multiplyScalar(1 / 3));
  const left = smoothed(ends.map(g => edge(g.l, -1, 0))), right = smoothed(ends.map(g => edge(g.r, 1, 0)));
  const first = ends[0], last = ends[ends.length - 1];
  return [edge(first.l, -1, -1), ...left, edge(last.l, -1, 1), edge(last.r, 1, 1), ...right.reverse(), edge(first.r, 1, -1), edge(first.l, -1, -1)];
}

export function drawEmpress(ctx: SketchContext): Part[] {
  const view = empressCamera(ctx);
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  // The world, the same at every size; this card's camera draws it.
  const { wind, plants, ticks } = empressWorld(ctx, view);
  // Light from the right and well forward: the fronts stay light, the left flanks fall dark.
  const light = new THREE.Vector3(0.5, 0.5, 0.55).normalize();
  const hatch = n(ctx, 'hatch', 1.6, 0.6, 4);

  type Banded = Stroke & { band: number };
  const bandOf = (p: THREE.Vector3) => { const d = eye.z - p.z; return BAND_EDGES.findIndex((e, i) => d >= e && d < BAND_EDGES[i + 1]); };
  const strokes: Banded[] = [];
  for (const plant of plants) {
    if (plant.outline) {
      const line = silhouette(plant);
      strokes.push({ ink: 'carbon', group: 'far', family: 'edge', points: line, band: bandOf(plant.base) });
      continue;
    }
    for (const sl of plant.slabs) {
      const at = new THREE.Vector3(sl.x, sl.y, sl.z);
      const band = bandOf(at);
      for (const st of facetStrokes(sl, light, eye, plant.outline, hatch * FACET_MM_PER_UNIT / mmPerUnit(at))) {
        strokes.push({ ink: 'carbon', group: 'crop', family: st.family, points: st.points, band });
      }
    }
  }
  // The ridges between furrows, ruled along the ground to the vanishing point. Each runs out at its own distance.
  {
    const yaw = n(ctx, 'vanish', 0.05, -0.3, 0.3), spacing = n(ctx, 'furrow', 2.8, 2, 7), reach = n(ctx, 'reach', 400, 100, 1400);
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)), along = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    const ends = ctx.random('crop-ridges');
    for (let k = -8; k <= 7; k++) {
      const end = Math.min(reach, 110, 40 * spacing / Math.max(0.05, ends()));
      const from = new THREE.Vector3().addScaledVector(right, (k + 0.5) * spacing).addScaledVector(along, NEAR * 0.8);
      const to = new THREE.Vector3().addScaledVector(right, (k + 0.5) * spacing).addScaledVector(along, end);
      strokes.push({ ink: 'carbon', group: 'ground', family: 'edge', points: [from, to], band: bandOf(from) });
    }
  }
  for (const t of ticks) strokes.push({ ink: 'carbon', group: 'far', family: 'edge', points: t, band: bandOf(t[0]) });
  for (const h of wind.strokes) strokes.push({ ink: h.ink, group: 'wind', family: 'membrane', points: h.points, band: bandOf(h.points[Math.floor(h.points.length / 2)]) });

  const geometries = [...plants.flatMap(p => p.slabs.map(slabGeometry)), ...wind.meshes];
  try {
    fitDepthRange(view, geometries);
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // Window-depth bias for a slack of SLAB_SLACK world units at the middle of a band.
    const nearP = view.near, farP = view.far;
    const biasOf = (band: number) => {
      const lo = BAND_EDGES[band], hi = Number.isFinite(BAND_EDGES[band + 1]) ? BAND_EDGES[band + 1] : lo * 1.4;
      const d = Math.sqrt(Math.max(lo, 8) * hi);
      return Math.max(3e-5, SLAB_SLACK * nearP * farP / ((farP - nearP) * d * d));
    };
    const solids = meshCoverage(geometries, view, PAGE, halo(n(ctx, 'knockout', 1, 0.3, 3)));
    // The wind keeps a wider margin of clear paper than the crop, so the ribbon never touches the ruled sky.
    const windClear = meshCoverage(wind.meshes, view, PAGE, halo(n(ctx, 'windHalo', 4, 1, 8)));

    // The phrase: each word cut into the front of a plant course, staggered from near to far; or, where the format
    // sets it in the band, under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('crop-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], band: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H, bias: biasOf(band) }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    const centreX = (CARD.x0 + CARD.x1) / 2;
    const cands = plants.flatMap(p => p.slabs.map(sl => ({ sl, plant: p, at: pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z)) })))
      .filter(({ at }) => at.y > CARD.y0 + layoutLength(8) && at.y < CARD.y1 - layoutLength(8) && at.x > CARD.x0 + layoutLength(8) && at.x < CARD.x1 - layoutLength(8));
    const used = new Set<Plant>();
    const placed: Point[] = [];
    const sideOf = wrng() < 0.5 ? 0 : 1;
    words.forEach((word, i) => {
      // The words run from the nearest rows to rows farther in, and take turns on the left and right of the card.
      const target = 17 + 48 * i / Math.max(1, words.length - 1);
      const wantLeft = (i + sideOf) % 2 === 0;
      const wmm = measureStrokeText(word, style);
      const pick = (side: boolean | null) => cands.filter(({ sl, plant, at }) => {
        if (used.has(plant) || (side !== null && (at.x < centreX) !== side)) return false;
        // Words keep well apart on the sheet.
        if (placed.some(q => Math.hypot(q.x - at.x, q.y - at.y) < layoutLength(70))) return false;
        const mm = mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
        if (wmm > sl.w * mm * 0.9 || style.height > sl.h * mm * 0.8) return false;
        const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(slabMatrix(sl)));
        return normal.dot(eye.clone().sub(new THREE.Vector3(sl.x, sl.y, sl.z)).normalize()) > 0.55;
      }).map(c => ({ c, k: Math.abs(c.plant.depth - target) + 6 * wrng() })).sort((a, b) => a.k - b.k).map(x => x.c);
      const options = [...pick(wantLeft), ...pick(null)];
      for (const { sl, plant } of options) {
        const m = slabMatrix(sl), at = new THREE.Vector3(sl.x, sl.y, sl.z);
        const unit = 1 / mmPerUnit(at);
        const ww = wmm * unit, hh = style.height * unit;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww) * 0.8, y0 = hh / 2 + (wrng() - 0.5) * (sl.h - hh) * 0.6;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3, bandOf(at))) continue;
        textStrokes.push(...word3);
        used.add(plant);
        placed.push(pageOf(view, at));
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.9));
    const buckets = new PartBuckets(0.4);
    // Off tabloid the far field gives way: its plants are small enough on the card that one standing a row behind another
    // shows a sliver of outline beside it, closer than the pens hold apart. So each far mark keeps only what clears
    // everything drawn in front of it (drawn first, band by band) by the format's spacing. The print is unchanged.
    const clear = FORMAT.tabloid ? undefined : new Clearance(MIN_SPACING);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number, exact = false, giveWay = false) => {
      const keep = (p: Point) => !onGlyph(p) && extra(p) && !(giveWay && clear?.near(p));
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, keep, 0.15)) if (buckets.add(key, piece, exact, min)) clear?.add(piece);
    };
    // On a small card the path reducer's 1.4 mm stride is a large share of the wind's twists, and turns its ribbon's
    // edges to zigzags: there its strokes keep every point (and the reducer's shortest path). The print is unchanged.
    const smoothWind = !FORMAT.tabloid;
    for (let band = 0; band < BAND_EDGES.length - 1; band++) {
      const mine = strokes.filter(s => s.band === band);
      if (!mine.length) continue;
      projectStrokes(mine, { view, depth: depthBuffer, width: W, height: H, bias: biasOf(band) }, {
        // Scraps are dropped: ground rules under 3 mm and far outlines and ticks under 1.6 mm, which the plants in front
        // cut up. Real millimetres on any card: a scrap is as short on paper whatever the size. Off tabloid a piece of the
        // crop shorter than the smallest feature goes too (`MIN_FEATURE` is 0 at tabloid): a speck of a face's hatch, or a
        // stub of a course's edge where the plants in front cut it, which on a small card is about a quarter of its print length.
        begin: st => runs => {
          const min = st.group === 'ground' ? tolerance(3) : st.group === 'far' ? tolerance(1.6) : st.group === 'crop' ? MIN_FEATURE || undefined : undefined;
          const exact = st.group === 'wind' && smoothWind;
          for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), undefined, exact ? MIN_LENGTH_MM : min, exact, st.group === 'far');
        },
      });
    }
    // The sky: a light ruling that thins and breaks as it comes down to the horizon, knocked out round what stands in it.
    const reachSky = n(ctx, 'sky', 0.4, 0, 1);
    const pattern = barPattern(ctx.random('crop-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    if (reachSky > 0) for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += 1.2) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
      // Every other of the longest rules runs on down to the horizon, broken more as it goes; the rest stop short.
      const deep = i % 16 === 0;
      const limit = [deep ? 1 / reachSky : 0.95, 0.72, 0.5, 0.28][tier];
      if (t > limit * reachSky) continue;
      const broken = t > 0.3 * Math.min(limit, 0.95) * reachSky;
      const thinner = deep && t > 0.95 * reachSky;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => {
        const step = Math.floor((p.x - CARD.x0) / 3.2 + i);
        return !solids(p) && !windClear(p) && (!broken || pattern[step % 64]) && (!thinner || pattern[(step * 3 + 17) % 64]);
      });
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'ground', 'far', 'crop', 'wind', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('III', 'THE EMPRESS', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
