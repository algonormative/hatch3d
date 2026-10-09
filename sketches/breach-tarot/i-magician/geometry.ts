import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, S, TABLOID_CARD, TABLOID_HORIZON_Y, depthRaster, evenlyKept, halo, layoutLength, layoutX, layoutY, scaledCount, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, pageExtent, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask, groundWord, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks } from '../../kit/fills.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { ELONGATED, gesture } from '../../kit/mannequin/gesture.ts';
import { POSES, poseSkeleton, withPose, type JointName, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { bodyFigure, figureMeshes, figureStrokes, type Bands } from './figure.ts';

/**
 * I The Magician: the power, not the costume. A very small figure, a few scratches just enough to
 * make out (a line of action, a bow of arms, a leg, an open loop of a head), stands charging up in
 * a clear pocket of paper at the heart of its field. The field flares round it in a wide flame of
 * fine lines; a few tongues pass in front and break its strokes, the animator's way. The helix sweeps round
 * behind it in a rising spiral and
 * streams up into the sky; the paving at its feet and blocks all round lift and tumble upward, and the
 * ground cracks out from under it. Over
 * its head, in full view with everything cleared round it, the lemniscate: the card's flat mark.
 *
 * On a smaller card (`kit/format.ts`) it is the same seeded world, laid out in tabloid's frame (`magicianWorld`) and
 * drawn with the card's own camera, so the figure, its flame, the helix and the blocks all scale with the card. The
 * ground's ruling, the blocks' hatch and the figure's ribbon bands keep their pitch on paper, so there are fewer of
 * them; the blocks' outlines are trimmed; the flame keeps a share of its lines; the figure is tested for hidden lines
 * at a finer raster and every curve keeps its shape (`reduceAtScale`); the lemniscate, too narrow a band to hatch, is
 * drawn as its line; the halos scale with a floor; the phrase moves to the band.
 */
/** The card's depth raster at tabloid; on any other page, the format's. */
const TABLOID_RASTER = { width: 1118, height: 1728 };
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FIGURE = 24;
const EYE = 9;
const FACET_MM_PER_UNIT = 8.3;
/** Hidden-line slack on the body figure's hatch and on its outlines, in world units. */
const FIGURE_SLACK = 0.08;
const FIGURE_EDGE_SLACK = 1;
/** The lemniscate's half-width as a band, in tabloid millimetres. */
const BAND = 1.6;
/** The shortest path the card plots, in millimetres. */
const SHORTEST = 0.4;
/**
 * How much finer than the card's raster the figure's own depth pass is: at tabloid the card's own; on a smaller card,
 * where the figure stands a few millimetres tall, four times as fine each way, so its outlines are tested at the detail
 * they are drawn at (at the card's raster a limb is four pixels across and its outline broke up).
 */
const FIGURE_OVERSAMPLE = FORMAT.tabloid ? 1 : 4;

/**
 * The plotted-path reducer (`simplify` in kit/page.ts) at the card's scale: a point is dropped where it neither turns
 * nor stretches the line by the reducer's tabloid thresholds scaled with the card (its 1.4 mm span by `S`, its turn's
 * 0.15 mm² by `S²`). Unscaled, that stride is a large share of a small card's curves and turned the figure, the
 * lemniscate and the flame into polygons. Only used off tabloid.
 */
export function reduceAtScale(points: Point[], scale = S): Point[] {
  if (points.length < 3) return points;
  const span = 1.4 * scale, turn = 0.15 * scale * scale;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) > span || Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > turn) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function magicianCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the Magician's world is laid out with. At tabloid it is `magicianCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: TABLOID_RASTER, horizonY: TABLOID_HORIZON_Y, fit: false,
  });
}

/** The charging stance: feet planted wide, knees bent, arms down and out with fists clenched, the
 * back arched and the head thrown back. */
