import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import {
  FORMAT, MIN_FEATURE, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, evenlyKept, halo, hatchMin, layoutLength, layoutY,
  maskRes, printFine, scaledCount, tabloidX, tolerance,
} from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { faceDarkness, facetStrokes, pageExtent, slabGeometry, slabMatrix, solid, type FacetStroke, type Slab } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { densify, keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, onGround, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { restPattern } from '../../kit/rhythm.ts';
import { PartBuckets, fineDepth, projectStrokes, scalePoints, type ProjectEnv } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { roadPlan, roadStrokes, type RoadPlan } from './road.ts';
import { crescent, rimPoint, type Crescent } from './crescent.ts';
import { onRock, rockMesh, station, type Station } from './station.ts';
import { broken, brokenMeshes, brokenNormal, brokenPoint, frontOf, type Broken } from './broken.ts';
import { towerVariant, type TowerForm, type TowerSet } from './towers.ts';

/**
 * XVIII The Moon: none of this light is its own. Two squat towers of long slabs stand either side of
 * a path, the near one on the left, the far one on the right, under a big moon lit only from the side
 * its sun is on: by default a station built into a moon (a rock body with a spine of slabs driven into
 * it, see `station.ts`), or, as first drawn, a crescent of cantilevered slabs (`crescent.ts`). The eye is high over a small world, so the
 * ground opens out: the path is the helix, one flat ribbon road rising out of the water and winding in
 * wide S-bends back to the horizon, turning over a few times on the way so that its other side shows.
 * In front lies a pool, ruled as water, and the pool reflects a different city from the one standing
 * above it: the far tower comes back as a stump, the near one short and on a plinth, and a tower stands
 * in the water that is nowhere above it. The reflection is the card's key mark: a clean mirror at a
 * glance, wrong a beat later. The last two words of the phrase are cut into the tower that exists only
 * in the water.
 *
 * On a small card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`moonWorld`: the bank, the
 * towers and their howl, the false city, the broken moon and its volley and debris, the road), and the card's own
 * camera draws it, depth-tested as finely as the print is. The slabs' outlines are trimmed, the debris thinned with the
 * card, the rulings of sky, water and rock held in millimetres on paper, the halos scaled, and the phrase moves to the
 * bottom band: the words cut into the towers and the false tower leave the art; the false tower stays.
 */
/** How many times finer each way the hidden-line tests run on a small card (`printFine`): 1 at tabloid. */
const FINE = printFine();
/** The card's depth raster at tabloid; on any other page, the format's, with room for the finer one. */
const RASTER = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, FINE);
const { W, H, MM_X, MM_Y } = RASTER;
/**
 * The page masks (the knockouts round the towers, the moon and the city in the water, the moon's shells) are rastered
 * this finely, in pixels per millimetre (`maskRes`): the kit's 3 at tabloid, and as fine in the world as the print's on a
 * smaller card, where a stake or a piercing slab is a pixel or two wide at 3, its mask frays, and the night runs up to it.
 */
const MASK_RES = maskRes();
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** The eye is high over a small world: towers stand only a few eye heights tall, so the ground and the water open out below the horizon. */
const EYE = 30;
const FACET_MM_PER_UNIT = 8.3;
/** Height of one ripple band in the water, in millimetres. */
const BAND = 1.6;
/** Faces the moonlight leaves darker than this get the hatch; paler ones stay open paper. */
const CALM = 0.5;

/** The card's camera, on the format's page. */
export function moonCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 40000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the card's world is laid out with. At tabloid it is `moonCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye: EYE, near: 8, far: 40000 });
}

const focalOf = (view: THREE.PerspectiveCamera, page: { height: number } = PAGE) => page.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));

/**
 * The waterline on tabloid's sheet: y (mm) at each x. A bank rising from near the viewer on the left to far off on the
 * right, with a spit of land reaching toward us where the path comes out. It is the world's bank, laid out in tabloid's
 * frame; a card draws it as `layoutY(shore(tabloidX(x)))`.
 */
export function shoreOf(ctx: SketchContext): (x: number) => number {
  const rng = ctx.random('moon-shore');
  const ph = [rng() * Math.PI * 2, rng() * Math.PI * 2];
  const left = n(ctx, 'shoreLeft', 330, 300, 365), right = n(ctx, 'shoreRight', 286, 262, 340);
  const nearX = n(ctx, 'nearX', 62, 30, 120), farX = n(ctx, 'farX', 212, 170, 245), spit = n(ctx, 'spit', 26, 0, 40), pathX = n(ctx, 'pathX', 150, 110, 190);
  const raw = (x: number) => {
    const u = (x - TABLOID_CARD.x0) / (TABLOID_CARD.x1 - TABLOID_CARD.x0);
    // A near promontory under the near tower, a spit at the path, and a slow wander along the bank.
    return left + (right - left) * u + 6 * Math.exp(-(((x - nearX) / 26) ** 2)) + spit * Math.exp(-(((x - pathX) / 34) ** 2))
      + 1.4 * Math.sin(u * 9 + ph[0]) + 0.8 * Math.sin(u * 23 + ph[1]);
  };
  // Each tower stands on a level shelf of the bank, so its whole foot is on land and the water begins just below it.
  const flat = (x: number, at: number) => Math.exp(-(((x - at) / 27) ** 4));
  return x => {
    const wn = flat(x, nearX), wf = flat(x, farX);
    return raw(x) + wn * (raw(nearX) - raw(x)) + wf * (raw(farX) - raw(x));
  };
}

interface TowerSpec {
  x: number; z: number;
  /** Width of a course on average. */
  w: number; height: number; ry: number; stream: string;
  /** How many courses it is built of. */
  count: number;
  /** The top courses step in: width multiples from the top down (omit for a straight tower). */
  crown?: number[];
  /** Extra width of the lowest courses, one entry each, as a multiple of the course's own width. */
  plinth?: number[];
  /** Courses (counted from the bottom) that are long slabs overhanging the rest, and which way along the tower's face they slide (toward the card's middle, so the horizon stays open at the edge). */
  overhang?: number[]; overhangSide?: 1 | -1;
}

/**
 * A squat Breach gate tower of a few big slabs: courses about as wide as the tower and two or three
 * times as long as they are tall, of uneven heights, each slipped decisively to one side or the other
 * and turned a few degrees off the last; one or two long courses overhang the rest; the lowest is the
 * heaviest and the top ones step in. Turned about its own axis and never quite true.
 */
