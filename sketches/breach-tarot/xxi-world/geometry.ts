import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, MIN_SPACING, PAGE, PHRASE, TABLOID_CARD, TABLOID_RASTER, depthRaster, evenlyKept, fitFov, halo, layoutLength, layoutY, maskRes, printFine, scaledCount, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong, type AlongOptions, type HelixStroke } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { boltEmblem, discEmblem, starEmblem, sunEmblem } from '../../kit/emblems.ts';
import { circlePath, discHatch } from '../../kit/fills.ts';
import { thinRanked } from '../../kit/density.ts';
import { keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { atPage, fitDepthRange, onGround, pageOf, type PageSize } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { bigSuit, bigSuitMeshes, bigSuitStrokes, type BigSuit } from '../../kit/mannequin/big-suit.ts';
import { bodyMeshes, contourTube, type Body } from '../../kit/mannequin/body.ts';
import { ELONGATED, flowBody, gesture } from '../../kit/mannequin/gesture.ts';
import { LOOK } from '../../kit/mannequin/hatch.ts';
import { grip } from '../../kit/mannequin/pieces.ts';
import { POSES, poseSkeleton, withPose, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { silhouettes, type ClothStroke, type Tube } from '../../kit/mannequin/tube.ts';
import { CARD, cardFrame, clipWindow } from '../card.ts';
import { chartresPlan, type P2, type Plan } from './labyrinth.ts';

/**
 * XXI The World: and now it all fits. The Fool's maze, solved: a maze offers choices, a labyrinth has
 * only one path. The Chartres labyrinth, built from the Fool's own blocks, knee high and whole, the
 * only card where nothing is falling; a last few blocks still hang just above the gaps they are
 * about to close. It is the one card seen from above, off the deck's shared horizon: the view
 * finally rises and the whole pattern shows.
 *
 * At the centre the Fool has arrived, enlightened: he has grown into his suit, the same cut as card
 * 0 now fitted, and the construction cross on his blank face is drawn solid. The light is his, a
 * glow above his head, so every wall throws its shadow outward and the card runs from a bright
 * centre to a dark rim; the walls round him are washed out to a few indicated lines, and brick
 * detail gathers where his light falls off. His tie is the helix, climbing out of the centre and
 * flaring as it rises, with clear paper round it. The phrase is cut into the near walls, a word to a
 * ring, read walking inward; the first set's four marks keep the old card's four corners.
 *
 * On a small card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`worldOf`): the same walls,
 * the same blocks settling, the same tie, and the same choice of where the print draws every brick. The card's own
 * camera is the print's scaled with the card (`cardCamera`). A wall a millimetre deep on paper cannot carry its
 * courses: each is drawn as one line along its crest, broken under a settling coping, and the print's brick detail
 * becomes the joints of its first course down the wall's face, a share of them, where the print draws its bricks;
 * the rim's blocks and the settling copings are trimmed outlines. The shadows keep their pitch on paper, the
 * knockouts scale with the card, the corner marks keep their corners, and the phrase moves to the bottom band.
 */
/** How many times finer than the card's raster its depth pass runs: 1 at tabloid. */
const FINE = printFine();
/** The card's depth raster at tabloid; on any other page, the format's, with room for `FINE`. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, FINE);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** Circuit pitch (path plus wall), and the masonry, in the Fool's block sizes. */
const PITCH = 10, THICK = 2.0, COURSE = 2.2, COPING = 0.6;
/** The innermost ring wall a word is cut into (wall 10 lies between circuits 10 and 11). */
const CIRCUITS_INNER = 10;
const FACET_MM_PER_UNIT = 8.3;
/** The fewest joints a small card keeps, so the masonry still shows where the print draws it. */
const JOINT_FLOOR = 60;

export interface WorldView { view: THREE.PerspectiveCamera; centre: THREE.Vector3 }

/** The framing, in tabloid's frame: the lens, the distance that spans the rim across the card, and where the centre lands. */
function framing(ctx: SketchContext, plan: Plan): { fov: number; dist: number; cy: number } {
  const rim = plan.wall(0) + PITCH;
  const fov = n(ctx, 'fov', 45, 25, 75);
  const f = TABLOID_PAGE.height / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  const dist = f * rim / (n(ctx, 'fit', 0.94, 0.6, 1.05) * (TABLOID_CARD.x1 - TABLOID_CARD.x0) / 2);
  const cy = TABLOID_CARD.y0 + n(ctx, 'centreY', 0.64, 0.3, 0.85) * (TABLOID_CARD.y1 - TABLOID_CARD.y0);
  return { fov, dist, cy };
}

/** Above the labyrinth, `dist` from its centre, looking down at `tilt`, the centre landing at page y `cy`. */
function overhead(ctx: SketchContext, fov: number, dist: number, cy: number, page: PageSize, raster: { width: number; height: number }): WorldView {
  const tilt = THREE.MathUtils.degToRad(n(ctx, 'tilt', 40, 20, 90));
  const centre = new THREE.Vector3(0, 0, -dist);
  // A loose depth range for now: drawWorld fits it to the scene before the depth pass.
  const view = new THREE.PerspectiveCamera(fov, raster.width / raster.height, 2, 6000);
  view.position.set(0, dist * Math.sin(tilt), -dist + dist * Math.cos(tilt));
  view.lookAt(centre);
  view.setViewOffset(raster.width, raster.height, 0, -(cy - page.height / 2) / (page.height / raster.height), raster.width, raster.height);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return { view, centre };
}

/**
 * Above the labyrinth, looking down at `tilt`, sized so the rim spans the card and centred where wanted: in tabloid's
 * frame (its page, card and raster), the camera the world is laid out with. At tabloid it is `cardCamera`.
 */
export function worldCamera(ctx: SketchContext, plan: Plan): WorldView {
  const { fov, dist, cy } = framing(ctx, plan);
  return overhead(ctx, fov, dist, cy, TABLOID_PAGE, TABLOID_RASTER);
}

/**
 * The card's own camera, on the format's page: the print's eye and aim, its lens widened with the fit (`fitFov`) and its
 * centre placed as a layout position (`layoutY`), so the card is the print scaled by `S` about the window's centre line
 * and the horizon. `height` keeps the print's vertical framing and crops the rim's sides; `width` keeps the whole rim.
 */
export function cardCamera(ctx: SketchContext, plan: Plan): WorldView {
  const { fov, dist, cy } = framing(ctx, plan);
  return overhead(ctx, fitFov(fov), dist, layoutY(cy), PAGE, { width: W, height: H });
}

/** Plan to world: the plan's +Y (the entrance side) faces the eye. */
const toWorld = (c: THREE.Vector3, p: P2, y = 0) => new THREE.Vector3(c.x + p.x, y, c.z + p.y);

/** The point at arc length `s` along a plan polyline. */
function along(path: P2[], cum: number[], s: number): P2 {
  let i = 1;
  while (i < path.length - 1 && cum[i] < s) i++;
  const a = path[i - 1], b = path[i];
  const t = clamp((s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]), 0, 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * One wall: courses of blocks laid along its centreline in running bond, under a coping, each block
 * turned to the wall's line where it sits.
 */
export function wallSlabs(rng: () => number, c: THREE.Vector3, path: P2[], courses: number): Slab[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const total = cum[cum.length - 1];
  const out: Slab[] = [];
  const lay = (s0: number, s1: number, y: number, h: number, d: number, role: Slab['role']) => {
    const a = along(path, cum, s0), b = along(path, cum, s1), mid = along(path, cum, (s0 + s1) / 2);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.4) return;
    const w = toWorld(c, mid, y);
    const sl = solid(w.x, w.y, w.z, len, h, d, out.length, role);
    sl.ry = Math.atan2(-(b.y - a.y), b.x - a.x);
    out.push(sl);
  };
  for (let k = 0; k < courses; k++) {
    let s = 0;
    // Running bond: every other course starts on a half block.
    if (k % 2 === 1) { const first = Math.min(total, 1.6 + 1.6 * rng()); lay(0, first - 0.06, COURSE * (k + 0.5), COURSE - 0.1, THICK, 'stack'); s = first; }
    while (s < total - 0.3) {
      const len = Math.min(total - s, 3.4 + 3.2 * rng());
      lay(s + 0.06, s + len - 0.06, COURSE * (k + 0.5), COURSE - 0.1, THICK, 'stack');
      s += len;
    }
  }
  for (let s = 0; s < total - 0.2; s += 7) lay(s, Math.min(total, s + 7), courses * COURSE + COPING / 2, COPING, THICK + 0.5, 'pier');
  return out;
}

/** The rim's lunations: a ring of small blocks round the outside, the labyrinth's wreath, broken only at the entrance. */
function lunations(c: THREE.Vector3, plan: Plan): Slab[] {
  const out: Slab[] = [];
  const r = plan.wall(0) + 0.55 * PITCH;
  const count = 112;
  for (let i = 0; i < count; i++) {
    const a = (i + 0.5) / count * Math.PI * 2;
    const x = r * Math.cos(a), y = r * Math.sin(a);
    if (y > 0 && Math.abs(x + PITCH / 2) < PITCH * 0.75) continue;
    const w = toWorld(c, { x, y }, COURSE / 2);
    const sl = solid(w.x, w.y, w.z, 2 * Math.PI * r / count * 0.55, COURSE, 0.7 * PITCH, out.length, 'stack');
    sl.ry = Math.atan2(-Math.cos(a), -Math.sin(a));
    out.push(sl);
  }
  return out;
}

export type FigureMode = 'arrived' | 'fool' | 'dancer';

/**
 * The card's world: the labyrinth and its blocks, the last copings settling, the Fool at the centre, his light, his tie's
 * curve, and where the print draws every brick and where it only indicates the walls. It is laid out in tabloid's frame,
 * with `worldCamera` and tabloid's page millimetres, so every size and fit builds the same world, to the bit; each card's
 * own camera then draws it. The figure's and the helix's meshes are the caller's to dispose.
 */
export interface World {
  plan: Plan;
  /** The camera the world is laid out with (tabloid's frame). */
  camera: WorldView;
  centre: THREE.Vector3;
  courses: number;
  slabs: Slab[];
  /** The rim's lunations are `slabs[lunationStart]` on. */
  lunationStart: number;
  /** Each wall's plan path and the slabs it was built of, `slabs[from]` up to `to`. */
  walls: { path: P2[]; from: number; to: number }[];
  mode: FigureMode;
  height: number;
  skeleton: Skeleton;
  body: Body;
  suit: BigSuit | null;
  figureMeshes: THREE.BufferGeometry[];
  /** His light, a glow above his head. */
  glow: THREE.Vector3;
  /** His tie's curve, through the knot at his throat and up the card, and the helix laid along it. */
  curve: THREE.CatmullRomCurve3;
  helixOptions: AlongOptions;
  /** The helix as `worldCamera` draws it (the card's own at tabloid): its strokes and its meshes. */
  helix: { strokes: HelixStroke[]; meshes: THREE.BufferGeometry[] };
  /** The clear paper round the helix and the figure on tabloid's sheet. */
  helixCover: (p: Point) => boolean;
  figureCover: (p: Point) => boolean;
  /** How much brick detail the print draws at a point: 0 where it only indicates the walls, 1 where it draws every brick. */
  detailAt: (p: THREE.Vector3) => number;
  /** Whether the print draws a block (by its index in `slabs`). */
  drawn: (sl: Slab, index: number) => boolean;
}

export function worldOf(ctx: SketchContext): World {
  const plan = chartresPlan(PITCH);
  const camera = worldCamera(ctx, plan);
  const { view, centre } = camera;
  const eye = view.position.clone();
  const rng = ctx.random('world-walls');
  const courses = Math.round(n(ctx, 'courses', 2, 1, 4));

  const slabs: Slab[] = [];
  const walls: World['walls'] = [];
  for (const w of plan.walls) {
    const from = slabs.length;
    slabs.push(...wallSlabs(rng, centre, w, courses));
    walls.push({ path: w, from, to: slabs.length });
  }
  const lunationStart = slabs.length;
  slabs.push(...lunations(centre, plan));

  // At the centre, facing us: the Fool, arrived. He has grown into the suit: the same cut and
  // pinstripe as card 0, now fitted, and the construction cross on his blank face drawn solid at last.
  // He stands in the World's stance, one leg crossed behind, arms open, and his tie is the helix.
  // (Also: `fool`, the big suit as he started; `dancer`, a bare figure whose hand lets the helix go.)
  const mode: FigureMode = ctx.params.figure === 'fool' || ctx.params.figure === 'dancer' ? ctx.params.figure : 'arrived';
  const suited = mode !== 'dancer';
  const height = n(ctx, 'figureHeight', 56, 30, 90);
  const pose = withPose(gesture(POSES.dance, mode === 'arrived' ? { push: 1.0, arc: -4, sway: 5, wring: 8 } : { push: 1.2, arc: -8, sway: 6, wring: 14 }),
    suited ? { neck: { flex: -8 }, head: { flex: -4 } } : {}, { yaw: n(ctx, 'turn', 10, -90, 90) });
  const s = poseSkeleton(pose, { height, position: centre.clone(), proportions: { ...ELONGATED, ...(mode === 'arrived' ? { head: 1.0, neck: 1.5 } : suited ? { head: 0.72, neck: 1.9 } : { head: 0.8 }) } });
  const body = flowBody(s, { toes: suited ? 'curl' : 'point' });
  // The light is his: a glow just above his head, so every wall is lit on the side that faces the
  // centre and throws its shadow outward, longest at the rim.
  const glow = centre.clone().add(new THREE.Vector3(0, n(ctx, 'glow', 1.5, 1.05, 4) * height, 0));
  const suit = suited ? bigSuit(s, mode === 'fool' ? { size: 1.6, feet: body.limbs } : { size: n(ctx, 'suitSize', 1.05, 1, 1.6), feet: body.limbs, cuff: 0 }) : null;
  const figureMeshes = [...bodyMeshes(body, 0.8), ...(suit ? bigSuitMeshes(suit) : [])];

  // The helix: his tie, knotted at the throat, down his shirt front, then out past his shoulder and
  // up out of the centre in a lazy S to the top of the card, opening as it climbs. It keeps clear of
  // his face. Its course is set on tabloid's sheet.
  const k = height / 24;
  const knot = suited ? s.at('neck').lerp(s.at('head'), 0.55).addScaledVector(s.axes('neck').z, 0.55) : grip(s, 'r').at;
  const chest = s.axes('chest');
  const side = Math.sign(n(ctx, 'helixSway', 1, -1.5, 1.5)) || 1;
  const near: THREE.Vector3[] = suited
    ? [knot, knot.clone().addScaledVector(chest.z, 0.9 * k).addScaledVector(chest.y, -1.6 * k),
      knot.clone().addScaledVector(chest.z, 1.8 * k).addScaledVector(chest.x, side * 2.6 * k).addScaledVector(chest.y, -1.2 * k),
      knot.clone().addScaledVector(chest.z, 1.4 * k).addScaledVector(chest.x, side * 5.5 * k).addScaledVector(chest.y, 1.5 * k)]
    : [knot];
  const start = pageOf(view, knot, TABLOID_PAGE);
  const reach = eye.distanceTo(knot) * 0.9;
  const sway = n(ctx, 'helixSway', 1, -1.5, 1.5);
  const top = TABLOID_CARD.y0 - 12;
  const control = [[0.16, 30], [0.36, -18], [0.6, 22], [0.82, -12], [1, 4]] as const;
  const curvePts = [...near, ...control.map(([t, dx]) => atPage(view, { x: start.x + sway * dx, y: start.y + (top - start.y) * t }, reach, TABLOID_PAGE))];
  const curve = new THREE.CatmullRomCurve3(curvePts, false, 'centripetal');
  const helixOptions: AlongOptions = {
    radius: height / 24, width: height / 26, pitch: height * 0.4,
    taper: n(ctx, 'taper', 30, 1, 60), flare: n(ctx, 'flare', 2.2, 1, 5), pitchGrowth: n(ctx, 'pitchGrowth', 0.3, 0, 1),
  };
  const helix = helixAlong(ctx, view, curve, helixOptions);

  // Clear paper round the helix and round the figure, on tabloid's sheet: nothing behind them comes near their lines.
  const helixCover = meshCoverage(helix.meshes, view, TABLOID_PAGE, n(ctx, 'helixClear', 1.4, 0, 4));
  const figureCover = meshCoverage(figureMeshes, view, TABLOID_PAGE, n(ctx, 'figureClear', 1.7, 0.5, 6));

  // Where the walls are only indicated (see `drawn`): above `quietFrom` on the sheet, fading to full
  // detail by `quietTo`.
  const centrePage = pageOf(view, centre, TABLOID_PAGE);
  const quietFrom = centrePage.y + n(ctx, 'quietFrom', 12, -60, 100), quietTo = centrePage.y + n(ctx, 'quietTo', 48, -40, 140);
  const detailAt = (p: THREE.Vector3) => smooth(quietFrom, quietTo, pageOf(view, p, TABLOID_PAGE).y);
  // The last blocks, still settling: a few copings hang a little above the gaps they are about to
  // close. Their own random stream, so the walls never move with them.
  const settle = ctx.random('world-settle');
  const copings = slabs.filter(sl => sl.role === 'pier');
  const wanted = Math.round(n(ctx, 'settling', 6, 0, 24));
  for (let tries = 0, moved = 0; moved < wanted && tries < 400; tries++) {
    const sl = copings[Math.floor(settle() * copings.length)];
    const at = pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z), TABLOID_PAGE);
    // Somewhere it can be seen: on the near half where blocks are drawn largest and every brick is
    // drawn (an indicated wall's coping line would run over the empty slot), off the helix and the
    // figure, and not crowding another.
    if (sl.role !== 'pier' || sl.z < centre.z + 0.15 * plan.wall(0) || detailAt(new THREE.Vector3(sl.x, sl.y, sl.z)) < 0.5 || helixCover(at) || figureCover(at)) continue;
    if (copings.some(o => o.role === 'debris' && Math.hypot(o.x - sl.x, o.z - sl.z) < 40)) continue;
    sl.y += 4 + 6 * settle();
    sl.rx += (settle() - 0.5) * 0.7; sl.rz += (settle() - 0.5) * 0.7; sl.ry += (settle() - 0.5) * 0.5;
    sl.role = 'debris';
    moved++;
  }

  // Sketched, not surveyed. The near side keeps every brick. Toward the figure and beyond, the walls
  // are only indicated: their coping and foot drawn as continuous lines, and a few clusters of bricks
  // kept where a smooth noise runs high, the way a drawing hints at masonry instead of outlining every
  // block. The settling blocks and the rim's ring are always drawn whole.
  const irng = ctx.random('world-indication');
  const CELL_I = 24;
  const span = Math.ceil((plan.wall(0) + 2 * PITCH) / CELL_I);
  const side2 = 2 * span + 2;
  const values = Array.from({ length: side2 * side2 }, () => irng());
  /** Smooth value noise over the plan, stretched so its clusters stand out. */
  const cluster = (x: number, z: number) => {
    const gx = (x - centre.x) / CELL_I + span, gz = (z - centre.z) / CELL_I + span;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const v = (a: number, b: number) => values[clamp(a, 0, side2 - 1) * side2 + clamp(b, 0, side2 - 1)];
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const raw = (v(i, j) * (1 - sx) + v(i + 1, j) * sx) * (1 - sz) + (v(i, j + 1) * (1 - sx) + v(i + 1, j + 1) * sx) * sz;
    return clamp((raw - 0.5) * 2.4 + 0.5, 0, 1);
  };
  const indication = n(ctx, 'indication', 0.22, 0, 1);
  // The clusters follow his light: it falls off with distance from the glow, so the walls round him
  // are washed out and keep almost no bricks, and the dimmer rings toward the rim keep the most.
  const falloff = (sl: Slab) => {
    const r2 = (sl.x - centre.x) ** 2 + (sl.z - centre.z) ** 2, h2 = (glow.y - sl.y) ** 2;
    return 1 - h2 / (h2 + r2);
  };
  const dimmest = 1 - (glow.y ** 2) / (glow.y ** 2 + (plan.wall(0) ** 2));
  const drawn = (sl: Slab, index: number) => {
    if (index >= lunationStart || sl.role === 'debris') return true;
    const d = detailAt(new THREE.Vector3(sl.x, sl.y, sl.z));
    const share = Math.min(0.95, indication * 2.6 * (falloff(sl) / dimmest) ** 2.4);
    return d >= 0.999 || cluster(sl.x, sl.z) > (1 - share) * (1 - d);
  };
  return {
    plan, camera, centre, courses, slabs, lunationStart, walls, mode, height, skeleton: s, body, suit, figureMeshes, glow,
    curve, helixOptions, helix, helixCover, figureCover, detailAt, drawn,
  };
}