export function chargingPose(yaw = 8) {
  return withPose(gesture(POSES.stand, { arc: -20 }), {
    hip_l: { flex: 14, abduct: 22 }, hip_r: { flex: 14, abduct: 22 },
    knee_l: { flex: 30 }, knee_r: { flex: 30 }, ankle_l: { flex: 10 }, ankle_r: { flex: 10 },
    shoulder_l: { flex: -8, abduct: 38 }, shoulder_r: { flex: -8, abduct: 38 },
    elbow_l: { flex: 22 }, elbow_r: { flex: 22 },
    neck: { flex: -30 }, head: { flex: -18 },
  }, { yaw });
}

/**
 * The figure as a few scratches on the sheet, the power stance stylized to a hero's shape: the legs
 * as one wide arch from foot to foot; the torso a V from the shoulders down to the waist; the arms as
 * one bow from fist to fist across the shoulders; a tick of neck and an open loop of head.
 * Each stroke wobbles and overshoots its ends a little. Drawn in `view` on the format's page, its sizes with the card.
 */
export function scratchFigure(s: Skeleton, view: THREE.Camera, rng: () => number): Point[][] {
  const P = (j: JointName, end = false) => pageOf(view, s.at(j, end));
  const feet = { x: (P('ankle_l').x + P('ankle_r').x) / 2, y: (P('ankle_l').y + P('ankle_r').y) / 2 };
  const size = Math.hypot(P('head', true).x - feet.x, P('head', true).y - feet.y);
  const jit = (p: Point, a: number): Point => ({ x: p.x + (rng() - 0.5) * a * size, y: p.y + (rng() - 0.5) * a * size });
  const curve = (pts: Point[], over = 0.04, wobble = 0.018): Point[] => {
    const q = pts.map(p => jit(p, wobble));
    const ext = (a: Point, b: Point, k: number): Point => {
      const dx = a.x - b.x, dy = a.y - b.y, l = Math.hypot(dx, dy) || 1;
      return { x: a.x + dx / l * k * size, y: a.y + dy / l * k * size };
    };
    const all = [ext(q[0], q[1], over * (0.4 + rng())), ...q, ext(q[q.length - 1], q[q.length - 2], over * (0.4 + rng()))];
    return new THREE.CatmullRomCurve3(all.map(p => new THREE.Vector3(p.x, p.y, 0)), false, 'centripetal').getPoints(all.length * 10).map(v => ({ x: v.x, y: v.y }));
  };
  const out: Point[][] = [];
  // The legs: one arch, foot to foot through the pelvis.
  out.push(curve([P('ankle_l', true), P('ankle_l'), P('knee_l'), P('pelvis'), P('knee_r'), P('ankle_r'), P('ankle_r', true)], 0.04));
  // The torso: a V from each shoulder in to the waist, bowed a little.
  const waist = P('pelvis');
  for (const side of ['l', 'r'] as const) {
    const sh = P(`shoulder_${side}`), mid = P('spine');
    out.push(curve([sh, { x: (sh.x + mid.x) / 2 + (sh.x - mid.x) * 0.12, y: (sh.y + mid.y) / 2 }, waist], 0.03));
  }
  // The neck: a short tick up from between the shoulders.
  out.push(curve([P('neck'), P('head')], 0.02, 0.01));
  // The bow: fist, elbow, shoulder, across, shoulder, elbow, fist.
  out.push(curve([P('wrist_l', true), P('wrist_l'), P('elbow_l'), P('shoulder_l'), P('shoulder_r'), P('elbow_r'), P('wrist_r'), P('wrist_r', true)], 0.03));
  // The head: an open loop, three quarters round, never smaller than the print's 2.1 mm (with the card).
  const hc = { x: (P('head').x + P('head', true).x) / 2, y: (P('head').y + P('head', true).y) / 2 };
  const hr = Math.max(layoutLength(2.1), Math.hypot(P('head', true).x - P('head').x, P('head', true).y - P('head').y) * 0.6);
  const a0 = rng() * Math.PI * 2;
  out.push(Array.from({ length: 41 }, (_, i) => {
    const a = a0 + i / 40 * Math.PI * 1.55, r = hr * (1 + 0.1 * Math.sin(a * 3));
    return { x: hc.x + r * Math.cos(a), y: hc.y + r * 1.15 * Math.sin(a) };
  }));
  return out;
}