export function tower(ctx: SketchContext, spec: TowerSpec): Slab[] {
  const rng = ctx.random(spec.stream);
  const out: Slab[] = [];
  const ax = new THREE.Vector3(Math.cos(spec.ry), 0, -Math.sin(spec.ry));
  // Every course draws all its numbers, used or not, so a seed's layout never shifts with another's choices.
  const draws = Array.from({ length: spec.count }, () => ({ hr: rng(), wr: rng(), slipR: rng(), tone: rng(), yaw: rng(), depthR: rng() }));
  const weights = draws.map((c, i) => (0.6 + 1.1 * c.hr) * (i === 0 ? 1.3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const gap = spec.w * 0.012;
  let y = 0;
  draws.forEach((c, i) => {
    const h = spec.height * weights[i] / total;
    const fromTop = spec.count - 1 - i;
    const long = spec.overhang?.includes(i) ?? false;
    const wc = (spec.plinth?.[i] ?? 1) * spec.w * (0.9 + 0.24 * c.wr) * (spec.crown?.[fromTop] ?? 1) * (long ? 1.32 : 1);
    // Slipped well off the course below: an overhanging course slides out to one side, the others either way.
    const slip = long ? (spec.overhangSide ?? 1) * (0.16 + 0.1 * c.slipR) * spec.w : (c.slipR - 0.5) * 0.4 * spec.w;
    const sl = solid(spec.x + ax.x * slip, y + h / 2, spec.z + ax.z * slip, wc, h - gap, wc * (0.6 + 0.12 * c.depthR) / (long ? 1.15 : 1), out.length, 'stack');
    sl.ry = spec.ry + (c.yaw - 0.5) * 0.16;
    sl.tone = 0.6 + 0.4 * c.tone;
    out.push(sl);
    y += h;
  });
  return out;
}

/** A slab as the water shows it: upside down below the surface, its turn about the vertical unchanged. */
const mirrored = (s: Slab): Slab => ({ ...s, y: -s.y, home: { ...s.home, y: -s.home.y } });
const mirrorPoint = (p: THREE.Vector3) => new THREE.Vector3(p.x, -p.y, p.z);

export interface Moonscape {
  shore: (x: number) => number;
  /** The towers that stand. */
  near: Slab[]; far: Slab[];
  /** The city in the water, upright, as it would stand if the water told the truth. */
  waterNear: Slab[]; waterFar: Slab[]; extra: Slab[];
}

/**
 * Everything standing, and the other city in the pool. Towers are placed by where their feet fall on the sheet: on
 * tabloid's, through the world camera `view`.
 */
export function moonscape(ctx: SketchContext, view: THREE.PerspectiveCamera): Moonscape {
  const f = focalOf(view, TABLOID_PAGE);
  const shore = shoreOf(ctx);
  // Feet stand a few millimetres up the bank, so the near corner of the lowest course stays on land.
  const at = (x: number) => onGround(view, { x, y: shore(x) - 3 }, TABLOID_PAGE);
  const heightFor = (foot: THREE.Vector3, top: number) => (pageOf(view, foot, TABLOID_PAGE).y - top) * (view.position.z - foot.z) / f;
  const nearX = n(ctx, 'nearX', 62, 30, 120), farX = n(ctx, 'farX', 212, 170, 245), extraX = n(ctx, 'extraX', 121, 70, 190);
  const nf = at(nearX), ff = at(farX), ef = at(extraX);
  const nearTop = n(ctx, 'nearTop', 163, 120, 240), farTop = n(ctx, 'farTop', 189, 140, 250);
  const nearH = heightFor(nf, nearTop), farH = heightFor(ff, farTop);
  const nearW = n(ctx, 'nearWidth', 0.62, 0.3, 1.2) * EYE, farW = n(ctx, 'farWidth', 0.75, 0.3, 1.2) * EYE;
  // The water's extra tower is sized by where its image ends: a reflection lies as far below the foot as the thing stands above it.
  const extraFoot = pageOf(view, ef, TABLOID_PAGE).y;
  const extraH = heightFor(ef, 2 * extraFoot - n(ctx, 'extraBottom', 381, 340, 389));
  return {
    shore,
    near: tower(ctx, { x: nf.x, z: nf.z, w: nearW, height: nearH, ry: -0.55, stream: 'moon-near', count: 9, crown: [0.66, 0.84], overhang: [4], overhangSide: 1 }),
    far: tower(ctx, { x: ff.x, z: ff.z, w: farW, height: farH, ry: -0.35, stream: 'moon-far', count: 8, crown: [0.6, 0.8], overhang: [3], overhangSide: -1 }),
    // The water's near tower stands on a plinth the real one has not got, and ends well short of it; the far one is a stump.
    waterNear: tower(ctx, { x: nf.x, z: nf.z, w: nearW, height: nearH * n(ctx, 'echoNear', 0.3, 0.1, 1), ry: -0.55, stream: 'moon-water-near', count: 4, plinth: [1.25, 1.1] }),
    waterFar: tower(ctx, { x: ff.x, z: ff.z, w: farW, height: farH * n(ctx, 'echoFar', 0.55, 0.15, 1), ry: -0.35, stream: 'moon-water-far', count: 5 }),
    // A tower that is nowhere above the water, its whole image inside the pool.
    extra: tower(ctx, { x: ef.x, z: ef.z, w: farW * 0.52, height: extraH, ry: -0.45, stream: 'moon-extra', count: 7, crown: [0.62, 0.84] }),
  };
}

/** The fewest of the broken moon's floating blocks a smaller card keeps at the `debris` default, so they still read as debris round it. */
export const DEBRIS_FLOOR = 6;
/** The floating blocks the broken moon seeds at the `debris` control's default. */
const DEBRIS_DEFAULT = 14;

/**
 * The broken moon's floating blocks a card draws: every one the world seeded, at tabloid. Each block's size scales with
 * the card, so where the format's count of them (`scaledCount` by length, never under `DEBRIS_FLOOR` at the control's
 * default, in proportion to it otherwise) is below the seeded number, the card keeps that share as an even spread over
 * their seeded order (a smaller card keeps a subset of what a larger one shows), less any smaller on paper than
 * `MIN_FEATURE`. The seeded blocks themselves never change. `view` is the card's camera.
 */
export function shownDebris(debris: Slab[], view: THREE.Camera): Slab[] {
  const target = scaledCount(debris.length, Math.min(debris.length, Math.round(DEBRIS_FLOOR * debris.length / DEBRIS_DEFAULT)), 'length');
  if (target >= debris.length) return debris;
  const keep = target / debris.length;
  return debris.filter((s, i) => evenlyKept(i, keep) && pageExtent(view, s).size >= MIN_FEATURE);
}

/** The moon in its form, the towers in theirs, and the road: the card's world, as `moonWorld` lays it out. */
export interface MoonWorld {
  /** The world camera it was laid out with (`worldCamera`), and the bank on tabloid's sheet. */
  view: THREE.PerspectiveCamera;
  shore: (x: number) => number;
  land: Moonscape;
  moonForm: 'broken' | 'station' | 'crescent';
  moon: Crescent | null; base: Station | null; shards: Broken | null;
  towerForm: TowerForm;
  set: TowerSet;
  /** The courses of the tower that is only in the water whose image begins below the waterline (upright, as `land.extra`). */
  extra: Slab[];
  road: RoadPlan;
}

/**
 * The card's world: the bank, the towers that stand and the city in the pool, the moon, the howl (or the column) it
 * calls up, and the road. It is laid out in tabloid's frame, with `worldCamera` and tabloid's page millimetres, so every
 * size and fit builds the same world, to the bit; each card's own camera then draws it.
 */
export function moonWorld(ctx: SketchContext): MoonWorld {
  const view = worldCamera(ctx);
  const eye = view.position;
  const f = focalOf(view, TABLOID_PAGE);
  const land = moonscape(ctx, view);
  const { shore } = land;
  const road = roadPlan(ctx, view, shore, EYE);
  // The moon: broken and pierced (the default), a station built into a moon, or, as first drawn, a crescent of slabs.
  const moonForm = ctx.params.moonForm === 'crescent' || ctx.params.moonForm === 'station' ? ctx.params.moonForm : 'broken';
  const moon = moonForm === 'crescent' ? crescent(ctx, view, f) : null;
  const base = moonForm === 'station' ? station(ctx, view, f) : null;
  const shards = moonForm === 'broken' ? broken(ctx, view, f) : null;
  // The towers as they stand, the howl (the wolf torn toward the broken moon, the dog staked by its volley) or the
  // column (its later reading), the last two lit by the moon's own sun.
  const towerForm: TowerForm = ctx.params.towerForm === 'stack' ? 'stack' : ctx.params.towerForm === 'column' ? 'column' : 'howl';
  const moonMark = shards ? { page: pageOf(view, shards.centre, TABLOID_PAGE), radius: shards.radius * f / eye.distanceTo(shards.centre) * 1.3, volley: shards.piercers } : undefined;
  const set = towerVariant(ctx, towerForm, land.near, land.far, view, moonMark);
  // The tower that is only in the water: its lowest courses are left out where the bank would cut them, so its image begins clean below the waterline.
  const extra = land.extra.filter(sl => pageOf(view, new THREE.Vector3(sl.x, -(sl.y - sl.h / 2), sl.z - sl.d * 0.55), TABLOID_PAGE).y
    > shore(pageOf(view, new THREE.Vector3(sl.x, 0, sl.z), TABLOID_PAGE).x) + 1);
  return { view, shore, land, moonForm, moon, base, shards, towerForm, set, extra, road };
}

/** Clip the line o + s·dir to |x·U| ≤ a, |x·V| ≤ b in face coordinates. */
function clipRect(ox: number, oy: number, dx: number, dy: number, a: number, b: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [o, d, h] of [[ox, dx, a], [oy, dy, b]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(o) > h) return null; continue; }
    const t0 = (-h - o) / d, t1 = (h - o) / d;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/**
 * A slab hatched by the moonlight and nothing else: its outline always; then, on each upright face that looks at
 * the eye and that the light leaves darker than `CALM`, one plain parallel hatch from edge to edge. Paler
 * faces stay open paper. No contour rings and no inset frame, all in carbon. `pitch` scales the spacing
 * (1 is the kit's, tuned to the Tower's depth).
 */
function plainFacets(sl: Slab, light: THREE.Vector3, eye: THREE.Vector3, pitch: number, allFaces = false, bright = Infinity, view?: THREE.Camera): FacetStroke[] {
  // Off tabloid, with the card's camera, the outline is trimmed (kit/slabs.ts): no back edges, slivers folded into it.
  const out: FacetStroke[] = facetStrokes(sl, light, eye, true, 1, view && { view }).map(st => ({ ...st, ink: 'carbon' as const }));
  const m = slabMatrix(sl);
  const rot = new THREE.Matrix4().extractRotation(m);
  const hx = sl.w / 2, hy = sl.h / 2, hz = sl.d / 2;
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0, 0, hz), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, 0, hz), new THREE.Vector3(0, hy, 0)],
  ];
  // A block that can be turned any way (the moon's station) shows its back, top or underside too.
  if (allFaces) faces.push(
    [new THREE.Vector3(0, 0, -hz), new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz)],
    [new THREE.Vector3(0, -hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, hz)],
  );
  for (const [c0, U0, V0] of faces) {
    const normal = c0.clone().normalize().applyMatrix4(rot);
    const centre = c0.clone().applyMatrix4(m).addScaledVector(normal, 0.006);
    if (eye.clone().sub(centre).dot(normal) <= 0) continue;
    // A face turned to the sun by more than `bright` is bare paper (when given); otherwise paler faces stay open.
    if (normal.dot(light) > bright) continue;
    const dark = faceDarkness(normal, light, sl.tone);
    if (dark < CALM) continue;
    const a = U0.length(), b = V0.length();
    const U = U0.clone().normalize().applyMatrix4(rot), V = V0.clone().normalize().applyMatrix4(rot);
    const at = (u: number, v: number) => centre.clone().addScaledVector(U, u).addScaledVector(V, v);
    const step = Math.max(0.072, 0.07 + 0.3 * (1 - dark) ** 1.5) * pitch;
    const dx = Math.cos(0.6), dy = Math.sin(0.6), nx = -dy, ny = dx;
    const reach = Math.hypot(a, b);
    for (let k = -reach + step / 2; k < reach; k += step) {
      const span = clipRect(nx * k, ny * k, dx, dy, a, b);
      if (!span) continue;
      out.push({ ink: 'carbon', group: 'system', family: 'hatch', points: [at(nx * k + dx * span[0], ny * k + dy * span[0]), at(nx * k + dx * span[1], ny * k + dy * span[1])] });
    }
  }
  return out;
}