type Ranked = Stroke & { rank?: number };

/**
 * The walls on a small card, where a wall is a millimetre deep on paper and its courses a third of one. Each wall is one
 * line along its crest (rank 0), broken where a coping has lifted away to settle. The print's brick detail is a density:
 * the joints of a wall's first course, run down both its faces from the coping to the foot (the depth pass keeps the face
 * that sees the eye), for an even share (`keep`) of the blocks the print draws brick by brick (rank 2); and each wall's
 * ends, closed the same way. The rim's lunations and the settling copings are their trimmed outlines (rank 1).
 */
function smallWalls(world: World, view: THREE.Camera, eye: THREE.Vector3, mmPerUnit: (p: THREE.Vector3) => number, keep: number): Ranked[] {
  const { slabs, centre, courses, lunationStart, drawn, glow } = world;
  const out: Ranked[] = [];
  const wallTop = courses * COURSE, crest = wallTop + COPING;
  const face = THICK / 2 + 0.02;
  const edge = (rank: number, points: THREE.Vector3[]) => out.push({ ink: 'carbon', group: 'walls', family: 'edge', points, rank });
  for (const { path, from, to } of world.walls) {
    const lifted = slabs.slice(from, to).filter(sl => sl.role === 'debris');
    const dense: P2[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let j = 1; j <= steps; j++) dense.push({ x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps });
    }
    // The crest, where a coping still lies on it.
    let run: THREE.Vector3[] = [];
    const flush = () => { if (run.length > 1) edge(0, run); run = []; };
    for (const q of dense) {
      const w = toWorld(centre, q, crest);
      if (lifted.some(sl => Math.hypot(w.x - sl.x, w.z - sl.z) < sl.w / 2)) { flush(); continue; }
      run.push(w);
    }
    flush();
    // Its ends, down both faces.
    for (const end of [0, dense.length - 1]) {
      const q = dense[end], o = dense[end === 0 ? 1 : end - 1];
      const l = Math.hypot(q.x - o.x, q.y - o.y) || 1, nx = -(q.y - o.y) / l, ny = (q.x - o.x) / l;
      for (const sgn of [-1, 1]) edge(2, [toWorld(centre, { x: q.x + sgn * nx * face, y: q.y + sgn * ny * face }, 0.03), toWorld(centre, { x: q.x + sgn * nx * face, y: q.y + sgn * ny * face }, wallTop)]);
    }
  }
  slabs.forEach((sl, index) => {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    if (index >= lunationStart || sl.role === 'debris') {
      const toGlow = glow.clone().sub(at).normalize();
      for (const st of facetStrokes(sl, toGlow, eye, true, FACET_MM_PER_UNIT / mmPerUnit(at), { view })) edge(1, st.points);
      return;
    }
    // A joint: the start of a first-course block the print draws, down both faces.
    if (sl.role !== 'stack' || Math.abs(sl.y - COURSE / 2) > 1e-6 || !drawn(sl, index) || !evenlyKept(index, keep)) return;
    const dir = new THREE.Vector3(Math.cos(sl.ry), 0, -Math.sin(sl.ry)), normal = new THREE.Vector3(Math.sin(sl.ry), 0, Math.cos(sl.ry));
    const end = at.clone().addScaledVector(dir, -sl.w / 2).setY(0);
    for (const sgn of [-1, 1]) {
      const foot = end.clone().addScaledVector(normal, sgn * face);
      edge(2, [foot.clone().setY(0.03), foot.clone().setY(wallTop)]);
    }
  });
  return out;
}