/** Whether `p` is inside the closed path `ring` (even-odd: both loops of a figure eight). */
function insideOf(ring: Point[], p: Point): boolean {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    if ((ring[a].y > p.y) !== (ring[b].y > p.y) && p.x < (ring[b].x - ring[a].x) * (p.y - ring[a].y) / (ring[b].y - ring[a].y) + ring[a].x) inside = !inside;
  }
  return inside;
}

export interface MagicianWorld {
  /** Where its feet are planted. */
  base: THREE.Vector3;
  skeleton: Skeleton;
  /** The paving lifting at its feet, then the blocks all round (each one's `beat` is its place here). */
  blocks: Slab[];
  /** How many of `blocks` are the paving. */
  paving: number;
  /** The flame's field lines, in seeded order. */
  fieldLines: THREE.Vector3[][];
  /** The phase of the pocket's flame-edged rim. */
  pocketPhase: number;
  /** The cracks across the ground, on tabloid's page (tabloid millimetres); `layoutX` / `layoutY` carry them to the card. */
  cracks: Point[][];
}

/**
 * The Magician's world: where it stands, the blocks lifting round it, its flame, and the cracks from its feet. It is
 * laid out in tabloid's frame, with `worldCamera` and tabloid's page and card, so every size and fit builds the same
 * world, to the bit; each card's own camera then draws it.
 */