export function drawMoon(ctx: SketchContext): Part[] {
  // The card's camera draws the world `moonWorld` laid out in tabloid's frame.
  const view = moonCamera(ctx);
  const eye = view.position.clone();
  const f = focalOf(view);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const K = EYE / 6;
  const world = moonWorld(ctx);
  const { land, moon, base, shards, towerForm, set, extra } = world;
  // The bank on this card's sheet.
  const shore = (x: number) => layoutY(world.shore(tabloidX(x)));
  const inPool = (p: Point) => p.y > shore(p.x) + tolerance(0.6);
  const road = roadStrokes(ctx, view, world.road);
  const nearT = set.near, farT = set.far;
  // The light on the towers as they stand: from the moon, high on the right and a little behind, so the faces turned
  // right stay pale and the faces turned to us fall dark. The howl and the column take the moon's sun instead.
  const light = towerForm === 'stack' ? new THREE.Vector3(0.7, 0.45, 0.05).normalize() : ((shards ?? base)?.light ?? new THREE.Vector3(-0.85, 0.3, 0).normalize());
  const lightM = new THREE.Vector3(light.x, -light.y, light.z);
  const hatch = n(ctx, 'hatch', 2.2, 1, 5);
  // Sunlit: every face turned to the sun is bare paper, so what shines (only ever reflected sunlight) shines against the night.
  const sunlit = ctx.params.sunlit !== false;
  const bright = sunlit ? n(ctx, 'sunlitEdge', 0.02, -0.2, 0.4) : Infinity;
  // Which towers shine: the column, all of them and their reflections; the howl, only the dog and its stakes (the
  // wolf keeps the hatch it was approved with); the stacks, none.
  const towerBright = towerForm === 'column' ? bright : Infinity;
  const dogBright = towerForm === 'stack' ? Infinity : bright;
  const strokes: Stroke[] = [];
  const standing = [...nearT, ...farT, ...set.spears];
  const isDog = new Set<Slab>([...farT, ...set.spears]);
  standing.forEach((sl, owner) => {
    const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
    for (const st of plainFacets(sl, light, eye, hatch * FACET_MM_PER_UNIT / mmPerUnit(pos), towerForm !== 'stack', isDog.has(sl) ? dogBright : towerBright, view)) {
      strokes.push({ ink: st.ink, group: 'tower', family: st.family, points: st.points, owner });
    }
  });
  const inWater = [...land.waterNear, ...land.waterFar, ...extra].map(mirrored);
  const echoes: Stroke[] = [];
  inWater.forEach((sl, owner) => {
    const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
    // The water keeps the edges and the same hatch, a little more open: a reflection is never as crisp as the thing.
    for (const st of plainFacets(sl, lightM, eye, hatch * 1.5 * FACET_MM_PER_UNIT / mmPerUnit(pos), false, towerBright, view)) {
      echoes.push({ ink: st.ink, group: 'mirror', family: st.family, points: st.points, owner });
    }
  });
  // The moon: the kit's raking-light hatch without its contour rings (they frame each face like a screen), so lit
  // faces stay open paper; the field in ultramarine, its darkest cross-hatch in carbon.
  const moonHatch = n(ctx, 'moonHatch', 1.1, 0.6, 4);
  const moonStrokes: Stroke[] = [];
  // A face seen nearly edge-on packs its hatch into a solid bead: those faces keep only their outline.
  const grazing = n(ctx, 'moonGrazing', 0.45, 0, 0.9);
  moon?.slabs.forEach((sl, owner) => {
    const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
    const m = slabMatrix(sl), inv = m.clone().invert(), rot = new THREE.Matrix4().extractRotation(m);
    const half = [sl.w / 2, sl.h / 2, sl.d / 2];
    const facing = (p: THREE.Vector3) => {
      const q = p.clone().applyMatrix4(inv).toArray();
      const k = [0, 1, 2].reduce((best, j) => Math.abs(q[j]) / half[j] > Math.abs(q[best]) / half[best] ? j : best, 0);
      const normal = new THREE.Vector3().setComponent(k, Math.sign(q[k])).applyMatrix4(rot);
      return normal.dot(eye.clone().sub(p).normalize());
    };
    for (const st of facetStrokes(sl, moon!.light, eye, false, moonHatch * FACET_MM_PER_UNIT / mmPerUnit(pos))) {
      if (st.family === 'hatch' && st.points.length > 2) continue;
      if (st.family === 'hatch' && facing(st.points[0].clone().lerp(st.points[1], 0.5)) < grazing) continue;
      moonStrokes.push({ ink: st.ink === 'violet' ? 'carbon' : st.ink, group: 'moon', family: st.family, points: st.points, owner });
    }
  });

  const standGeos = standing.map(slabGeometry);
  const waterGeos = inWater.map(slabGeometry);
  // The station's blocks, hatched by its sun like the towers (at the towers' spacing on the sheet), and the rock they are built into.
  const blocks = base ? [...base.spine, ...base.collar, ...base.dock, ...base.scatter] : shards ? [...shards.piercers, ...shownDebris(shards.debris, view)] : [];
  // The broken moon is further off: its hatch a little more open than the towers'.
  const blockHatch = shards ? hatch * n(ctx, 'brokenHatch', 1.25, 0.8, 2.5) : hatch;
  const sunlight = (base ?? shards)?.light ?? light;
  blocks.forEach((sl, owner) => {
    const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
    for (const st of plainFacets(sl, sunlight, eye, blockHatch * FACET_MM_PER_UNIT / mmPerUnit(pos), true, shards ? bright : Infinity, view)) {
      moonStrokes.push({ ink: st.ink, group: 'moon', family: st.family, points: st.points, owner });
    }
  });
  const blockGeos = blocks.map(slabGeometry);
  const moonGeos = moon ? moon.slabs.map(slabGeometry) : base ? [rockMesh(base), ...blockGeos] : [...brokenMeshes(shards!), ...blockGeos];
  // Each picture has its own depth range: the standing city, the city in the water, and the moon.
  const viewR = view.clone() as THREE.PerspectiveCamera;
  const viewM = view.clone() as THREE.PerspectiveCamera;
  const viewC = view.clone() as THREE.PerspectiveCamera;
  try {
    fitDepthRange(viewR, standGeos);
    fitDepthRange(viewM, waterGeos);
    fitDepthRange(viewC, moonGeos);
    const ground = set.ground ?? [];
    // Every hidden-line test runs `FINE` times finer each way than the card's raster (`fineDepth`): on a small card a
    // pixel of the card's own raster spans several times the world a tabloid pixel does, and the stakes, the volley and
    // the courses' edges fray. At tabloid it is the card's own raster.
    const fineR = fineDepth([...standGeos, ...ground], viewR, RASTER, FINE);
    const fineM = fineDepth(waterGeos, viewM, RASTER, FINE);
    const fineC = fineDepth(moonGeos, viewC, RASTER, FINE);
    // The rock's own lines are hidden only by the blocks built into it.
    const fineB = base ? fineDepth(blockGeos, viewC, RASTER, FINE) : fineC;
    const biasOf = (v: THREE.PerspectiveCamera, tol: number, d: number) => tol * v.far * v.near / ((v.far - v.near) * d * d);
    const slack = n(ctx, 'slabSlack', 0.5, 0.1, 2) * K;

    // The phrase: one word to a face. Five on the towers that stand, zigzagging down the card; the last two in the water, on the tower that is only there.
    const settings = sloganSettings(ctx);
    // Where the format sets the phrase in the band, the art carries no words.
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size };
    const wrng = ctx.random('moon-words');
    const visible = (lines3: THREE.Vector3[][], env: ProjectEnv, bias: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { ...env, bias }, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    // Where each word goes: which tower, and about how far down the sheet. The water's tower is read where its image falls.
    const nWords = words.length;
    // On the standing towers each word takes a share of the way down its tower; in the water, a height on the sheet.
    const nearShares = [0.1, 0.42, 0.86], farShares = [0.2, 0.68];
    let nearCount = 0, farCount = 0;
    const plan = words.map((word, i) => {
      const inTheWater = i >= nWords - 2;
      const side = inTheWater ? 'water' : i % 2 === 0 ? 'near' : 'far';
      const target = inTheWater ? layoutY(338 + 28 * (i - (nWords - 2))) : side === 'near' ? nearShares[nearCount++ % 3] : farShares[farCount++ % 2];
      return { word, side, target };
    });
    const textStrokes: THREE.Vector3[][] = [];
    const waterText: THREE.Vector3[][] = [];
    const used = new Set<Slab>();
    for (const { word, side, target } of plan) {
      const pool = side === 'near' ? set.words?.near ?? nearT : side === 'far' ? set.words?.far ?? farT : extra;
      const place = (sl: Slab) => {
        const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
        const m = slabMatrix(sl);
        const unit = 1 / mmPerUnit(pos);
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        if (ww > sl.w * 0.72 || hh > sl.h * 0.62) return null;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w * 0.78 - ww), y0 = hh / 2;
        return strokeText(word, 0, 0, style).map(path => path.map(q2 => new THREE.Vector3(x0 + q2.x * unit, y0 - q2.y * unit, sl.d / 2 + 0.03 * K).applyMatrix4(m)));
      };
      const all = pool.map(sl => ({ sl, at: pageOf(view, new THREE.Vector3(sl.x, side === 'water' ? -sl.y : sl.y, sl.z)) }));
      const top = Math.min(...all.map(c => c.at.y)), bottom = Math.max(...all.map(c => c.at.y));
      const goal = side === 'water' ? target : top + target * (bottom - top);
      const candidates = all.filter(({ sl }) => !used.has(sl))
        .filter(({ at }) => at.y > CARD.y0 + layoutLength(8) && at.y < CARD.y1 - layoutLength(8) && at.x > CARD.x0 + layoutLength(6) && at.x < CARD.x1 - layoutLength(6))
        .filter(({ at }) => side !== 'water' || at.y > shore(at.x) + layoutLength(5))
        .sort((a, b) => Math.abs(a.at.y - goal) - Math.abs(b.at.y - goal)).slice(0, 40);
      for (const { sl } of candidates) {
        const word3 = place(sl);
        if (!word3) continue;
        if (side === 'water') {
          const flipped = word3.map(l => l.map(mirrorPoint));
          if (!visible(flipped, fineM.env, biasOf(viewM, slack, eye.distanceTo(new THREE.Vector3(sl.x, -sl.y, sl.z))))) continue;
          waterText.push(...flipped);
        } else {
          if (!visible(word3, fineR.env, biasOf(viewR, slack, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))))) continue;
          textStrokes.push(...word3);
        }
        used.add(sl);
        break;
      }
    }

    const toPage = (lines3: THREE.Vector3[][], v: THREE.PerspectiveCamera): Point[][] => {
      const out: Point[][] = [];
      for (const l of projectPolylinesClipped(lines3, v, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
        out.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
      }
      return out;
    };
    const glyphPaths = toPage(textStrokes, viewR);
    const waterGlyphs = toPage(waterText, viewM);
    const onGlyph = glyphMask([...glyphPaths, ...waterGlyphs], halo(0.6));

    // The water: ripple bands, each shifted sideways by a small step that grows toward the viewer; the reflection
    // breaks into dashes only where it is roughest, low in the pool. The bands, their steps and the dashes are the
    // water's texture on paper: they keep their millimetres, so a small card has fewer bands, each its own roughness
    // from the print's draws (as many drawn as the print draws, or more on a card with more water).
    const rippleRng = ctx.random('moon-ripple');
    const bands = Math.max(Math.ceil((TABLOID_CARD.y1 - TABLOID_HORIZON_Y) / BAND), Math.ceil((CARD.y1 - HORIZON_Y) / BAND)) + 2;
    const rough = Array.from({ length: bands }, () => rippleRng());
    const sway = rippleRng() * Math.PI * 2;
    const ripple = n(ctx, 'ripple', 0.5, 0, 2.5);
    const bandOf = (y: number) => Math.max(0, Math.floor((y - HORIZON_Y) / BAND));
    const depthOf = (y: number) => clamp((y - HORIZON_Y) / (CARD.y1 - HORIZON_Y), 0, 1);
    const offsetOf = (b: number) => {
      const d = depthOf(HORIZON_Y + (b + 0.5) * BAND);
      return ripple * (0.1 + 1.1 * d * d) * (0.6 * Math.sin(b * 0.83 + sway) + 0.4 * (rough[b] * 2 - 1));
    };
    const gaps = restPattern(ctx.random('moon-gaps'), 0.9);
    const alive = (b: number, x: number) => {
      const d = depthOf(HORIZON_Y + (b + 0.5) * BAND);
      if (d < 0.7) return true;
      return gaps[((Math.floor(x / 3.4) + b * 7) % 64 + 64) % 64];
    };
    const rippled = (path: Point[], whole: boolean): Point[][] => {
      const out: Point[][] = [];
      let run: Point[] = [];
      let band = NaN;
      const flush = () => { if (run.length > 1) out.push(run); run = []; };
      for (const p of densify(path, 0.5)) {
        const b = bandOf(p.y);
        if (b !== band) { flush(); band = b; }
        if (!whole && !alive(b, p.x)) { flush(); continue; }
        run.push({ x: p.x + offsetOf(b), y: p.y });
      }
      flush();
      return out;
    };

    // Paths are reduced at the card's scale (`reduceAtScale`): at tabloid's stride the road's ribbons, the shore and the
    // moon's limb turn into polygons on a small card. Off tabloid, a scrap of a face's hatch shorter than the smallest
    // feature is a speck, and dropped (`hatchMin`).
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    const addTo = (key: string, run: Point[], keep: (p: Point) => boolean, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && keep(p), 0.15)) buckets.add(key, piece, false, min);
    };

    // The towers that stand, a slab at a time with slack in world units at its own distance.
    const bySlab = new Map<number, Stroke[]>();
    for (const st of strokes) bySlab.set(st.owner!, [...(bySlab.get(st.owner!) ?? []), st]);
    for (const [i, mine] of bySlab) {
      const sl = standing[i];
      projectStrokes(mine, { ...fineR.env, bias: biasOf(viewR, slack, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, {
        begin: st => runs => { for (const run of runs) addTo(`${st.group}-${st.ink}`, scalePoints(run, fineR.mmX, fineR.mmY), () => true, hatchMin(st.family)); },
      });
    }
    // The road: tested against the towers only (a ribbon lying flat cannot hide itself), on the land only. It runs
    // far past the towers, so it gets their depth again over its own range.
    const viewT = view.clone() as THREE.PerspectiveCamera;
    viewT.near = viewR.near;
    viewT.far = 1.2 * Math.max(...road.flatMap(st => st.points.map(p => eye.z - p.z)));
    viewT.updateProjectionMatrix();
    const fineT = fineDepth([...standGeos, ...ground], viewT, RASTER, FINE);
    projectStrokes(road, { ...fineT.env, bias: biasOf(viewT, slack, 200) }, {
      begin: st => runs => { for (const run of runs) addTo(`helix-${st.ink}`, scalePoints(run, fineT.mmX, fineT.mmY), p => p.y < shore(p.x) - 0.2); },
    });
    // The city in the water: the same hatch, upside down, inside the pool only, rippled band by band.
    const echoBySlab = new Map<number, Stroke[]>();
    for (const st of echoes) echoBySlab.set(st.owner!, [...(echoBySlab.get(st.owner!) ?? []), st]);
    for (const [i, mine] of echoBySlab) {
      const sl = inWater[i];
      projectStrokes(mine, { ...fineM.env, bias: biasOf(viewM, slack, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, {
        begin: st => runs => {
          for (const run of runs) for (const inside of clipWindow(scalePoints(run, fineM.mmX, fineM.mmY))) {
            for (const piece of keepAlong(inside, p => !onGlyph(p) && inPool(p), 0.15)) {
              for (const r of rippled(piece, false)) buckets.add(`${st.group}-${st.ink}`, r, false, hatchMin(st.family));
            }
          }
        },
      });
    }
    // The moon, a slab at a time, with slack in proportion to its slabs. Hatch on a face seen nearly edge-on
    // comes out as a bead of ticks: hatch shorter than `moonTick` is left out.
    const tick = n(ctx, 'moonTick', 1.2, 0.4, 3);
    // Nothing of the moon draws over a tower (a tower that rises into its sky stands in front of it).
    const solids = meshCoverage(standGeos, viewR, PAGE, halo(n(ctx, 'knockout', 1.1, 0.3, 3)), MASK_RES);
    const moonBySlab = new Map<number, Stroke[]>();
    for (const st of moonStrokes) moonBySlab.set(st.owner!, [...(moonBySlab.get(st.owner!) ?? []), st]);
    const blockEdges: Point[][] = [];
    for (const [i, mine] of moonBySlab) {
      const sl = moon ? moon.slabs[i] : blocks[i];
      const least = Math.min(sl.w, sl.h, sl.d);
      const tol = moon ? 0.25 * sl.d : n(ctx, 'stationSlack', 0.3, 0.05, 1) * least;
      // Off tabloid a block's outline is trimmed (no back edges, its slivers folded in), so what is left is its silhouette
      // and the edges between faces that see the eye: none hidden by the block itself. A sliver seen nearly edge-on hides
      // the silhouette edge behind it from a test as fine as the print's, so the outline is tested with a block's
      // thickness of slack; the hatch keeps the block's own.
      const passes: [Stroke[], number][] = FORMAT.tabloid || moon ? [[mine, tol]]
        : [[mine.filter(st => st.family === 'edge'), Math.max(tol, 2 * least)], [mine.filter(st => st.family !== 'edge'), tol]];
      for (const [list, slackHere] of passes) projectStrokes(list, { ...fineC.env, bias: biasOf(viewC, slackHere, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, {
        begin: st => runs => {
          for (const run of runs) for (const inside of clipWindow(scalePoints(run, fineC.mmX, fineC.mmY))) {
            if (st.family === 'edge') blockEdges.push(inside);
            for (const piece of keepAlong(inside, p => !onGlyph(p) && !solids(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && moon ? tick : hatchMin(st.family));
          }
        },
      });
    }
    if (shards) {
      // The broken rock: field lines square to the first slab, evenly spaced on the sheet, every line over the night
      // side and dropping out by halves across the lit side. Each piece carries its own lines, turned and drifted with
      // it, so a line breaks where it crosses a crack. Each crack's rim is drawn on both its pieces, and the limb. The
      // field lines keep their spacing on paper (fewer on a small card); the paper round the blocks is a halo.
      const clear = glyphMask(blockEdges, halo(n(ctx, 'rockClear', 0.45, 0.2, 2)));
      const rmm = shards.radius * f / eye.distanceTo(shards.centre);
      const step = tolerance(n(ctx, 'brokenPitch', 0.75, 0.4, 1.5)) / rmm;
      // Sunlit, the lit half carries no field lines at all: they stop at the terminator, thinning only just before it.
      const open = sunlit ? [0.03, 0.01, -0.01, -0.04] : [0.62, 0.42, 0.22, 0.06];
      const mare = sunlit ? 0 : n(ctx, 'rockMare', 0.32, 0, 0.8);
      const lines3: THREE.Vector3[][] = [];
      const shown = (p: THREE.Vector3, normal: THREE.Vector3) => eye.clone().sub(p).dot(normal) > 0;
      const trace = (dirs: THREE.Vector3[], keep: (dir: THREE.Vector3, normal: THREE.Vector3) => boolean, keyOf = (d: THREE.Vector3) => shards.pieceOf(d), proud = 0.004, facing = true) => {
        let run: THREE.Vector3[] = [], last = -1;
        const flush = () => { if (run.length > 1) lines3.push(run); run = []; };
        for (const dir of dirs) {
          const key = keyOf(dir);
          if (key !== last) { flush(); last = key; }
          const normal = brokenNormal(shards, dir, key), p = brokenPoint(shards, dir, proud, key);
          if ((facing && !shown(p, normal)) || !keep(dir, normal)) { flush(); continue; }
          run.push(p);
        }
        flush();
      };
      let k = 0;
      for (let sv = -1 + step / 2; sv < 1; sv += step, k++) {
        const c = Math.sqrt(1 - sv * sv);
        const tier = k % 8 === 0 ? 0 : k % 4 === 0 ? 1 : k % 2 === 0 ? 2 : 3;
        const dirs = Array.from({ length: 541 }, (_, i) => {
          const th = i / 540 * Math.PI * 2;
          return shards.axis.clone().multiplyScalar(sv).addScaledVector(shards.b1, c * Math.cos(th)).addScaledVector(shards.b2, c * Math.sin(th));
        });
        trace(dirs, (dir, normal) => normal.dot(shards.light) <= open[tier] + mare * shards.ground(dir));
      }
      // The limb, and each crack's rim on either side of it.
      const zc = shards.toEye, xc = new THREE.Vector3(0, 1, 0).cross(zc).normalize(), yc = zc.clone().cross(xc);
      // The limb is where the eye's rays graze the rock: a little toward the eye of the rock's middle.
      const graze = shards.radius / eye.distanceTo(shards.centre);
      trace(Array.from({ length: 721 }, (_, i) => zc.clone().multiplyScalar(graze).addScaledVector(xc, Math.sqrt(1 - graze * graze) * Math.cos(i / 720 * Math.PI * 2)).addScaledVector(yc, Math.sqrt(1 - graze * graze) * Math.sin(i / 720 * Math.PI * 2))), () => true, undefined, 0.001, false);
      for (const crack of shards.cracks) {
        const e1 = crack.m.clone().cross(zc).normalize(), e2 = crack.m.clone().cross(e1).normalize();
        const r = Math.sqrt(Math.max(0, shards.radius ** 2 - crack.o ** 2));
        const ring = Array.from({ length: 721 }, (_, i) => {
          const th = i / 720 * Math.PI * 2;
          return crack.m.clone().multiplyScalar(crack.o).addScaledVector(e1, r * Math.cos(th)).addScaledVector(e2, r * Math.sin(th));
        });
        for (const side of [1, -1]) {
          const nudge = crack.m.clone().multiplyScalar(side * 0.02 * shards.radius);
          trace(ring.map(q => q.clone().normalize()), () => true, d => shards.pieceOf(d.clone().multiplyScalar(shards.surface(d)).add(nudge).normalize()), 0.002);
        }
      }
      projectStrokes(lines3.map(points => ({ points })), { ...fineC.env, bias: biasOf(viewC, 0.02 * shards.radius, eye.distanceTo(shards.centre)) }, {
        begin: () => runs => { for (const run of runs) addTo('rock-carbon', scalePoints(run, fineC.mmX, fineC.mmY), p => !clear(p) && !solids(p)); },
      });
    }
    if (base) {
      // The rock: field lines wrapping it square to the spine, evenly spaced on the sheet. Over the night side every
      // line runs; across the lit side they drop out by halves as the sun climbs, so the lit limb is open paper.
      // A hair of paper is kept round every block edge.
      const clear = glyphMask(blockEdges, halo(n(ctx, 'rockClear', 0.45, 0.2, 2)));
      const rmm = base.radius * f / eye.distanceTo(base.centre);
      const step = tolerance(n(ctx, 'rockPitch', 0.62, 0.4, 1.5)) / rmm;
      const open = [0.62, 0.42, 0.22, 0.06];
      const mare = n(ctx, 'rockMare', 0.32, 0, 0.8);
      const lines3: { pts: THREE.Vector3[] }[] = [];
      const facingEye = (p: THREE.Vector3, dir: THREE.Vector3) => eye.clone().sub(p).dot(dir) > 0;
      let k = 0;
      for (let sv = -1 + step / 2; sv < 1; sv += step, k++) {
        const c = Math.sqrt(1 - sv * sv);
        const tier = k % 8 === 0 ? 0 : k % 4 === 0 ? 1 : k % 2 === 0 ? 2 : 3;
        let run: THREE.Vector3[] = [];
        const flush = () => { if (run.length > 1) lines3.push({ pts: run }); run = []; };
        for (let i = 0; i <= 720; i++) {
          const th = i / 720 * Math.PI * 2;
          const dir = base.axis.clone().multiplyScalar(sv).addScaledVector(base.b1, c * Math.cos(th)).addScaledVector(base.b2, c * Math.sin(th));
          const p = onRock(base, dir);
          // Lines drop out as the sun climbs, later over the dark ground than the pale.
          if (!facingEye(p, dir) || dir.dot(base.light) > open[tier] + mare * base.ground(dir) || base.craters.some(c => c.dir.angleTo(dir) < c.size)) { flush(); continue; }
          run.push(p);
        }
        flush();
      }
      // The limb, all the way round.
      const limb: THREE.Vector3[] = [];
      const [lx, ly] = [new THREE.Vector3(0, 1, 0).cross(base.toEye).normalize(), base.toEye.clone().cross(new THREE.Vector3(0, 1, 0).cross(base.toEye).normalize())];
      for (let i = 0; i <= 720; i++) {
        const th = i / 720 * Math.PI * 2;
        limb.push(onRock(base, lx.clone().multiplyScalar(Math.cos(th)).addScaledVector(ly, Math.sin(th)), 0.001));
      }
      lines3.push({ pts: limb });
      // Each crater: its rim, and a shadow ruled across the inside of the rim nearest the sun (the bowl's sunward wall is in shade).
      for (const c of base.craters) {
        const [c1, c2] = [base.b1.clone().addScaledVector(c.dir, -base.b1.dot(c.dir)).normalize(), new THREE.Vector3()];
        c2.crossVectors(c.dir, c1);
        const rimAt = (a: number, r: number) => c.dir.clone().multiplyScalar(Math.cos(r)).addScaledVector(c1, Math.sin(r) * Math.cos(a)).addScaledVector(c2, Math.sin(r) * Math.sin(a)).normalize();
        lines3.push({ pts: Array.from({ length: 97 }, (_, i) => onRock(base, rimAt(i / 96 * Math.PI * 2, c.size))) });
        const sun = base.light.clone().addScaledVector(c.dir, -base.light.dot(c.dir)).normalize();
        const sunA = Math.atan2(sun.dot(c2), sun.dot(c1));
        for (let j = 1; j < 6; j++) {
          const r = c.size * (1 - j * 0.16);
          lines3.push({ pts: Array.from({ length: 25 }, (_, i) => onRock(base, rimAt(sunA - 1.1 + 2.2 * i / 24, r), 0.002)) });
        }
      }
      projectStrokes(lines3.map(l => ({ points: l.pts })), { ...fineB.env, bias: biasOf(viewC, 0.01 * base.radius, eye.distanceTo(base.centre)) }, {
        begin: () => runs => { for (const run of runs) addTo('rock-carbon', scalePoints(run, fineB.mmX, fineB.mmY), p => !clear(p) && !solids(p)); },
      });
    }

    // The water ruling, knocked out where the reflection stands (and put back where the ripple breaks it). Its pitch
    // holds on paper.
    const coverM = meshCoverage(waterGeos, viewM, PAGE, halo(0.5), MASK_RES);
    const pitch = tolerance(n(ctx, 'waterPitch', 1.25, 0.55, 2));
    for (let y = HORIZON_Y + 1, i = 0; y < CARD.y1 - 0.3; i++) {
      const t = depthOf(y), b = bandOf(y);
      const off = offsetOf(b);
      const ink = i % 7 === 0 ? 'ultramarine' : 'carbon';
      addTo(`water-${ink}`, [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => inPool(p) && !(coverM({ x: p.x - off, y: p.y }) && alive(b, p.x)));
      y += pitch * (1 + 0.9 * t ** 1.2);
    }
    // The words in the water take the same ripple as the hatch round them.
    for (const path of waterGlyphs) for (const r of rippled(path, true)) buckets.add('slogan-lettering', r, true);

    // The night: a ruling, full lines at the top, opening by halves as it comes down and breaking into dashes low in
    // the sky, which thin toward the horizon; knocked out round the towers, and with a halo of paper round the moon.
    // The broken moon knocks the sky out only where a piece's near face or a block stands. Through a gap that looks
    // into a piece from behind its near face, the eye meets that piece's broken side: it is ruled as dark rock. Through
    // every other gap the sky's ruling runs on, as sky seen through the broken moon. The ruling keeps its pitch on paper;
    // the halos scale with the card (`halo`).
    const shells = shards ? moonGeos.slice(0, moonGeos.length - blockGeos.length) : [];
    const skyCover = shards ? [...frontOf(shells, eye), ...blockGeos] : moonGeos;
    const shine = meshCoverage(skyCover, viewC, PAGE, halo(shards ? n(ctx, 'brokenHalo', 0.8, 0.3, 4) * (sunlit ? 1.5 : 1) : n(ctx, 'moonHalo', 2.6, 0.5, 6)), MASK_RES);
    const fronts = shards ? meshCoverage(skyCover, viewC, PAGE, 0, MASK_RES) : () => false;
    const anyShell = shards ? meshCoverage(shells, viewC, PAGE, 0, MASK_RES) : () => false;
    const inside = (p: Point) => anyShell(p) && !fronts(p);
    if (shards) {
      const c = pageOf(view, shards.centre), r = shards.radius * f / eye.distanceTo(shards.centre) * 1.6;
      const ang = THREE.MathUtils.degToRad(n(ctx, 'brokenSideAngle', 52, -90, 90)), pitchB = tolerance(n(ctx, 'brokenSidePitch', 0.6, 0.3, 1.5));
      const dx = Math.cos(ang), dy = Math.sin(ang);
      for (let o = -r; o <= r; o += pitchB) {
        const line = [{ x: c.x - dy * o - dx * r, y: c.y + dx * o - dy * r }, { x: c.x - dy * o + dx * r, y: c.y + dx * o + dy * r }];
        addTo('rock-carbon', line, p => inside(p) && !shine(p) && !solids(p));
      }
    }
    const skyRng = ctx.random('moon-sky');
    const cells = Array.from({ length: 64 }, () => skyRng());
    const night = n(ctx, 'night', 1, 0, 1.5);
    const reach = [0.93, 0.66, 0.42, 0.1].map((r, k) => k === 0 ? r : r * night);
    // Sunlit, the night deepens round the broken moon (the ruling's finer tiers run on there, feathered), so its
    // paper face shines against it.
    const nightRng = ctx.random('moon-sky-night');
    const nightCells = Array.from({ length: 64 }, () => nightRng());
    const deepen = sunlit && shards ? n(ctx, 'nightDeepen', 1, 0, 2) : 0;
    const sources: { c: Point; r: number }[] = [];
    if (deepen > 0 && shards) {
      sources.push({ c: pageOf(view, shards.centre), r: layoutLength(48 * deepen) });
    }
    const zone = (p: Point) => { let sum = 0; for (const src of sources) sum += Math.exp(-((p.x - src.c.x) ** 2 + (p.y - src.c.y) ** 2) / (src.r * src.r)); return Math.min(1, sum); };
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    for (let y = skyTop + tolerance(0.3), i = 0; y < skyBottom; i++, y += tolerance(0.62)) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
      if (!(t < reach[tier])) {
        if (!sources.length || tier === 0) continue;
        const need = tier === 1 ? 0.3 : tier === 2 ? 0.55 : Infinity;
        const shiftN = Math.floor(nightRng() * 64);
        addTo(tier === 1 ? 'sky-ultramarine' : 'sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
          p => !solids(p) && !shine(p) && !inside(p) && zone(p) > need + 0.12 * nightCells[(Math.floor((p.x - CARD.x0) / 4.6) + shiftN) % 64]);
        continue;
      }
      // Below the solid ruling each line is cut in cells of seeded length, fewer kept the nearer the horizon.
      const keep = t < 0.64 ? 1 : 0.92 - 0.6 * (t - 0.64) / 0.3;
      const shift = Math.floor(skyRng() * 64);
      addTo(tier === 1 ? 'sky-ultramarine' : 'sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => !solids(p) && !shine(p) && !inside(p) && (keep >= 1 || cells[(Math.floor((p.x - CARD.x0) / 4.6) + shift) % 64] < keep));
    }

    // The crescent's unlit rest of the disc: a faint dashed rim, from horn to horn the long way round.
    if (moon) {
      const edge = meshCoverage(moonGeos, viewC, PAGE, halo(1.2), MASK_RES);
      const rim: Point[] = Array.from({ length: 241 }, (_, k) => {
        const a = moon.bulge + moon.horns * 0.9 + k / 240 * (2 * Math.PI - 1.8 * moon.horns);
        return pageOf(view, rimPoint(moon, a));
      });
      for (const piece of keepAlong(rim, (p, at) => !edge(p) && at % 3.4 < 1.3, 0.15)) buckets.add('moon-ultramarine', piece);
    }

    // The shore, and the horizon where nothing stands on it.
    const shoreLine: Point[] = Array.from({ length: 123 }, (_, i) => {
      const x = CARD.x0 + (CARD.x1 - CARD.x0) * i / 122;
      return { x, y: shore(x) };
    });
    buckets.add('water-carbon', shoreLine);

    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'rock', 'moon', 'tower', 'mirror', 'water', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('XVIII', 'THE MOON', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of [...standGeos, ...waterGeos, ...moonGeos, ...(set.ground ?? [])]) geo.dispose();
  }
}