/** How many of the print's first-course blocks a small card keeps a joint for: a share by the card's scale (`'length'`). */
function jointShare(world: World): number {
  let total = 0;
  world.slabs.forEach((sl, index) => {
    if (index < world.lunationStart && sl.role === 'stack' && Math.abs(sl.y - COURSE / 2) <= 1e-6 && world.drawn(sl, index)) total++;
  });
  return total ? scaledCount(total, JOINT_FLOOR, 'length') / total : 1;
}

/**
 * A corner mark, as `kit/emblems.ts` draws it, at a small card's size: a feature narrower than `MIN_FEATURE` drawn as its
 * line. The star's spikes are their centre lines and its hub goes; the sun's straight rays are their centre lines, its
 * twisting rays one strand each, and a rim smaller than the feature goes. The disc and the bolt keep their hatch, which is
 * in real millimetres. The paths as the kit draws them at tabloid, or where every feature is wide enough.
 */
function cornerMark(kind: 'star' | 'disc' | 'bolt' | 'sun', c: Point, r: number): Point[][] {
  if (kind === 'disc') {
    const paths = discEmblem(c, r);
    // The core's two rules, 0.6 mm apart, then its hatch 0.9 mm in (kit/fills.ts' `hatchedDisc`), the halo ring and the
    // two ticks. Off tabloid the rules' band is under the feature: the core is one outline, hatched out to it, so it still
    // prints black.
    if (!(0.6 < MIN_FEATURE)) return paths;
    const core = 0.58 * r;
    return [circlePath(c, core), ...discHatch(c, core - MIN_SPACING / 2, [[Math.PI / 4, 0.55], [-Math.PI / 4, 0.8]]), ...paths.slice(-3)];
  }
  if (kind === 'bolt') return boltEmblem(c, r);
  if (kind === 'star') {
    const paths = starEmblem(c, r);
    // The hub, then each spike's two sides and its centre line (kit/emblems.ts); a spike 0.26 r across.
    return 0.26 * r < MIN_FEATURE ? paths.filter(path => path.length === 2) : paths;
  }
  const paths = sunEmblem(c, r);
  if (!(0.14 * r < MIN_FEATURE)) return paths;
  // Three rims, then twelve rays: a straight ray a closed outline 0.14 r across at its foot, a twisting one two strands.
  const out: Point[][] = [];
  const disc = 0.46 * r;
  [disc, disc - 0.6, disc - 1.2].forEach((radius, i) => { if (radius >= MIN_FEATURE / 2) out.push(paths[i]); });
  let i = 3;
  for (let k = 0; k < 12; k++) {
    if (k % 2 === 0) {
      const ray = paths[i++];
      out.push([{ x: (ray[0].x + ray[3].x) / 2, y: (ray[0].y + ray[3].y) / 2 }, { x: (ray[1].x + ray[2].x) / 2, y: (ray[1].y + ray[2].y) / 2 }]);
    } else {
      out.push(paths[i + 1]);
      i += 2;
    }
  }
  return out;
}