export function magicianWorld(ctx: SketchContext): MagicianWorld {
  const camera = worldCamera(ctx);
  const eye = camera.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const f = TABLOID_PAGE.height / 2 / fovT;
  const halfW = (TABLOID_CARD.x1 - TABLOID_CARD.x0) / 2;
  const half = (z: number) => halfW / f * (eye.z - z);
  // Small and far: the figure stands a set height on the card (in tabloid millimetres, scaled with the card).
  const figureMm = n(ctx, 'figure', 40, 14, 100);
  const depth = FIGURE * f / figureMm;
  const base = new THREE.Vector3((TABLOID_PAGE.width / 2 - (TABLOID_CARD.x0 + TABLOID_CARD.x1) / 2) / f * depth + n(ctx, 'figureX', 0, -0.3, 0.3) * half(-depth), 0, -depth);
  const skeleton = poseSkeleton(chargingPose(n(ctx, 'turn', 8, -60, 60)), { height: FIGURE, position: base, proportions: ELONGATED });
  const rng = ctx.random('magician-power');

  // Blocks: the paving at its feet lifting, and blocks all round, larger and higher further out.
  const blocks: Slab[] = [];
  for (let i = 0; i < Math.round(n(ctx, 'paving', 16, 0, 40)); i++) {
    const a = rng() * Math.PI * 2, r = 9 + 10 * rng();
    const sl = solid(base.x + Math.cos(a) * r, 0.6 + 6 * rng() ** 2, base.z + Math.sin(a) * r * 0.9, 3 + 3 * rng(), 0.7, 2.5 + 2 * rng(), blocks.length, 'debris');
    sl.rx = (rng() - 0.5) * 1.2; sl.ry = rng() * Math.PI; sl.rz = (rng() - 0.5) * 1.2;
    blocks.push(sl);
  }
  const paving = blocks.length;
  const count = Math.round(n(ctx, 'blocks', 44, 0, 120));
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2, r = 22 + 140 * rng() ** 1.4;
    const lift = (8 + 70 * rng() ** 1.3) * (0.4 + r / 120);
    const size = 2.5 + r * 0.09 * (0.6 + rng());
    const sl = solid(base.x + Math.cos(a) * r, lift, base.z + Math.sin(a) * r * 0.8, size * (1.4 + rng()), size * (0.25 + 0.3 * rng()), size * (0.8 + 0.6 * rng()), blocks.length, 'debris');
    sl.rx = (rng() - 0.5) * 1.6; sl.ry = rng() * Math.PI; sl.rz = (rng() - 0.5) * 1.6;
    if (eye.z - sl.z < 20) continue;
    // Keep the air round the figure and its flame clear (measured on tabloid's page).
    const pc = pageOf(camera, new THREE.Vector3(sl.x, sl.y, sl.z), TABLOID_PAGE), foot = pageOf(camera, base, TABLOID_PAGE);
    if (Math.abs(pc.x - foot.x) < figureMm * 1.25 && pc.y < foot.y + 8 && pc.y > foot.y - figureMm * 3.2) continue;
    blocks.push(sl);
  }
  for (const sl of blocks) sl.tone = 0.5 + 0.7 * clamp(Math.hypot(sl.x - base.x, sl.z - base.z) / 80, 0, 1);

  // The field: a flame of fine lines. Each starts tight round its feet, fans out wide as it rises
  // and ends in a tongue of its own length, swaying; the ragged ends make the flame's edge.
  const fieldLines: THREE.Vector3[][] = [];
  const lines = Math.round(n(ctx, 'field', 64, 0, 140));
  const top = n(ctx, 'flame', 2.6, 1.5, 4) * FIGURE, wide = n(ctx, 'flare', 1.2, 0.5, 2) * FIGURE;
  for (let j = 0; j < lines; j++) {
    const th0 = (j + rng() * 0.6) / lines * Math.PI * 2, wob = rng() * Math.PI * 2;
    const reach = 0.45 + 0.55 * rng() ** 0.7, rb = 0.16 * FIGURE * (0.6 + 0.8 * rng());
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 140; i++) {
      const v = i / 140 * reach, y = v * top;
      const open = Math.sin(Math.PI / 2 * Math.min(1, v / 0.62)) ** 0.85 * (1 - 0.55 * smooth(0.62, 1, v));
      const r = rb + (wide - rb) * open * (1 + 0.14 * Math.sin(v * 13 + wob) * v);
      const th = th0 + 0.7 * v * v + 0.3 * v * Math.sin(v * 7 + wob);
      pts.push(new THREE.Vector3(base.x + r * Math.cos(th), y + 0.04 * FIGURE * Math.sin(v * 9 + wob) * v, base.z + r * Math.sin(th) * 0.85));
    }
    fieldLines.push(pts);
  }
  const pocketPhase = rng() * Math.PI * 2;

  // The shockwave: cracks running from the pocket's foot across the ground toward us, drawn on the
  // sheet (the ground is a plane) so they keep an even scale. Each stops at the card's edge, which decides how much
  // of the seeded stream it uses, so they are run out on tabloid's page and card.
  const crng = ctx.random('magician-cracks');
  const cracks: Point[][] = [];
  const crack = (from: Point, a: number, length: number, forks: number) => {
    const pts = [from];
    let p = from, dir = a;
    for (let travelled = 0; travelled < length;) {
      const step = 3.5 + 5 * crng();
      dir = clamp(dir + (crng() - 0.5) * 0.5 + (crng() < 0.12 ? (crng() - 0.5) * 1.2 : 0), 0.15, Math.PI - 0.15);
      p = { x: p.x + Math.cos(dir) * step, y: p.y + Math.sin(dir) * step * 0.8 };
      if (p.y > TABLOID_CARD.y1 || p.x < TABLOID_CARD.x0 || p.x > TABLOID_CARD.x1) break;
      pts.push(p);
      travelled += step;
      if (forks > 0 && crng() < 0.08) crack(p, dir + (crng() < 0.5 ? -1 : 1) * (0.35 + 0.4 * crng()), (length - travelled) * 0.5, forks - 1);
    }
    if (pts.length > 1) cracks.push(pts);
  };
  const foot = pageOf(camera, base, TABLOID_PAGE);
  const spokes = Math.round(n(ctx, 'cracks', 7, 0, 30));
  for (let i = 0; i < spokes; i++) {
    const a = Math.PI / 2 + ((i + 0.2 + 0.6 * crng()) / spokes - 0.5) * 2.4;
    crack({ x: foot.x + Math.cos(a) * 4, y: foot.y + 2 + Math.sin(a) * 2 }, a, 40 + 120 * crng(), 2);
  }
  return { base, skeleton, blocks, paving, fieldLines, pocketPhase, cracks };
}

/**
 * Whether a card draws each of the world's blocks: every one but a speck, a block smaller on paper than `MIN_FEATURE`
 * (none at tabloid). The blocks are not thinned as a density: they are the composition (the long slab over the
 * top left, the tumbling ones to the right), and each is hatched at the facet hatch's pitch on paper, so a smaller
 * card keeps their tone with fewer lines in each; only their outlines grow denser, and those are trimmed (`facetStrokes`'
 * `trim`). Thinned by length, as the Fool's loose blocks are, the card lost the slabs that make its frame.
 */
export function shownBlocks(blocks: readonly Slab[], view: THREE.Camera): boolean[] {
  return blocks.map(sl => !MIN_FEATURE || pageExtent(view, sl).size >= MIN_FEATURE);
}

/**
 * The share of the flame's field lines a smaller card keeps never falls under this: each line's length goes with the
 * card, so its tone wants them thinned by the scale (`scaledCount` by length, about a quarter), but a flame of fewer
 * than two in five read as a few loose strands; at two in five it is still a flame, no denser than the print's.
 */
export const FIELD_FLOOR = 0.4;

/** The share of `lines` field lines a card draws, as an even spread over their seeded order: all of them at tabloid. */
export const fieldShare = (lines: number): number => lines ? scaledCount(lines, Math.round(FIELD_FLOOR * lines), 'length') / lines : 1;

/**
 * The figure's ribbon bands on a smaller card: the print's (six round the trunk, the kit's four round a limb) scaled
 * with the card, never under one, so each band keeps its width on paper and there are fewer of them, as a ruling keeps
 * its pitch. Undefined at tabloid, where the figure keeps the print's.
 */
export const figureBands = (): Bands | undefined => FORMAT.tabloid ? undefined : { trunk: Math.max(1, Math.round(6 * S)), limb: Math.max(1, Math.round(4 * S)) };