export function drawWorld(ctx: SketchContext): Part[] {
  const world = worldOf(ctx);
  const { plan, centre, slabs, courses, glow, body, suit, mode, figureMeshes } = world;
  const { view } = cardCamera(ctx, plan);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => PAGE.height / (2 * Math.max(1, eye.distanceTo(p)) * fovT);
  const toGlow = (p: THREE.Vector3) => glow.clone().sub(p).normalize();
  const suited = mode !== 'dancer';
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const env = {
    forward, density: n(ctx, 'density', 0.4, 0, 1),
    screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; },
    dark: (p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.95 - 0.95 * Math.max(0, normal.dot(toGlow(p))), 0, 1),
  };
  const head = body.head!;
  const dashed = (pts: THREE.Vector3[]): ClothStroke[] => {
    const out: ClothStroke[] = [];
    let run: THREE.Vector3[] = [], at = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) at += pts[i].distanceTo(pts[i - 1]);
      if (at % 0.5 < 0.3) run.push(pts[i]);
      else { if (run.length > 1) out.push({ ink: 'carbon', group: 'contour', points: run }); run = []; }
    }
    if (run.length > 1) out.push({ ink: 'carbon', group: 'contour', points: run });
    return out;
  };
  const shoes = { ...LOOK, cloth: 'carbon' as const, accent: 'carbon' as const };
  const figure: ClothStroke[] = [
    ...(suit ? bigSuitStrokes(suit, env, LOOK, { motley: false, wind: null }) : []),
    ...body.limbs.flatMap(t => [...contourTube(t, env, suited && t.id.startsWith('leg') ? shoes : LOOK), ...silhouettes(t, env, { ink: LOOK.edge, group: LOOK.contour })]),
    ...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.45) }, LOOK),
    // Seen from above the crown faces us, and the tube silhouette (traced along the head's length)
    // misses it: the outline is the hull of the head's projected surface instead, exact for an egg.
    headOutline(head, view),
    ...[Array.from({ length: 61 }, (_, i) => head.point(0.12 + 0.8 * i / 60, 0.25, 0.02)), Array.from({ length: 41 }, (_, i) => head.point(0.5, 0.25 + 0.17 * (i / 20 - 1), 0.02))]
      .flatMap(line => mode === 'arrived' ? [{ ink: 'carbon' as const, group: 'contour', points: line }] : dashed(line)),
  ];

  // The helix, as this card's camera draws it: its laminations keep their spacing on this card's paper. (Its meshes are
  // the world's.)
  let helixStrokes = world.helix.strokes;
  if (!FORMAT.tabloid) {
    const own = helixAlong(ctx, view, world.curve, world.helixOptions);
    for (const g of own.meshes) g.dispose();
    helixStrokes = own.strokes;
  }

  // Clear paper round the helix and round the figure: nothing behind them comes near their lines. On a small card the
  // halos scale with it, on masks as fine as the print's.
  const helixCover = FORMAT.tabloid ? world.helixCover : meshCoverage(world.helix.meshes, view, PAGE, halo(n(ctx, 'helixClear', 1.4, 0, 4)), maskRes());
  const figureCover = FORMAT.tabloid ? world.figureCover : meshCoverage(figureMeshes, view, PAGE, halo(n(ctx, 'figureClear', 1.7, 0.5, 6)), maskRes());

  // The flat mark: the first set's four marks in the corners, where the old card keeps its four
  // living creatures, each by its sign: the Star (Aquarius) for the angel, Death (Scorpio) for the
  // eagle, the Sun for the lion, and the Tower for the bull. Their places and size scale with the card.
  const inset = layoutLength(n(ctx, 'cornerInset', 20, 10, 40)), mark = layoutLength(n(ctx, 'cornerSize', 9, 4, 18));
  const corners = [
    { key: 'emblem-ultramarine', c: { x: CARD.x0 + inset, y: CARD.y0 + inset }, kind: 'star' as const },
    { key: 'emblem-carbon', c: { x: CARD.x1 - inset, y: CARD.y0 + inset }, kind: 'disc' as const },
    { key: 'emblem-carbon', c: { x: CARD.x0 + inset, y: CARD.y1 - inset }, kind: 'bolt' as const },
    { key: 'emblem-vermilion', c: { x: CARD.x1 - inset, y: CARD.y1 - inset }, kind: 'sun' as const },
  ];
  const keepOff = mark * 1.45 + halo(2);
  const onEmblem = (p: Point) => corners.some(({ c }) => Math.hypot(p.x - c.x, p.y - c.y) < keepOff);

  const strokes: Ranked[] = [];
  for (const st of figure) strokes.push({ ink: st.ink, group: st.group === 'contour' ? 'figure-edge' : 'figure', family: st.family ?? 'hatch', points: st.points });
  if (FORMAT.tabloid) {
    // Every brick the print draws, in the raking hatch of his light.
    slabs.forEach((sl, index) => {
      if (!world.drawn(sl, index)) return;
      const at = new THREE.Vector3(sl.x, sl.y, sl.z);
      const pageSize = Math.max(sl.w, sl.h) * mmPerUnit(at);
      for (const st of facetStrokes(sl, toGlow(at), eye, pageSize < 1.5, FACET_MM_PER_UNIT / mmPerUnit(at))) strokes.push({ ink: st.ink, group: 'walls', family: st.family, points: st.points });
    });
    // The indicated walls: the coping's top edges and its lower edge, and the wall's foot, as unbroken
    // lines wherever the wall is quiet, and a closed end where a quiet wall stops.
    const wallTop = courses * COURSE, lip = (THICK + 0.5) / 2;
    for (const w of plan.walls) {
      const dense: P2[] = [w[0]];
      for (let i = 1; i < w.length; i++) {
        const a = w[i - 1], b = w[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
        for (let k = 1; k <= steps; k++) dense.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
      }
      const normal = (i: number) => {
        const a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
      };
      const quiet = dense.map(q => world.detailAt(toWorld(centre, q, wallTop / 2)) < 0.5);
      for (const [off, y] of [[lip, wallTop + COPING], [-lip, wallTop + COPING], [lip, wallTop], [-lip, wallTop], [THICK / 2, 0.03], [-THICK / 2, 0.03]] as const) {
        let run: THREE.Vector3[] = [];
        const flush = () => { if (run.length > 1) strokes.push({ ink: 'carbon', group: 'walls', family: 'edge', points: run }); run = []; };
        dense.forEach((q, i) => {
          if (!quiet[i]) { flush(); return; }
          const nm = normal(i);
          run.push(toWorld(centre, { x: q.x + nm.x * off, y: q.y + nm.y * off }, y));
        });
        flush();
      }
      for (const end of [0, dense.length - 1]) {
        if (!quiet[end]) continue;
        const q = dense[end], nm = normal(end);
        const at = (off: number, y: number) => toWorld(centre, { x: q.x + nm.x * off, y: q.y + nm.y * off }, y);
        strokes.push({ ink: 'carbon', group: 'walls', family: 'edge', points: [at(-lip, wallTop + COPING), at(lip, wallTop + COPING)] });
        for (const off of [-THICK / 2, THICK / 2]) strokes.push({ ink: 'carbon', group: 'walls', family: 'edge', points: [at(off, 0.03), at(off, wallTop + COPING)] });
      }
    }
  } else strokes.push(...smallWalls(world, view, eye, mmPerUnit, jointShare(world)));
  for (const h of helixStrokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const geometries = [...slabs.map(slabGeometry), ...figureMeshes, ...world.helix.meshes];
  // Small blocks hide their own back edges only if the depth range fits the scene.
  fitDepthRange(view, geometries);
  try {
    // The depth pass, `FINE` times the card's raster each way (once at tabloid): on a small card a wall is a few pixels
    // of the card's raster deep, and its crest and joints would fray against it.
    const DW = W * FINE, DH = H * FINE, PX = MM_X / FINE, PY = MM_Y / FINE;
    const depth = renderDepthBufferCPU(geometries, view, DW, DH);
    // On a small card the rings would turn polygons under the reducer's 1.4 mm stride: it scales with the card.
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    // Off tabloid the scene (the walls and the shadows) and the figure are collected and thinned by rank, each on its own,
    // before they are kept (see below).
    const pending: { key: string; piece: Point[]; rank: number; figure: boolean }[] = [];
    const add = (key: string, run: { x: number; y: number }[], keep: (p: { x: number; y: number }) => boolean, rank?: number, figure = false) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, keep, 0.15)) {
        if (rank === undefined) buckets.add(key, piece);
        else pending.push({ key, piece, rank, figure });
      }
    };
    const open = (p: Point) => !helixCover(p) && !figureCover(p) && !onEmblem(p);

    // The phrase, cut into the outer faces of the near walls, a word to a wall, from the rim inward
    // in walking order and staggered left and right: reading it walks you to the centre. Where the
    // format sets it in the band, under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('world-words');
    const textStrokes: THREE.Vector3[][] = [];
    const style = { face: settings.face, height: settings.size };
    const wallTop = courses * COURSE;
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: DW, height: DH }, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    words.forEach((word, i) => {
      const home = Math.round(1 + (CIRCUITS_INNER - 1) * i / Math.max(1, words.length - 1));
      const left = i % 2 === 0;
      // Its own ring first, then the rings either side.
      for (const j of [home, home + 1, home - 1, home + 2, home - 2].filter(j2 => j2 >= 1 && j2 <= CIRCUITS_INNER)) {
        const rf = plan.wall(j) + THICK / 2 + 0.03;
        // Within about 30° of facing us (90°), just clear of the entrance lanes, where the face
        // turns least from the eye and the word keeps its width.
        const lane = THREE.MathUtils.radToDeg(Math.asin(Math.min(1, 1.3 * PITCH / rf))) + 3;
        let placed = false;
        for (let attempt = 0; attempt < 60 && !placed; attempt++) {
          const deg = left ? 90 + lane + 30 * wrng() : 90 - lane - 30 * wrng();
          const phi = THREE.MathUtils.degToRad(deg);
          const at = toWorld(centre, { x: rf * Math.cos(phi), y: rf * Math.sin(phi) }, wallTop / 2);
          const unit = 1 / mmPerUnit(at);
          const ww = measureStrokeText(word, style) * unit, hh = Math.min(style.height * unit, wallTop - 0.8);
          const scale = hh / (style.height * unit);
          const span = ww * scale / rf;
          // The wall must stand unbroken under the whole word.
          if (!plan.rings.some(r => r.j === j && r.a0 + 0.02 < phi - span / 2 && phi + span / 2 < r.a1 - 0.02)) continue;
          const top = wallTop / 2 + hh / 2;
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => {
            const a = phi + (ww * scale / 2 - q.x * unit * scale) / rf;
            return new THREE.Vector3(centre.x + rf * Math.cos(a), top - q.y * unit * scale, centre.z + rf * Math.sin(a));
          }));
          if (word3.some(path => path.some(q => !open(pageOf(view, q))))) continue;
          if (!visible(word3)) continue;
          textStrokes.push(...word3);
          placed = true;
        }
        if (placed) break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, DW, DH).polylines) for (const c of clipProjectedPolyline(l, DW, DH)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), PX, PY)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.6));
    const clear = (p: Point) => open(p) && !onGlyph(p);

    // Each family gets its hidden-line tolerance in world units, turned into window depth at its
    // distance: the masonry tight, the figure's tube lines (tuned on cards with about a unit and a
    // half of slack) looser.
    const biasAt = (tolerance: number, at: THREE.Vector3) => {
      const d = eye.distanceTo(at);
      return tolerance * view.far * view.near / ((view.far - view.near) * d * d);
    };
    const figureTol = n(ctx, 'figureSlack', 1.2, 0, 4);
    for (const [family, tol, at] of [['figure', figureTol, centre], ['rest', 0.6, centre]] as const) {
      const mine = strokes.filter(st => (st.group.startsWith('figure') || st.group === 'helix') === (family === 'figure'));
      projectStrokes(mine, { view, depth, width: DW, height: DH, bias: biasAt(tol, at) }, {
        begin: st => runs => {
          const keep = st.group === 'helix' || st.group.startsWith('figure') ? () => true : clear;
          // A small card's figure is thinned too, each pen among its own lines (the helix keeps its own spacing).
          const figure = st.group.startsWith('figure');
          const rank = FORMAT.tabloid ? undefined : figure ? 0 : st.rank;
          for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, PX, PY), keep, rank, figure);
        },
      });
    }

    // Shadows: every block cast from the glow onto the floor, hatched in rows across the ground; the
    // depth pass hides the rows under the walls in front of them. The rows keep their pitch on paper.
    const shadows = slabs.map(sl => {
      const g2 = slabGeometry(sl);
      const pos = g2.getAttribute('position');
      const pts: { x: number; z: number }[] = [];
      for (let q = 0; q < pos.count; q++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, q);
        const f = glow.y / Math.max(0.5, glow.y - v.y);
        pts.push({ x: glow.x + (v.x - glow.x) * f, z: glow.z + (v.z - glow.z) * f });
      }
      g2.dispose();
      const poly = hull(pts);
      return { poly, z0: Math.min(...poly.map(q => q.z)), z1: Math.max(...poly.map(q => q.z)) };
    });
    const rows: Stroke[] = [];
    const yTop = pageOf(view, toWorld(centre, { x: 0, y: -(plan.wall(0) + 2 * PITCH) })).y;
    const yBot = Math.min(CARD.y1, pageOf(view, toWorld(centre, { x: 0, y: plan.wall(0) + 2 * PITCH })).y);
    const rowPitch = tolerance(n(ctx, 'shadowPitch', 0.62, 0.4, 1.5));
    for (let y = yTop, k2 = 0; y < yBot; y += rowPitch, k2++) {
      const z = onGround(view, { x: PAGE.width / 2, y }).z;
      const spans: [number, number][] = [];
      for (const { poly, z0, z1 } of shadows) {
        if (z < z0 || z > z1) continue;
        const xs: number[] = [];
        for (let q = 0; q < poly.length; q++) {
          const a = poly[q], b = poly[(q + 1) % poly.length];
          if ((a.z - z) * (b.z - z) < 0) xs.push(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
        }
        if (xs.length >= 2) spans.push([Math.min(...xs), Math.max(...xs)]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]); }
      for (const [x0, x1] of merged) rows.push({ ink: k2 % 4 === 0 ? 'ultramarine' : 'carbon', group: 'shadow', family: 'hatch', points: [new THREE.Vector3(x0, 0.03, z), new THREE.Vector3(x1, 0.03, z)] });
    }
    // On a small card the rows give way to the walls (rank 3).
    const shadowRank = FORMAT.tabloid ? undefined : 3;
    projectStrokes(rows, { view, depth, width: DW, height: DH }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, PX, PY), clear, shadowRank); },
    });
    // A small card's scene and figure, thinned: of two stretches closer than the pens hold apart, the crests keep their
    // line, then the rim's blocks and the settling copings, then the joints, then the shadow rows. The figure is thinned
    // pen by pen, in the order it is drawn: at a few millimetres tall, thinning his cloth against his outline left him a
    // red stick, where pen by pen he keeps his pinstripes.
    const layers = [pending.filter(p => !p.figure), ...[...new Set(pending.filter(p => p.figure).map(p => p.key))].map(key => pending.filter(p => p.figure && p.key === key))];
    for (const layer of layers) for (const { item, runs } of thinRanked(layer, MIN_SPACING)) for (const piece of runs) buckets.add(item.key, piece);

    for (const { key, c, kind } of corners) for (const path of cornerMark(kind, c, mark)) for (const inside of clipWindow(path)) buckets.add(key, inside);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['walls', 'shadow', 'figure', 'figure-edge', 'helix', 'emblem', 'slogan'], INKS);
    parts.push(...cardFrame('XXI', 'THE WORLD', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}

/** Convex hull of ground points (monotone chain). */
function hull(pts: { x: number; z: number }[]): { x: number; z: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: typeof p = [], upper: typeof p = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A convex tube's outline on the page, as a closed line through the surface points that make it. */
function headOutline(head: Tube, view: THREE.Camera): ClothStroke {
  const pts: { p: THREE.Vector3; x: number; y: number }[] = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j < 48; j++) {
    const p = head.point(i / 40, j / 48, 0.012);
    const q = pageOf(view, p);
    pts.push({ p, x: q.x, y: q.y });
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [], upper: typeof pts = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return { ink: LOOK.edge, group: LOOK.contour, points: [...ring, ring[0]].map(q => q.p) };
}