export function drawMagician(ctx: SketchContext): Part[] {
  const view = magicianCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const halfW = (CARD.x1 - CARD.x0) / 2;
  const half = (z: number) => halfW / f * (eye.z - z);
  // The world, the same at every size; this card's camera draws it.
  const world = magicianWorld(ctx);
  const { base, skeleton: s, fieldLines } = world;
  const light = new THREE.Vector3(0.1, 0.9, 0.5).normalize();
  const shown = shownBlocks(world.blocks, view);
  const blocks = world.blocks.filter((_, i) => shown[i]);
  const wide = n(ctx, 'flare', 1.2, 0.5, 2) * FIGURE;

  // The ribbon: the helix sweeping round behind it in a rising spiral, then up into the sky.
  const k = FIGURE / 24;
  const at = (x: number, y: number, z: number) => base.clone().add(new THREE.Vector3(x * k, y * k, z * k));
  const sweep = n(ctx, 'sweep', 1, 0.5, 1.6);
  const ribbon = helixAlong(ctx, view, new THREE.CatmullRomCurve3([
    at(-20 * sweep, 2, -6), at(-15 * sweep, 12, -16), at(8 * sweep, 22, -19), at(22 * sweep, 34, -8), at(12 * sweep, 48, -19),
    at(-14 * sweep, 60, -17), at(-20 * sweep, 74, -8), at(-6, 96, -21), at(8, 140, -34), at(0, 230, -50),
  ], false, 'centripetal'), { radius: n(ctx, 'ribbon', 3.4, 1, 6) * k, width: 3 * k, pitch: 15 * k, spread: 0.4, narrow: 0.3 });

  // Split each line where it crosses the figure's plane: the front runs pass before it, the back behind.
  const field: (Stroke & { front: boolean; line: number })[] = [];
  // A smaller card draws a share of the lines (`fieldShare`); every line is still split, so the veil keeps the print's tongues.
  const fieldKeep = fieldShare(fieldLines.length);
  fieldLines.forEach((pts, j) => {
    let run: THREE.Vector3[] = [], front = pts[0].z > base.z;
    const flush = () => { if (run.length > 1) field.push({ ink: j % 3 === 0 ? 'violet' : 'acid', group: 'field', family: 'hatch', points: run, front, line: j }); };
    for (const p of pts) {
      const f = p.z > base.z;
      if (f !== front) { run.push(p); flush(); run = [p]; front = f; } else run.push(p);
    }
    flush();
  });

  const strokes: Stroke[] = [];
  for (const sl of blocks) {
    const at3 = new THREE.Vector3(sl.x, sl.y, sl.z);
    const scale = FACET_MM_PER_UNIT / mmPerUnit(at3);
    // Off tabloid a block's outline is trimmed (kit/slabs.ts): at this size its back edges and sliver faces would double it.
    for (const st of facetStrokes(sl, light, eye, Math.max(sl.w, sl.h) * mmPerUnit(at3) < 2, scale, { view })) {
      strokes.push({ ink: st.ink, group: 'blocks', family: st.family, points: st.points });
    }
  }
  for (const h of ribbon.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const geometries = [...blocks.map(slabGeometry), ...ribbon.meshes];
  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The lemniscate over its head, in full view: everything else is cleared round it. Its size scales with the card;
    // a band too narrow to hold its two rules apart is drawn as its line.
    const crown = pageOf(view, s.at('head', true).add(new THREE.Vector3(0, n(ctx, 'infinityLift', 15, 3, 40) * k, 0)));
    const a = layoutLength(n(ctx, 'infinity', 16, 8, 50));
    const lemniscate: Point[] = Array.from({ length: 241 }, (_, i) => {
      const t = i / 240 * Math.PI * 2, d = 1 + Math.sin(t) ** 2;
      return { x: crown.x + a * Math.cos(t) / d, y: crown.y + a * Math.sin(t) * Math.cos(t) / d };
    });
    const band = layoutLength(BAND), margin = layoutLength(4);
    const markPaths = bandMarks(lemniscate, band, { x0: crown.x - a - margin, x1: crown.x + a + margin, y0: crown.y - a, y1: crown.y + a },
      { pitch: tolerance(0.62), angle: Math.PI / 4, narrow: MIN_FEATURE });
    const nearMark = glyphMask([lemniscate], halo(BAND + 1.4));
    // On a small card the eyes of its loops are clear too: a millimetre or two across, what crossed them there was a
    // stray tick that read as a letter inside the mark. (The print's eyes are wide enough for the field to cross.)
    const onMark = MIN_FEATURE ? (p: Point) => nearMark(p) || insideOf(lemniscate, p) : nearMark;
    // Fire and figure: page masks of the sketch and of the flame's front runs, each breaking the other.
    const pageOfAll = (lines3: THREE.Vector3[][]) => {
      const out: Point[][] = [];
      for (const line of projectPolylinesClipped(lines3, view, W, H).polylines) for (const c of clipProjectedPolyline(line, W, H)) out.push(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y));
      return out;
    };
    // The scratch figure always sets the figure's place, size and pocket, so the body (the other style) stands exactly where it stood.
    const figure = scratchFigure(s, view, ctx.random('magician-scratch'));
    // Its own ground: a pocket of paper round it, edged like a flame, where nothing else is drawn.
    const fx = figure.flat().map(p => p.x), fy = figure.flat().map(p => p.y);
    const pc = { x: (Math.min(...fx) + Math.max(...fx)) / 2, y: (Math.min(...fy) + Math.max(...fy)) / 2 - 0.08 * (Math.max(...fy) - Math.min(...fy)) };
    const prx = (Math.max(...fx) - Math.min(...fx)) / 2 * n(ctx, 'pocket', 1.6, 1, 3) + layoutLength(3), pry = (Math.max(...fy) - Math.min(...fy)) / 2 * 1.3 + layoutLength(3);
    const pph = world.pocketPhase;
    const inPocket = (p: Point) => {
      const dx = (p.x - pc.x) / prx, dy = (p.y - pc.y) / pry, a = Math.atan2(dy, dx);
      return Math.hypot(dx, dy) < 1 + 0.12 * Math.sin(5 * a + pph) + 0.07 * Math.sin(9 * a + 2 * pph) + (dy < 0 ? 0.15 * Math.max(0, -Math.sin(a)) : 0);
    };
    // A few tongues in front still cross the pocket and break its strokes.
    const veil = n(ctx, 'veil', 0.18, 0, 1);
    const veilLine = (f: { front: boolean }, i: number) => f.front && ((i * 37) % 100) / 100 < veil;
    const drawn = (f: { line: number }) => evenlyKept(f.line, fieldKeep);
    const onFlameFront = glyphMask(pageOfAll(field.filter((f, i) => drawn(f) && veilLine(f, i)).map(f => f.points)), halo(0.32));

    // The phrase, painted on the ground round it, staggered, each word where it can be seen whole; or, where the
    // format sets it in the band, under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size + 0.4 };
    const wrng = ctx.random('magician-words');
    const textStrokes: THREE.Vector3[][] = [];
    const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const cover = words.length ? meshCoverage(geometries, view, PAGE, halo(2)) : () => false;
    const top2 = HORIZON_Y + layoutLength(6), bottom = CARD.y1 - layoutLength(5);
    let side = wrng() < 0.5 ? -1 : 1, lastY = top2 - 8;
    words.forEach((word, i) => {
      const hw = measureStrokeText(word, style) / 2 + 3;
      for (let attempt = 0; attempt < 200; attempt++) {
        const yy = top2 + (bottom - top2) * clamp((i + 0.5) / words.length + (wrng() - 0.5) * 0.3 * (1 + attempt / 20), 0, 1);
        if (yy < lastY + 2.5) continue;
        const xx = clamp((CARD.x0 + CARD.x1) / 2 + side * layoutLength(10 + 90 * wrng()), CARD.x0 + hw + 2, CARD.x1 - hw - 2);
        const box = { x0: xx - hw - 3, x1: xx + hw + 3, y0: yy - 4, y1: yy + 4 };
        if (taken.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        const word3 = groundWord(view, word, { x: xx, y: yy }, style);
        let blocked = false;
        for (const path3 of word3) for (const q of path3) if (cover(pageOf(view, q))) blocked = true;
        if (blocked) continue;
        textStrokes.push(...word3);
        taken.push(box);
        lastY = yy;
        break;
      }
      side = -side;
    });
    const glyphPaths: Point[][] = [];
    for (const line of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(line, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.6));
    const buckets = new PartBuckets(SHORTEST);
    // Off tabloid every path goes through the reducer at the card's scale (`reduceAtScale`), and keeps what it leaves.
    const put = (key: string, path: Point[], min?: number) => FORMAT.tabloid ? buckets.add(key, path, false, min) : buckets.add(key, reduceAtScale(path), true, min ?? SHORTEST);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onMark(p) && extra(p), 0.15)) put(key, piece, min);
    };
    // What a block face's hatch leaves shorter than the smallest feature is a speck, not shading: dropped (nothing at tabloid).
    const speck = (family: Stroke['family']) => family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined;
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), p => !inPocket(p), st.group === 'blocks' ? speck(st.family) : undefined); },
    });
    projectStrokes(field, { view, depth: depthBuffer, width: W, height: H }, {
      begin: (st, i) => runs => { if (drawn(st)) for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), veilLine(st, i) ? () => true : p => !inPocket(p)); },
    });
    if (ctx.params.figureStyle === 'body') {
      // The body, fitted to the scratch figure's box on the sheet (same height, same ground, same middle), hatched in carbon and
      // hidden-line tested against itself alone: its own depth pass, fitted close, so a small figure keeps its detail.
      const box = { x0: Math.min(...fx), x1: Math.max(...fx), y0: Math.min(...fy), y1: Math.max(...fy) };
      const pose = chargingPose(n(ctx, 'turn', 8, -60, 60));
      const place = base.clone();
      let height = FIGURE;
      let fig = bodyFigure(pose, height, place);
      for (let pass = 0; pass < 3; pass++) {
        const geos = figureMeshes(fig);
        const seen = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        const v = new THREE.Vector3();
        for (const g of geos) {
          const pos = g.getAttribute('position');
          for (let i = 0; i < pos.count; i++) {
            const q = pageOf(view, v.fromBufferAttribute(pos, i));
            seen.x0 = Math.min(seen.x0, q.x); seen.x1 = Math.max(seen.x1, q.x); seen.y0 = Math.min(seen.y0, q.y); seen.y1 = Math.max(seen.y1, q.y);
          }
          g.dispose();
        }
        height *= (box.y1 - box.y0) / (seen.y1 - seen.y0);
        place.x += ((box.x0 + box.x1) / 2 - (seen.x0 + seen.x1) / 2) / f * (eye.z - place.z);
        fig = bodyFigure(pose, height, place);
      }
      const lit = (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.9 * (1 - Math.max(0, normal.dot(new THREE.Vector3(-0.5, 0.55, 0.7).normalize()))) ** 1.3 + 0.04, 0, 1);
      const forward = new THREE.Vector3();
      view.getWorldDirection(forward);
      const env = { forward, density: 0.4, dark: lit, screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; } };
      const figGeos = figureMeshes(fig);
      const figView = view.clone();
      // Its own raster: the card's, or finer by `FIGURE_OVERSAMPLE` each way, the camera's view offset with it (the same projection).
      const m = FIGURE_OVERSAMPLE, FW = W * m, FH = H * m;
      if (m !== 1) {
        const o = view.view!;
        figView.setViewOffset(o.fullWidth * m, o.fullHeight * m, o.offsetX * m, o.offsetY * m, o.width * m, o.height * m);
      }
      try {
        fitDepthRange(figView, figGeos);
        const figDepth = renderDepthBufferCPU(figGeos, figView, FW, FH);
        const biasAt = (tol: number) => tol * figView.far * figView.near / ((figView.far - figView.near) * (eye.z - place.z) ** 2);
        const lines = figureStrokes(fig, env, figureBands());
        // An outline runs along the edge where the surface turns away from the eye, so its depth changes fastest there: it gets more slack than the hatch.
        for (const edge of [false, true]) {
          projectStrokes(lines.filter(st => (st.group === 'figure-edge') === edge), { view: figView, depth: figDepth, width: FW, height: FH, bias: biasAt(edge ? FIGURE_EDGE_SLACK : FIGURE_SLACK) }, {
            begin: () => runs => { for (const run of runs) add('figure-carbon', scalePoints(run, MM_X / m, MM_Y / m), p => !onFlameFront(p)); },
          });
        }
      } finally {
        for (const g of figGeos) g.dispose();
      }
    } else {
      for (const path of figure) add('figure-carbon', path, p => !onFlameFront(p));
    }
    // The ground: dark rows, the field's light pooled round its feet. The ruling is a tone, its pitch kept on paper.
    const rows: Stroke[] = [];
    for (let y = HORIZON_Y + 0.6, i = 0; y < CARD.y1; y += tolerance(0.7), i++) {
      const z = onGround(view, { x: PAGE.width / 2, y }).z;
      const reachX = half(z) + 2;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= 200; q++) {
        const px = base.x - reachX + 2 * reachX * q / 200;
        const r = Math.hypot((px - base.x) / (wide * 1.8), (z - base.z) / (wide * 1.3));
        pts.push(new THREE.Vector3(px, 0.02, z));
        keep.push(r > 1 && (i % 3 === 0 || (i % 3 === 1 && r > 1.8)));
      }
      let run: THREE.Vector3[] = [];
      for (let q = 0; q < pts.length; q++) {
        if (keep[q]) run.push(pts[q]);
        else { if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'ground', family: 'hatch', points: run }); run = []; }
      }
      if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'ground', family: 'hatch', points: run });
    }
    // The shockwave: the world's cracks, carried from tabloid's page to the card; the rows break round them.
    const cracks = world.cracks.map(path => path.map(p => ({ x: layoutX(p.x), y: layoutY(p.y) })));
    const onCrack = glyphMask(cracks, halo(0.7));
    for (const path of cracks) add('cracks-carbon', path, p => !inPocket(p));
    projectStrokes(rows, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), p => !onCrack(p) && !inPocket(p)); },
    });
    for (const path of markPaths) for (const inside of clipWindow(path)) put('mark-carbon', inside);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['ground', 'cracks', 'blocks', 'field', 'helix', 'figure', 'mark', 'slogan'], INKS);
    const solidThings = meshCoverage(geometries, view, PAGE, halo(0.4));
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p) && !onMark(p) && !inPocket(p), 0.3) });
    parts.push(...cardFrame('I', 'THE MAGICIAN', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
