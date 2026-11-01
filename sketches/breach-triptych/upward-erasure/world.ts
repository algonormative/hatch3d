import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import {
  atPoint, contourLines, isoLines, meshSdf, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry, toWorld, type IsoLine, type SculptMesh, type SurfacePoint, type V3,
} from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import type { GpuMesher } from '../../kit/sculpt-gpu.ts';
import { traceMask } from '../../kit/outline.ts';
import { NO_SLOGAN, SLOGAN_CONTROLS, slogans, type SloganInk } from './slogans.ts';
import { clipToTrim, stripeFill } from '../lodestone-cuts.ts';
import { ART, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Upward Erasure, the world its sheets share (after the Lodestone character study of 2026-10-21): a suited android of
 * the far future, its head tipped back and turned to its right, seen from below; a gold-yellow bar across its eyes,
 * behind its nose, the edge of an erasure field; above it the crown coming apart into slices that rise up the sheet.
 *
 * Two sheets, as Lodestone L: the black in front, drawn in silver and gold gel (the head, the suit, the ribbons, one
 * pink line from the lower lip down the throat), and the gold-yellow behind it, showing through windows cut in the
 * black (the bar, the shirt and collar, some of the crown's slices), with Micron 08 black on it where they show.
 *
 * The head is a sculpted human head whose skin is plates: each engraved in lines of its own direction (a few
 * cross-hatched, a few left bare), with a groove of two gold lines at every seam.
 */

const deg = THREE.MathUtils.degToRad;

/** The pens: the black's silver, gold and fluoro pink gels, and the Micron 08 on the gold. */
export type Pen = 'silver' | 'gold' | 'fluoro-pink' | 'black';

/** A projected, visible mark, and how the thinning ranks it (0 outlines, 1 seams and creases, 2 hatch). */
export interface Seen { pen: Pen; rank: number; id: string; piece: Point[] }


/** A line of the suit; `behind` the neck (the collar's back), hidden where the neck is. */
export interface SuitLine { pen: Pen; path: Point[]; behind?: boolean }

/** A panel of the suit, striped at `angle`, `pitch` apart, in `pen` (on the gold for a `window`). */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }

/**
 * A cell of the glitch in the visor's frame (u along it, v up from its top edge, mm): a `rise` is a gold column out of
 * the visor's top edge (its art the head's smeared up by `dv`); a `base` keeps the head where it is; a `black` piece
 * of the head (from `v0`..`v1`) is drawn `dv` higher on the black, framed in gold; a `gold` piece is cut out of the
 * black and drawn `dv` higher in black ink on the gold.
 */
export interface Cell { u0: number; u1: number; v0: number; v1: number; dv: number; kind: 'rise' | 'base' | 'black' | 'gold' }

export interface Erasure {
  head: Seen[];
  onHead: (p: Point) => boolean;
  /** Where the lower nose covers the visor (grown by a little black round it). */
  onNose: (p: Point) => boolean;
  bar: Point[];
  /** The visor's frame: a point (u along it, v up from its top edge) on the page, and back; its height. */
  toPage: (u: number, v: number) => Point;
  toBar: (p: Point) => { u: number; v: number };
  barH: number;
  cells: Cell[];
  /** Where the head is taken apart (above the visor, outside the kept cells). */
  erased: (p: Point) => boolean;
  /** Gold-yellow fragments and drips: plain windows. */
  fragments: Point[][];
  drips: Point[][];
  /** Black-ink streaks up the gold columns. */
  streaks: Point[][];
  /** Bands of the visor (the eyes behind it, on the gold) and below it (the face, on the black) shifted along it. */
  visorBands: { v0: number; v1: number; du: number }[];
  spill: { v0: number; v1: number; du: number }[];
  panels: Panel[];
  suitLines: SuitLine[];
  bySuit: (p: Point) => boolean;
  shirt: Point[][];
  collarBack: Point[];
  window: Point[][];
  ribbons: { pen: Pen; path: Point[] }[];
  page: { eyes: Point[]; noseTip: Point; chin: Point; neck: { left: Point; right: Point } };
  /** The slogans' ink (`./slogans.ts`): the readout on the gold, the rising slogan on the black. */
  slogan: SloganInk;
  /** The gold and silver frame on the black, when there is one (`frameOf`). */
  frame?: Frame;
}

// ── Controls ─────────────────────────────────────────────────────────

/** One numeric parameter: its control, and whether it shapes the head (so changing it rebuilds the head's lines). */
interface Param { id: string; label: string; d: number; min: number; max: number; step: number; group: string; units?: string; head?: boolean }
const P = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string, head?: boolean): Param => ({ id, label, d, min, max, step, group, ...(units ? { units } : {}), ...(head ? { head } : {}) });
/** Marks a parameter that shapes the head. */
const HEAD = true;

/** Every numeric parameter, in the order the controls show them. */
export const PARAMS: Param[] = [
  P('tilt', 'Head tipped back', 18, 0, 60, 1, 'Pose', '°', HEAD),
  P('turn', 'Head turned on the neck', 6, -40, 40, 1, 'Pose', '°', HEAD),
  P('yaw', 'Figure turned (face toward the right)', 40, -90, 90, 1, 'Pose', '°', HEAD),
  P('roll', 'Lean toward the left of the sheet', 8, -40, 40, 1, 'Pose', '°', HEAD),
  P('noseLength', 'Nose length', 1.25, 0.6, 1.8, 0.05, 'Face', undefined, HEAD),
  P('noseWidth', 'Nose width at the wings', 1, 0.6, 1.6, 0.05, 'Face', undefined, HEAD),
  P('bridge', 'Nose bridge between the eyes', 1, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('chin', 'Chin forward', 1, 0, 2.5, 0.05, 'Face', undefined, HEAD),
  P('jaw', 'Jaw', 1, 0.6, 1.6, 0.05, 'Face', undefined, HEAD),
  P('lips', 'Lips', 1, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('brow', 'Brow', 1, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('cheeks', 'Cheekbones', 1, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('ears', 'Ears', 1, 0.6, 1.5, 0.05, 'Face', undefined, HEAD),
  P('cranium', 'Skull height', 1, 0.85, 1.2, 0.01, 'Face', undefined, HEAD),
  P('neckLength', 'Neck length', 1.6, 0.8, 2.4, 0.05, 'Face', undefined, HEAD),
  P('neckWidth', 'Neck thickness', 0.15, 0.1, 0.22, 0.005, 'Face', undefined, HEAD),
  P('headMm', 'Head height on the sheet', 190, 100, 300, 1, 'Framing', 'mm', HEAD),
  P('crownY', 'Crown height on the sheet', 120, 20, 250, 1, 'Framing', 'mm', HEAD),
  P('headX', 'Head across the sheet', 150, 40, 240, 1, 'Framing', 'mm', HEAD),
  P('lookUp', 'Camera looking up', 8, 0, 40, 1, 'Framing', '°', HEAD),
  P('collarAt', 'Collar on the neck', 0.56, 0.4, 1.6, 0.01, 'Framing'),
  P('frameMm', 'Gold and silver frame width (0 for none)', 0, 0, 10, 0.5, 'Framing', 'mm'),
  P('frameInset', 'Frame in from the trim', 4, 2, 15, 0.5, 'Framing', 'mm'),
  P('pitchMm', 'Densest line pitch', 0.95, 0.8, 3, 0.05, 'Plates', 'mm', HEAD),
  P('plateMm', 'Plate size', 27, 10, 80, 1, 'Plates', 'mm', HEAD),
  P('bareShare', 'Plates left bare', 0.12, 0, 0.6, 0.01, 'Plates', undefined, HEAD),
  P('crossShare', 'Plates cross-hatched', 0.2, 0, 0.8, 0.01, 'Plates', undefined, HEAD),
  P('plateSwing', 'Plates\' line angles vary', 0.8, 0, 1.6, 0.05, 'Plates', undefined, HEAD),
  P('lightX', 'Light from the right', 0.35, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('lightZ', 'Light from the front', 0.55, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('neckRings', 'Neck segment rings', 3, 0, 6, 1, 'Plates', undefined, HEAD),
  P('step', 'Mesh detail (cell, head units; larger is faster)', 0.009, 0.006, 0.02, 0.001, 'Plates', undefined, HEAD),
  P('barMm', 'Visor height', 30, 16, 60, 0.5, 'Visor', 'mm'),
  P('barTilt', 'Visor tilt off the eye line', 0, -25, 25, 0.5, 'Visor', '°'),
  P('eyeInBar', 'Visor lower on the eyes', 0.08, -0.4, 0.4, 0.01, 'Visor'),
  P('barPast', 'Visor past the nose tip', 6, -20, 80, 1, 'Visor', 'mm'),
  P('noseFront', 'Nose in front of the visor', 0.78, 0, 1, 0.01, 'Visor', undefined, HEAD),
  P('erosion', 'Crown taken apart', 0.85, 0, 1, 0.01, 'Glitch'),
  P('riseMm', 'Gold column height', 80, 10, 200, 1, 'Glitch', 'mm'),
  P('colMin', 'Narrowest column', 3, 1.5, 10, 0.5, 'Glitch', 'mm'),
  P('colMax', 'Widest column', 13, 4, 30, 0.5, 'Glitch', 'mm'),
  P('liftPieces', 'Pieces lifted', 1, 0, 2, 0.05, 'Glitch'),
  P('liftGap', 'How far pieces rise', 1, 0.3, 3, 0.05, 'Glitch'),
  P('fragments', 'Gold fragments', 0.3, 0, 1, 0.01, 'Glitch'),
  P('drips', 'Drips below the visor', 0.12, 0, 0.6, 0.01, 'Glitch'),
  P('ribbons', 'Ribbons', 0.45, 0, 1, 0.01, 'Glitch'),
  P('streaks', 'Streaks in the columns', 0.7, 0, 1, 0.01, 'Glitch'),
  P('bandShift', 'Eyes behind the visor shifted', 7, 0, 25, 0.5, 'Glitch', 'mm'),
  P('spillMm', 'Face spilling below the visor', 26, 0, 80, 1, 'Glitch', 'mm'),
  P('spillShift', 'Spill shifted', 9, 0, 30, 0.5, 'Glitch', 'mm'),
  P('glitchPhase', 'Glitch phase (moves it up and down)', 0, 0, 20, 0.01, 'Motion'),
  P('glitchMotion', 'How much the phase moves it', 0.6, 0, 1, 0.01, 'Motion'),
  P('glitchScale', 'Noise wavelength along the visor', 40, 5, 200, 1, 'Motion', 'mm'),
];
const BY_ID = new Map(PARAMS.map(p => [p.id, p]));
/** A numeric parameter, clamped, its default when absent. */
export function num(ctx: SketchContext, id: string): number {
  const p = BY_ID.get(id)!;
  return n(ctx, id, p.d, p.min, p.max);
}

export const CONTROLS: Control[] = [
  ...PARAMS.map((p): Control => ({ type: 'slider', id: p.id, label: p.label, default: p.d, min: p.min, max: p.max, step: p.step, group: p.group, ...(p.units ? { units: p.units } : {}), ...(p.head ? { expensive: true } : {}) })),
  { type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'],
    optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no visor, no glitch)' }, group: 'Glitch' },
  ...SLOGAN_CONTROLS,
];

// ── The frame ────────────────────────────────────────────────────────

/**
 * A double frame on the black, `frameMm` wide and `frameInset` in from the trim: a gold band outside, a silver band
 * inside, a hair of black between. The black's art and its shirt and collar windows stay inside it (`inner`); the
 * erasure's windows run on through it to the trim, so the frame is broken only where the glitch takes it.
 */
export interface Frame { outer: Rect; inner: Rect; bands: { pen: Pen; from: number; to: number }[] }

const inRect = (r: Rect, p: Point) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });

export function frameOf(ctx: SketchContext): Frame | undefined {
  const w = num(ctx, 'frameMm');
  if (w <= 0) return undefined;
  const outer = inset(TRIM, num(ctx, 'frameInset'));
  // The art keeps 1.2 mm off the silver band (the knife's clearance, where a window meets the frame).
  return { outer, inner: inset(outer, w + 1.2), bands: [{ pen: 'gold', from: 0, to: w * 0.44 }, { pen: 'silver', from: w * 0.64, to: w }] };
}

/**
 * A frame band as concentric rings exactly `pitch` apart (never closer, so the gel keeps them apart), as many as fit
 * across it with a pen's width to spare, centred in it.
 */
export function frameRings(f: Frame, band: Frame['bands'][number], pitch: number): Point[][] {
  const rings: Point[][] = [];
  const n = Math.max(1, Math.floor((band.to - band.from - 0.4) / pitch + 1e-9) + 1);
  const mid = (band.from + band.to) / 2;
  for (let k = 0; k < n; k++) {
    const r = inset(f.outer, mid + (k - (n - 1) / 2) * pitch);
    rings.push([{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }, { x: r.x0, y: r.y0 }]);
  }
  return rings;
}

// ── The head ─────────────────────────────────────────────────────────

/**
 * Paper kept between cut pieces of the glitch (mm): lifted pieces and fragments stand `INSET` in from their column's
 * sides, so neighbouring columns' pieces keep `2 * INSET` between them even corner to corner, and pieces in one column
 * keep `BRIDGE` between them. (The window's knife radius cannot close a pinch between two corners.)
 */
const INSET = 1.5, BRIDGE = 3;
/** The most pieces a glitch column lifts. */
const MAX_PIECES = 12;
/** Where the crown begins: the head's own height (units above the ears) above which the erasure takes it. */
const CROWN = 0.2;
/** The jaw: below this height of the head (under the lips) a surface turned down is the jaw's underside. */
const JAW = -0.3;
/** How far the plates' hatch stops short of a seam, as a gap between the nearest two plate seeds (head units). */
const SEAM = 0.007;

interface Mark { points: THREE.Vector3[]; pen: Pen; rank: number; id: string }

/** Seeds placed on the features, so the nose, the lips and the chin each sit on one plate. */
const FEATURES: V3[] = [
  [0, -0.11, 0.47], [0, 0.03, 0.4], [0, -0.24, 0.4], [0, -0.41, 0.33], [0, -0.47, 0.2],
  [0.18, -0.05, 0.25], [-0.18, -0.05, 0.25], [0.21, -0.3, 0.12], [-0.21, -0.3, 0.12], [0.12, 0.13, 0.33], [-0.12, 0.13, 0.33],
];

/** What the head contributes: its marks on the sheet, where it and the nose cover it, landmarks placed on the sheet. */
export interface HeadStage { seen: Seen[]; onHead: (p: Point) => boolean; onNose: (p: Point) => boolean; at: (p: V3) => Point; head: ReturnType<typeof sculptHead> }

/**
 * The head stage, kept for the last parameters it was built for: only the head's own parameters (and the seed) change
 * it, so a host that keeps the module loaded (a live viewer's worker) redraws the visor and the glitch without it.
 */
let lastHead: { key: string; stage: HeadStage } | undefined;
const headKey = (ctx: SketchContext, mode: 'cpu' | 'gpu') => JSON.stringify([mode, ctx.seed, ...PARAMS.filter(p => p.head).map(p => num(ctx, p.id))]);
function headStage(ctx: SketchContext): HeadStage {
  const key = headKey(ctx, 'cpu');
  if (lastHead?.key !== key) lastHead = { key, stage: buildHead(ctx) };
  return lastHead.stage;
}

/**
 * The head stage for a live preview (the sketch lab), meshed by `mesher` (on the GPU where there is one,
 * `kit/sculpt-gpu.ts`; else `cpuMesher`) and drawn with its lines' head-or-neck tests read from the vertices: a close
 * likeness of `headStage`'s, cached apart from it so a plot never uses it. `draft` meshes coarser still (`DRAFT_STEP`),
 * for the first frame while a head control moves. Pass it to `erasure`.
 */
const DRAFT_STEP = 0.018;
const previewHeads = new Map<string, { key: string; stage: HeadStage }>();
export async function previewHeadStage(ctx: SketchContext, mesher: GpuMesher | CpuMesher, draft = false): Promise<HeadStage> {
  const step = draft ? Math.max(num(ctx, 'step'), DRAFT_STEP) : num(ctx, 'step');
  const key = headKey(ctx, 'gpu') + step, slot = draft ? 'draft' : 'full';
  if (previewHeads.get(slot)?.key !== key) {
    const { head, transform } = headModel(ctx);
    previewHeads.set(slot, { key, stage: buildHead(ctx, await mesher.mesh(head.sdf, head.lo, head.hi, step, transform)) });
  }
  return previewHeads.get(slot)!.stage;
}

/** `meshSdf` behind the GPU mesher's interface, for a preview where there is no GPU. */
export interface CpuMesher { mesh(sdf: Parameters<typeof meshSdf>[0], lo: V3, hi: V3, step: number, transform: THREE.Matrix4): Promise<SculptMesh> }
export const cpuMesher: CpuMesher = { mesh: async (sdf, lo, hi, step, transform) => meshSdf(sdf, lo, hi, step, transform) };

/** The sculpted head the parameters describe, and its placement in the world. */
function headModel(ctx: SketchContext): { head: ReturnType<typeof sculptHead>; transform: THREE.Matrix4 } {
  const S = 100;
  const face = Object.fromEntries((['noseWidth', 'bridge', 'chin', 'jaw', 'lips', 'brow', 'cheeks', 'ears', 'cranium'] as const).map(k => [k, num(ctx, k)]));
  const head = sculptHead({ noseShape: 'planar', nose: num(ctx, 'noseLength'), tilt: deg(num(ctx, 'tilt')), turn: deg(num(ctx, 'turn')), neck: num(ctx, 'neckLength'), neckR: num(ctx, 'neckWidth'), ...face });
  // Turned (`yaw`), then leaned about the line of sight (`roll`, toward the left of the sheet).
  const transform = new THREE.Matrix4().makeRotationZ(deg(num(ctx, 'roll'))).multiply(new THREE.Matrix4().makeRotationY(deg(num(ctx, 'yaw'))))
    .multiply(new THREE.Matrix4().makeScale(S, S, S));
  return { head, transform };
}

function buildHead(ctx: SketchContext, meshed?: SculptMesh): HeadStage {
  const S = 100;
  const { head, transform } = headModel(ctx);
  const mesh = meshed ?? meshSdf(head.sdf, head.lo, head.hi, num(ctx, 'step'), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const isHead = (p: V3) => head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p);

  // The camera below the chin, looking up; its field of view and offset fitted so the head (chin to crown) is `headMm`
  // tall on the sheet, its crown at `crownY` and its middle at `headX`.
  const target = toW(head.at.chinUnder).lerp(toW(head.at.neckBase), 0.4);
  const D = 8 * S, lookUp = deg(num(ctx, 'lookUp'));
  const sample: THREE.Vector3[] = [];
  for (let v = 0; v < mesh.pos.length; v += 3 * 29) { const p: V3 = [mesh.pos[v], mesh.pos[v + 1], mesh.pos[v + 2]]; if (isHead(p)) sample.push(toW(p)); }
  const headMm = num(ctx, 'headMm');
  const want = { h: headMm, top: num(ctx, 'crownY'), x: num(ctx, 'headX') };
  const camera = (fov: number, ox: number, oy: number) => {
    const c = new THREE.PerspectiveCamera(fov, W / H, 1, 1e6);
    c.position.copy(target).add(new THREE.Vector3(0, -Math.sin(lookUp), Math.cos(lookUp)).multiplyScalar(D));
    c.lookAt(target);
    c.setViewOffset(W, H, ox, oy, W, H);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  let fov = 20, ox = 0, oy = 0;
  for (let it = 0; it < 30; it++) {
    const ps = sample.map(p => pageOf(camera(fov, ox, oy), p, PAGE));
    const y0 = Math.min(...ps.map(p => p.y)), y1 = Math.max(...ps.map(p => p.y));
    const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(fov) / 2) * (y1 - y0) / want.h));
    ox += ((x0 + x1) / 2 - want.x) / MM_X * 0.7;
    oy += (y0 - want.top) / MM_Y * 0.7;
  }
  const view = camera(fov, ox, oy);
  const at = (p: V3) => pageOf(view, toW(p), PAGE);

  const geo = sculptGeometry(mesh);
  fitDepthRange(view, [geo], 0.1, { exact: true });
  const depth = renderDepthBufferCPU([geo], view, W, H);
  const onHead = meshCoverage([geo], view, PAGE, 0);
  const noseGeo = subMesh(mesh, p => { const q = head.unplace(...p); return Math.abs(q[0]) < 0.08 && q[2] > 0.35 && q[1] > -0.19 && q[1] < -0.12 + 0.18 * num(ctx, 'noseFront'); });
  const onNose = meshCoverage([noseGeo], view, PAGE, 1.0);
  noseGeo.dispose();
  const eyeM = modelPoint(mesh, view.position);

  // On black the silver is the light: lit surfaces carry the most lines. Light from above and a little ahead of the
  // face, so the face turned up into it is dense and the jaw's underside sparse. Every fourth line of a family is
  // drawn everywhere (no plate goes bare by the light alone), every second from `TH[1]`, all from `TH[2]`.
  const light = new THREE.Vector3(num(ctx, 'lightX'), 1, num(ctx, 'lightZ')).normalize();
  const exactBrightness = (n: V3) => Math.max(0, new THREE.Vector3(...n).transformDirection(transform).dot(light)) ** 0.8;
  // A preview reads it at the vertices once and interpolates along the edges.
  let brightAt: Float64Array | undefined;
  const brightness = (sp: SurfacePoint) => {
    if (!fast || sp.a === undefined) return exactBrightness(sp.n);
    brightAt ??= perVertex(mesh, (_, n) => exactBrightness(n));
    return atPoint(brightAt, sp);
  };
  const TH = [-1, 0.18, 0.42];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[1];
  const headNy = (p: V3, nv: V3) => { const q = head.unplace(...p), q2 = head.unplace(p[0] + nv[0] * 0.01, p[1] + nv[1] * 0.01, p[2] + nv[2] * 0.01); return (q2[1] - q[1]) / 0.01; };
  const facing = (sp: SurfacePoint) => sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  /** Neck, the ear's whorl, the head's plates; lines stop a little short of the crease where the jaw meets the neck. */
  type Zone = 'neck' | 'ear' | 'plate' | undefined;
  const zoneBy = (seam: number, p: V3): Zone => {
    if (seam > 0.004) return 'neck';
    if (seam > -0.01) return undefined;
    return Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.12 ? 'ear' : 'plate';
  };
  const zoneOf = (p: V3): Zone => zoneBy(head.parts.head(...head.unplace(...p)) - head.parts.neck(...p), p);
  // A preview's head (meshed on the GPU, a likeness already) reads the head-or-neck field at the vertices once and
  // interpolates it along the edges, instead of evaluating it at every point of every line.
  const fast = meshed !== undefined;
  const seamAt = fast ? perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)) : undefined;
  const zoneAt = (sp: SurfacePoint): Zone => (seamAt ? zoneBy(atPoint(seamAt, sp), sp.p) : zoneOf(sp.p));
  /** A preview's lines of one zone are found among the triangles with a vertex near it; a plot's, on the whole mesh. */
  const near = (keep: (p: V3, v: number) => boolean): SculptMesh => {
    if (!fast) return mesh;
    const ok = new Uint8Array(mesh.pos.length / 3);
    for (let v = 0; v < ok.length; v++) ok[v] = keep([mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]], v) ? 1 : 0;
    const tri: number[] = [];
    for (let t = 0; t < mesh.tri.length; t += 3) if (ok[mesh.tri[t]] || ok[mesh.tri[t + 1]] || ok[mesh.tri[t + 2]]) tri.push(mesh.tri[t], mesh.tri[t + 1], mesh.tri[t + 2]);
    return { ...mesh, tri: Uint32Array.from(tri) };
  };
  const marks: Mark[] = [];
  const keepRuns = (lines: IsoLine[], ok: (sp: SurfacePoint) => boolean, toned: boolean, pen: Pen, rank: number, id: string, step = 1) => {
    for (const l of lines) {
      const t = tier(Math.abs(Math.round(l.index / step)));
      let run: SurfacePoint[] = [];
      const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen, rank, id }); run = []; };
      for (const sp of l.points) if (facing(sp) && ok(sp) && (!toned || brightness(sp) >= TH[t])) run.push(sp); else flush();
      flush();
    }
  };
  const hq = (fn: (q: V3) => number) => perVertex(mesh, p => fn(head.unplace(...p)));
  const pitch = num(ctx, 'pitchMm') / headMm;

  // The plates: seeds on the features and scattered over the rest of the head, in the head's own frame.
  const rng = ctx.random('erasure-plates');
  const seeds = scatterOn(mesh, num(ctx, 'plateMm') / headMm, rng, (p, v) => (seamAt ? zoneBy(seamAt[v], p) : zoneOf(p)) === 'plate', FEATURES.map(head.place), p => head.unplace(...p));
  const plates = platesOn(mesh, seeds, p => head.unplace(...p));
  // Each plate's and each seam's own triangles (all three vertices border it): the lines of one are found among those
  // alone, as every other triangle has no value for it.
  const trisOf = new Map<string, number[]>();
  const borders = (v: number) => [plates.plate[v], plates.second[v]];
  const pairOf = (v: number) => { const a = plates.plate[v], b = plates.second[v]; return `${Math.min(a, b)}-${Math.max(a, b)}`; };
  for (let t = 0; t < mesh.tri.length; t += 3) {
    const [a, b, c] = [mesh.tri[t], mesh.tri[t + 1], mesh.tri[t + 2]];
    for (const k of new Set(borders(a))) if (borders(b).includes(k) && borders(c).includes(k)) { const l = trisOf.get(`p${k}`) ?? []; l.push(a, b, c); trisOf.set(`p${k}`, l); }
    if (pairOf(a) === pairOf(b) && pairOf(a) === pairOf(c)) { const l = trisOf.get(`s${pairOf(a)}`) ?? []; l.push(a, b, c); trisOf.set(`s${pairOf(a)}`, l); }
  }
  const only = (key: string): SculptMesh => ({ ...mesh, tri: Uint32Array.from(trisOf.get(key) ?? []) });
  seeds.forEach((s, k) => {
    // Each plate's lines: level planes of the head turned to their own angle. Down the face the planes run along it (they
    // draw the profile again), under the jaw and on the crown they lie level; each is then turned by a seeded angle about
    // the seed's own outward direction (the features hardly). A fifth are cross-hatched, a few left bare.
    const feature = k < FEATURES.length;
    const outward = new THREE.Vector3(s[0], s[1] + 0.05, s[2]).normalize();
    const base = s[1] > CROWN || (s[1] < JAW && s[2] < 0.3) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const swing = (feature ? 0.3 : 1) * num(ctx, 'plateSwing') * (rng() * 2 - 1);
    const dirs = [base.clone().applyAxisAngle(outward, swing)];
    const style = rng();
    if (!feature && style < num(ctx, 'bareShare')) return;
    if (style > 1 - num(ctx, 'crossShare')) dirs.push(dirs[0].clone().applyAxisAngle(outward, 1.2 + 0.4 * rng()));
    for (const [j, d] of dirs.entries()) {
      const value = new Float64Array(mesh.pos.length / 3).fill(NaN);
      const pts = mesh.pos;
      for (let v = 0; v < value.length; v++) {
        if (plates.plate[v] !== k && plates.second[v] !== k) continue;
        const q = head.unplace(pts[3 * v], pts[3 * v + 1], pts[3 * v + 2]);
        value[v] = q[0] * d.x + q[1] * d.y + q[2] * d.z;
      }
      const spacing = pitch * (j ? 1.7 : 1);
      keepRuns(isoLines(only(`p${k}`), value, spacing, rng() * spacing), sp => { const q = fast ? { plate: plates.plate[(sp.t ?? 0) < 0.5 ? sp.a! : sp.b!], gap: atPoint(plates.gap, sp) } : plates.at(sp.p); return q.plate === k && q.gap > SEAM && zoneAt(sp) === 'plate'; }, true, 'silver', 2, 'plate');
    }
  });
  // The seams: a gold line where two plates meet, the zero of the difference of their seeds' distances (smooth, where
  // the gap itself has a crease along the seam), between the hatch of the two stopping short of it either side.
  const pairs = new Set<number>();
  for (let v = 0; v < plates.plate.length; v++) if (plates.gap[v] < 0.03) { const a = plates.plate[v], b = plates.second[v]; pairs.add(Math.min(a, b) * 4096 + Math.max(a, b)); }
  for (const key of pairs) {
    const a = Math.floor(key / 4096), b = key % 4096, sa = seeds[a], sb = seeds[b];
    const value = new Float64Array(mesh.pos.length / 3).fill(NaN);
    for (let v = 0; v < value.length; v++) {
      const pa = plates.plate[v], pb = plates.second[v];
      if (!((pa === a && pb === b) || (pa === b && pb === a))) continue;
      const q = head.unplace(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
      value[v] = Math.hypot(q[0] - sa[0], q[1] - sa[1], q[2] - sa[2]) - Math.hypot(q[0] - sb[0], q[1] - sb[1], q[2] - sb[2]);
    }
    keepRuns(isoLines(only(`s${a}-${b}`), value, 1, 0, [0]), sp => zoneAt(sp) === 'plate', false, 'gold', 1, 'seam');
  }
  // The ear, one silver whorl.
  const earQ = head.unplace(...ear), turn = pitch * 1.3;
  const spiral = { values: hq(q => Math.atan2(q[1] - earQ[1], q[2] - earQ[2])), period: 2 * Math.PI };
  keepRuns(isoLines(near(p => Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.14), hq(q => Math.hypot(q[1] - earQ[1], q[2] - earQ[2]) / turn * 2 * Math.PI), 2 * Math.PI, 0, undefined, spiral), sp => zoneAt(sp) === 'ear', false, 'silver', 2, 'ear');
  // The neck: lines along it, and three gold rings that make it segments.
  const neckMesh = near((_, v) => seamAt![v] > -0.02);
  keepRuns(isoLines(neckMesh, perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03)), pitch / 0.15), sp => zoneAt(sp) === 'neck', true, 'silver', 2, 'neck');
  for (let r = 0; r < num(ctx, 'neckRings'); r++) for (const y of [-0.5 - 0.12 * r]) keepRuns(isoLines(neckMesh, perVertex(mesh, p => p[1]), 1, 0, [y]), sp => zoneAt(sp) === 'neck', false, 'gold', 1, 'ring');
  // The silhouette, and the creases: the jaw's edge (where the face turns under) and the line the jaw meets the neck.
  for (const l of contourLines(mesh, eyeM)) marks.push({ points: toWorld(mesh, l.points), pen: 'gold', rank: 0, id: 'outline' });
  const jawEdge = perVertex(mesh, (p, nv, v) => ((seamAt ? seamAt[v] <= 0 : isHead(p)) && head.unplace(...p)[1] < JAW ? headNy(p, nv) : 1));
  keepRuns(isoLines(mesh, jawEdge, 1, 0, [-0.35]), sp => zoneAt(sp) !== 'ear', false, 'gold', 1, 'crease');
  keepRuns(isoLines(mesh, perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)), 1, 0, [0.004]), () => true, false, 'gold', 1, 'crease');
  // The nose's edges, in gold: the bridge's ridge down the middle, and where its sides turn under to the tip.
  const inNose = (sp: SurfacePoint) => { const q = head.unplace(...sp.p); return Math.abs(q[0]) < 0.07 && q[2] > 0.33 && q[1] > -0.18 && q[1] < 0.04; };
  keepRuns(isoLines(mesh, hq(q => q[0]), 1, 0, [0]), inNose, false, 'gold', 0, 'nose');
  keepRuns(isoLines(mesh, perVertex(mesh, (p, nv) => headNy(p, nv)), 1, 0, [-0.55]), inNose, false, 'gold', 0, 'nose');
  // The nostrils, each a gold ring, black inside; the lips' parting.
  for (const c of head.at.nostrils) keepRuns(isoLines(mesh, perVertex(mesh, p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 1, 0, [0.02]), () => true, false, 'gold', 1, 'nostril');
  keepRuns(isoLines(mesh, hq(q => q[1]), 1, 0, [-0.256]), sp => { const q = head.unplace(...sp.p); return Math.abs(q[0]) < 0.068 && q[2] > 0.3; }, false, 'gold', 1, 'crease');
  // The pink line: the midline from the lower lip, over the chin, under it and down the throat.
  const lip = toW(head.at.lipLower);
  const mid = perVertex(mesh, p => { const q = head.unplace(...p); const w = Math.max(0, Math.min(1, (head.parts.neck(...p) - head.parts.head(...q)) / 0.05 + 0.5)); return w * q[0] + (1 - w) * p[0]; });
  for (const l of isoLines(mesh, mid, 1, 0, [0.004])) {
    const pts = toWorld(mesh, l.points);
    let best = -1, bd = Infinity;
    pts.forEach((p, i) => { const d = p.distanceTo(lip); if (d < bd) { bd = d; best = i; } });
    if (bd > 0.05 * S) continue;
    const down = pts[Math.min(best + 3, pts.length - 1)].y < pts[best].y ? 1 : -1;
    const run: THREE.Vector3[] = [];
    for (let i = best; i >= 0 && i < pts.length; i += down) run.push(pts[i]);
    if (run.length >= 2) marks.push({ points: run, pen: 'fluoro-pink', rank: 0, id: 'pink' });
  }

  const bias = hiddenBias(view, 0.012 * S, view.position.distanceTo(target));
  const seen: Seen[] = [];
  projectStrokes(marks, { view, depth, width: W, height: H, bias }, {
    begin: (mark: Mark) => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const piece of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) if (pathLength(piece) >= 0.6) seen.push({ pen: mark.pen, rank: mark.rank, id: mark.id, piece });
    },
  });
  geo.dispose();
  return { seen, onHead, onNose, at, head };
}

export function erasure(ctx: SketchContext, stage?: HeadStage, options: { preview?: boolean } = {}): Erasure {
  const { seen, onHead, onNose, at, head } = stage ?? headStage(ctx);

  // ── The suit ──────────────────────────────────────────────────────
  const collarY = -num(ctx, 'collarAt');
  const ring: Point[] = [];
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; ring.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)])); }
  const left = ring.reduce((a, b) => (b.x < a.x ? b : a)), right = ring.reduce((a, b) => (b.x > a.x ? b : a));
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), neck: { left, right } };

  // ── The visor, and the glitch it bleeds into ──────────────────────
  // The visor lies on the face like glasses: along the line of the eyes, over them, resting on the bridge of the nose
  // (the nose's lower part stands in front of it), from off the edge behind the head to a little past the tip. In its
  // own frame (u along it, v up from its top edge, both mm) the glitch grows out of it: its top edge breaks into stepped
  // gold columns rising into the crown, the head above is taken apart into slices lifted up the sheet, fragments break
  // off higher, and a few bands of the face spill sideways below it. The columns' heights and the pieces' gaps follow a
  // smooth noise along the visor, read at `glitchPhase`: moving it moves the glitch up and down; every other choice
  // (which column does what) is seeded per column, so it holds still while the phase moves.
  const assembled = ctx.params.view !== 'head';
  const barH = num(ctx, 'barMm');
  const eyesAt = page.eyes;
  const eyeLine = Math.atan2(eyesAt[1].y - eyesAt[0].y, eyesAt[1].x - eyesAt[0].x);
  const tilt = (Math.abs(eyeLine) > Math.PI / 2 ? eyeLine - Math.sign(eyeLine) * Math.PI : eyeLine) + deg(num(ctx, 'barTilt'));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  const eyeMid = { x: (eyesAt[0].x + eyesAt[1].x) / 2, y: (eyesAt[0].y + eyesAt[1].y) / 2 };
  const centre = { x: eyeMid.x + nrm.x * num(ctx, 'eyeInBar') * barH, y: eyeMid.y + nrm.y * num(ctx, 'eyeInBar') * barH };
  /** A point of the visor's frame on the page, and back. */
  const toPage = (u: number, v: number): Point => ({ x: centre.x + dir.x * u - nrm.x * (barH / 2 + v), y: centre.y + dir.y * u - nrm.y * (barH / 2 + v) });
  const toBar = (p: Point) => ({ u: (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y, v: -((p.x - centre.x) * nrm.x + (p.y - centre.y) * nrm.y) - barH / 2 });
  const quad = (u0: number, u1: number, v0: number, v1: number): Point[] => [toPage(u0, v1), toPage(u1, v1), toPage(u1, v0), toPage(u0, v0)];
  const faceDir = Math.sign(toBar(page.noseTip).u - toBar(eyeMid).u) || 1;
  // Off the sheet behind the head: far enough along the visor that its whole height is past the trim.
  let uBack = 0;
  while (uBack * -faceDir < 600) { const a = toPage(uBack, 0), b = toPage(uBack, -barH); if ([a, b].every(q => q.x < TRIM.x0 - 4 || q.x > TRIM.x1 + 4 || q.y < TRIM.y0 - 4 || q.y > TRIM.y1 + 4)) break; uBack -= faceDir; }
  const uFace = toBar(page.noseTip).u + faceDir * num(ctx, 'barPast');
  const [u0, u1] = [Math.min(uBack, uFace), Math.max(uBack, uFace)];
  const bar = clipToTrim(quad(u0, u1, -barH, 0));

  const erosion = num(ctx, 'erosion'), reach = num(ctx, 'riseMm');
  const phase = num(ctx, 'glitchPhase'), motion = num(ctx, 'glitchMotion'), scale = num(ctx, 'glitchScale');
  const noise = gradientNoise(ctx.random('erasure-noise'));
  /** Smooth noise in [0, 1] along the visor at the current phase (`k` picks an independent field). */
  const wave = (u: number, k: number) => 0.5 + 0.5 * noise(u / scale + 17.3 * k, phase * 0.35 + 5.1 * k);
  const mix = (seeded: number, u: number, k: number) => seeded + (wave(u, k) - seeded) * motion;
  const cells: Cell[] = [], fragments: Point[][] = [], drips: Point[][] = [], streaks: Point[][] = [];
  const ribbons: { pen: Pen; path: Point[] }[] = [];
  const inTrim = (q: Point) => q.x > TRIM.x0 + 6 && q.x < TRIM.x1 - 6 && q.y > TRIM.y0 + 6 && q.y < TRIM.y1 - 6;
  const fits = (a: number, b: number, v0: number, v1: number) => quad(a, b, v0, v1).every(inTrim);
  const snap = (v: number) => Math.round(v / 1.5) * 1.5;
  /** How far the head rises above the visor's top edge across [a, b] (the lowest of its tops there). */
  const headRise = (a: number, b: number) => {
    let rise = Infinity;
    for (let u = a; u <= b; u += 0.5) { let v = 0; while (v < 400 && onHead(toPage(u, v + 0.5))) v += 0.5; rise = Math.min(rise, v); }
    return rise;
  };
  let h0 = Infinity, h1 = -Infinity;
  for (let u = u0; u <= u1; u += 0.5) if (onHead(toPage(u, 2))) { h0 = Math.min(h0, u); h1 = Math.max(h1, u); }
  const colMin = num(ctx, 'colMin'), colMax = Math.max(colMin, num(ctx, 'colMax'));
  const lifts = num(ctx, 'liftPieces'), gapScale = num(ctx, 'liftGap');
  const fragChance = num(ctx, 'fragments'), dripChance = num(ctx, 'drips'), ribbonShare = num(ctx, 'ribbons'), streakShare = num(ctx, 'streaks');
  if (assembled) {
    const wrng = ctx.random('erasure-glitch-widths');
    let u = u0;
    for (let index = 0; u < u1 - colMin; index++) {
      const w = Math.min(u1 - u, colMin + (colMax - colMin) * wrng() ** 1.3);
      if (w < colMin) break;
      const a = u, b = u + w, mid = (a + b) / 2;
      u = b;
      const crng = ctx.random(`erasure-glitch-${index}`);
      // Nearer the head the glitch is stronger: the columns taller and more of them lifted.
      const near = h0 < h1 ? Math.max(0, 1 - Math.max(0, h0 - mid, mid - h1) / 90) : 0;
      const rise = headRise(a, b);
      const over = Number.isFinite(rise) && rise > 3;
      // Every seeded choice of the column is drawn up front, a fixed number of draws per stream, so no noise-driven
      // branch (a column too short to stand, a piece that no longer fits) changes which draw a later choice gets.
      const [roll, height, keep, keepAt, dvRoll, liftRoll, count, fragRoll, fragH, fragV, dripRoll, dripH] = Array.from({ length: 12 }, crng);
      const lrng = ctx.random(`erasure-glitch-${index}-lift`), lifted = Array.from({ length: MAX_PIECES }, () => [lrng(), lrng(), lrng(), lrng()]);
      const rrng = ctx.random(`erasure-glitch-${index}-ribbon`), srng = ctx.random(`erasure-glitch-${index}-streak`);
      let top = 0;
      if (roll < 0.35 + 0.15 * near) {
        // A gold column out of the visor's top edge: smeared upward.
        top = snap(reach * (0.08 + 0.92 * mix(height ** 1.6, mid, 0)) * (0.4 + 0.6 * near));
        while (top > 3 && !fits(a, b, 0, top)) top -= 1.5;
        if (top > 3) cells.push({ u0: a, u1: b, v0: -2, v1: top, dv: snap(2 + 6 * dvRoll), kind: 'rise' });
        else top = 0;
      } else if (over && keep > erosion * 0.5) {
        // The head kept, from the visor up to a height of its rise.
        top = snap(rise * (0.3 + 0.7 * mix(keepAt, mid, 1)));
        cells.push({ u0: a, u1: b, v0: -2, v1: top, dv: 0, kind: 'base' });
      }
      // Lifted pieces above: taken from the head (the crown, or the brow under the visor), on the black or the gold.
      if (over && liftRoll < erosion) {
        let ceiling = top;
        const pieces = Math.min(MAX_PIECES, Math.round((2 + 4 * count * (0.5 + near)) * lifts));
        for (let k = 0; k < pieces; k++) {
          const [hRoll, from, gap, gold] = lifted[k], h = 3 + 10 * hRoll;
          const v0 = -barH + 3 + (rise - h + barH - 3) * from;
          const dest = ceiling + Math.max(BRIDGE, (4 + 28 * mix(gap, mid, 2 + k) * (k + 1) ** 0.6) * gapScale);
          if (b - a - 2 * INSET < 2 || !fits(a + INSET, b - INSET, dest, dest + h)) break;
          cells.push({ u0: a + INSET, u1: b - INSET, v0: snap(v0), v1: snap(v0) + snap(h), dv: snap(dest - v0), kind: gold < 0.45 ? 'gold' : 'black' });
          ceiling = dest + h;
        }
        top = ceiling;
      } else if (fragRoll < fragChance * (1 + near)) {
        const h = 3 + 9 * fragH, v0 = top + 5 + 40 * mix(fragV, mid, 7) * (0.5 + near);
        if (b - a - 2 * INSET >= 2 && fits(a + INSET, b - INSET, v0, v0 + h)) { fragments.push(quad(a + INSET, b - INSET, snap(v0), snap(v0 + h))); top = v0 + h; }
      }
      // A drip below the visor now and then.
      if (dripRoll < dripChance * (1 + near)) {
        const h = 2 + 7 * mix(dripH, mid, 8);
        const drip = quad(a, b, -barH - h, -barH + 2);
        if (drip.every(inTrim)) drips.push(drip);
      }
      // Ribbons: from the top edge down along the visor's upward direction, stopping above the column.
      const lanes = Math.floor(w / 3) + 1;
      for (let k = 0; k < lanes; k++) {
        const skip = rrng(), penRoll = rrng(), endRoll = rrng(), kind = rrng(), cap = rrng();
        if (skip > ribbonShare) continue;
        const pen: Pen = penRoll < 0.2 ? 'gold' : 'silver';
        const ur = a + 1.2 + (w - 2.4) * (lanes === 1 ? 0.5 : k / Math.max(1, lanes - 1));
        const end = top + 6 + 30 * mix(endRoll, ur, 9);
        let vTop = end;
        while (vTop < 600 && toPage(ur, vTop).y > TRIM.y0 - 2) vTop += 2;
        if (vTop - end < 10) continue;
        if (kind < 0.3) ribbons.push({ pen, path: [toPage(ur - 0.6, vTop), toPage(ur - 0.6, end), toPage(ur + 0.6, end), toPage(ur + 0.6, vTop)] });
        else {
          ribbons.push({ pen, path: [toPage(ur, vTop), toPage(ur, end)] });
          if (cap < 0.35) ribbons.push({ pen, path: [toPage(ur - 0.9, end - 2), toPage(ur + 0.9, end - 2), toPage(ur + 0.9, end - 6), toPage(ur - 0.9, end - 6), toPage(ur - 0.9, end - 2)] });
        }
      }
      // The gold column smeared: streaks up it, from inside the visor to a height.
      for (const c of cells) if (c.kind === 'rise' && c.u0 === a) {
        for (let us = c.u0 + 0.9, j = 0; us < c.u1 - 0.6; j++) {
          const [step, skip, len] = [srng(), srng(), srng()];
          us += 1.0 + 1.4 * step;
          if (skip > streakShare) continue;
          streaks.push([toPage(us, -barH + 2), toPage(us, Math.min(c.v1 - 1, (c.v1 + 2) * (0.3 + 0.75 * mix(len, us, 10 + j))))]);
        }
      }
    }
  }
  // Bands of the visor and just below it, each drawn shifted along the visor: the eyes behind it on the gold, the face
  // spilling below on the black. The shifts sway with the phase too.
  const brng = ctx.random('erasure-bands');
  const bands = (from: number, to: number, chance: number, shift: number, k: number) => {
    const out: { v0: number; v1: number; du: number }[] = [];
    for (let v = from; v < to;) { const h = 1.5 + 4.5 * brng(), keep = brng(), s = brng(); if (keep < chance) out.push({ v0: v, v1: Math.min(to, v + h), du: (mix(s, v * 3, k) * 2 - 1) * shift }); v += h; }
    return out;
  };
  const visorBands = assembled ? bands(-barH, 0, 1, num(ctx, 'bandShift'), 11) : [];
  const spill = assembled ? bands(-barH - num(ctx, 'spillMm'), -barH, 0.4, num(ctx, 'spillShift'), 12) : [];

  // Where a cell shows: a lifted piece `dv` up from where it was taken; a column or a base where it stands.
  const inCell = (p: Point, kinds: Cell['kind'][]) => {
    const b = toBar(p);
    return cells.some(c => { const dv = c.kind === 'rise' || c.kind === 'base' ? 0 : c.dv; return kinds.includes(c.kind) && b.u >= c.u0 && b.u <= c.u1 && b.v >= c.v0 + dv && b.v <= c.v1 + dv; });
  };
  /** Where the head is taken apart: above the visor's top edge, all along it. */
  const erased = (p: Point) => { if (!assembled) return false; const b = toBar(p); return b.v > -2 && b.u >= u0 && b.u <= u1 && !inCell(p, ['base']); };

  // ── The black's windows ───────────────────────────────────────────
  // The visor (less the lower nose, which stands over it), the gold columns, pieces, fragments and drips, the shirt
  // and collar.
  const shirtRings = suit.shirt;
  // Each shape that opens a window, in one of three groups (the visor and the glitch, less the nose; the shirt, less
  // the tie; the collar's back, less the neck), indexed on a coarse grid of the page by its bounds, so a point is tested
  // only against the shapes that can hold it.
  type Opening = { group: 0 | 1 | 2; holds: (p: Point) => boolean; ring: Point[] };
  const openings: Opening[] = [
    ...(assembled ? [{ group: 0 as const, holds: (p: Point) => insideRing(bar, p), ring: bar }] : []),
    ...cells.filter(c => c.kind === 'rise' || c.kind === 'gold').map(c => {
      const dv = c.kind === 'rise' ? 0 : c.dv, ring = quad(c.u0, c.u1, c.v0 + dv, c.v1 + dv);
      return { group: 0 as const, ring, holds: (p: Point) => { const q = toBar(p); return q.u >= c.u0 && q.u <= c.u1 && q.v >= c.v0 + dv && q.v <= c.v1 + dv; } };
    }),
    ...[...fragments, ...drips].map(r => ({ group: 0 as const, ring: r, holds: (p: Point) => insideRing(r, p) })),
    ...shirtRings.map(r => ({ group: 1 as const, ring: r, holds: (p: Point) => insideRing(r, p) })),
    { group: 2 as const, ring: suit.back, holds: (p: Point) => insideRing(suit.back, p) },
  ];
  const COARSE = 4, gx = Math.ceil(PAGE.width / COARSE) + 1, gy = Math.ceil(PAGE.height / COARSE) + 1;
  const coarse: Opening[][] = Array.from({ length: gx * gy }, () => []);
  const clampG = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(v / COARSE)));
  for (const o of openings) {
    const xs = o.ring.map(q => q.x), ys = o.ring.map(q => q.y);
    for (let j = clampG(Math.min(...ys), gy); j <= clampG(Math.max(...ys), gy); j++) for (let i = clampG(Math.min(...xs), gx); i <= clampG(Math.max(...xs), gx); i++) coarse[j * gx + i].push(o);
  }
  const windowAt = (p: Point) => {
    const here = coarse[clampG(p.y, gy) * gx + clampG(p.x, gx)];
    if (!here.length) return false;
    const inGroup = (g: number) => here.some(o => o.group === g && o.holds(p));
    return (inGroup(0) && !onNose(p)) || (inGroup(1) && !suit.tie.some(r => insideRing(r, p))) || (inGroup(2) && !onHead(p));
  };
  // The frame (when there is one) holds the shirt and collar's windows inside it; only the erasure breaks through it.
  const frame = frameOf(ctx);
  const inGlitch = (p: Point) => { const here = coarse[clampG(p.y, gy) * gx + clampG(p.x, gx)]; return here.some(o => o.group === 0 && o.holds(p)) && !onNose(p); };
  // A preview traces the window at half the resolution: the knife's line only matters on the plotted sheet.
  const window = traceMask(p => windowAt(p) && (!frame || inGlitch(p) || inRect(frame.inner, p)), { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, options.preview ? 0.5 : 0.25, { simplify: options.preview ? 0.15 : 0.08, minRadius: 1.2, minArea: 6 });

  const slogan = assembled ? slogans(ctx, { bar, toPage, toBar, barH, cells, onNose, window, page, art: frame?.inner ?? ART }) : NO_SLOGAN;
  return {
    head: seen, onHead, onNose, bar, toPage, toBar, barH, cells, erased, fragments, drips, streaks, visorBands, spill,
    panels: suit.panels, suitLines: suit.lines, bySuit, shirt: shirtRings, collarBack: suit.back, window, ribbons, page, slogan,
    ...(frame ? { frame } : {}),
  };
}

/** The part of a mesh whose triangles' vertices all pass `keep`, in world units. */
function subMesh(m: SculptMesh, keep: (p: V3) => boolean): THREE.BufferGeometry {
  const ok = new Uint8Array(m.pos.length / 3);
  for (let v = 0; v < ok.length; v++) ok[v] = keep([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]]) ? 1 : 0;
  const tri: number[] = [];
  for (let t = 0; t < m.tri.length; t += 3) if (ok[m.tri[t]] && ok[m.tri[t + 1]] && ok[m.tri[t + 2]]) tri.push(m.tri[t], m.tri[t + 1], m.tri[t + 2]);
  return sculptGeometry({ ...m, tri: Uint32Array.from(tri) });
}

// ── The suit, flat on the sheet ──────────────────────────────────────

/**
 * The suit as flat panels laid out from the neck's two sides where the collar meets it (its width `w` the unit), as
 * Lodestone L's: the jacket and lapels in silver stripes on the black, edged in gold, the tie silver cross-hatched;
 * the shirt and the collar's leaves cut out of the black, the gold behind striped in black ink. The collar's back is
 * seen behind the neck.
 */
function suitOf(left: Point, right: Point): { panels: Panel[]; lines: SuitLine[]; front: Point[][]; shirt: Point[][]; back: Point[]; tie: Point[][] } {
  const c = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, w = right.x - left.x;
  const slope = (right.y - left.y) / (right.x - left.x);
  const P = (u: number, v: number): Point => ({ x: c.x + u * w, y: c.y + v * w + u * w * slope });
  const bottom = TRIM.y1 + 10, L = TRIM.x0 - 10, R = TRIM.x1 + 10;
  const down = (p: Point, x: number): Point => ({ x, y: p.y });
  const knot = [P(-0.1, 0.5), P(0.16, 0.48), P(0.1, 0.82), P(-0.04, 0.82)];
  const blade = [P(-0.04, 0.82), P(0.1, 0.82), { x: P(0.36, 0).x, y: bottom }, { x: P(-0.16, 0).x, y: bottom }];
  const leafL = [P(-0.56, -0.08), P(-0.8, 0.24), P(-0.34, 1.0), P(-0.08, 0.6)];
  const leafR = [P(0.56, -0.12), P(0.82, 0.18), P(0.44, 0.96), P(0.1, 0.58)];
  const back = [P(-0.56, -0.08), P(-0.5, -0.3), P(0.5, -0.36), P(0.56, -0.12)];
  const shirt = [P(-0.34, 1.0), P(-0.08, 0.6), P(0.1, 0.58), P(0.44, 0.96), { x: P(0.5, 0).x, y: bottom }, { x: P(-0.3, 0).x, y: bottom }];
  const lapelL = [P(-0.8, 0.24), P(-1.28, 0.78), P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }, { x: P(-0.3, 0).x, y: bottom }, P(-0.34, 1.0)];
  const lapelR = [P(0.82, 0.18), P(1.2, 0.7), P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom }, { x: P(0.5, 0).x, y: bottom }, P(0.44, 0.96)];
  const jacketL = [P(-0.8, 0.24), down(P(-2.6, 0.62), L), { x: L, y: bottom }, { x: P(-0.42, 0).x, y: bottom }, P(-1.1, 0.98), P(-1.28, 0.78)];
  const jacketR = [P(0.82, 0.18), down(P(2.6, 0.86), R), { x: R, y: bottom }, { x: P(0.62, 0).x, y: bottom }, P(1.04, 0.9), P(1.2, 0.7)];
  const angleOf = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
  const aL = angleOf(P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }), aR = angleOf(P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom });
  const tieAxis = angleOf(P(0.03, 0.82), { x: P(0.1, 0).x, y: bottom });
  const panels: Panel[] = [
    { id: 'jacket-l', ring: jacketL, angle: aL, pitch: 1.0, pen: 'silver', cross: aL + 0.8 },
    { id: 'jacket-r', ring: jacketR, angle: aR, pitch: 1.0, pen: 'silver', cross: aR - 0.8 },
    { id: 'lapel-l', ring: lapelL, angle: angleOf(P(-1.28, 0.78), { x: P(-0.42, 0).x, y: bottom }) + 0.12, pitch: 0.9, pen: 'silver' },
    { id: 'lapel-r', ring: lapelR, angle: angleOf(P(1.2, 0.7), { x: P(0.62, 0).x, y: bottom }) - 0.12, pitch: 0.9, pen: 'silver' },
    { id: 'tie', ring: blade, angle: -0.7, pitch: 1.0, pen: 'silver', cross: 0.7 },
    { id: 'knot', ring: knot, angle: 0.5, pitch: 0.9, pen: 'silver', cross: -0.9 },
    // On the gold under the windows, in black ink.
    { id: 'shirt', ring: shirt, angle: tieAxis, pitch: 1.3, pen: 'black', window: true },
    { id: 'leaf-l', ring: leafL, angle: angleOf(P(-0.8, 0.24), P(-0.34, 1.0)), pitch: 1.4, pen: 'black', window: true },
    { id: 'leaf-r', ring: leafR, angle: angleOf(P(0.82, 0.18), P(0.44, 0.96)), pitch: 1.4, pen: 'black', window: true },
    { id: 'collar-back', ring: back, angle: angleOf(P(-0.5, -0.3), P(0.5, -0.36)), pitch: 1.2, pen: 'black', window: true },
  ];
  const close = (r: Point[]) => [...r, r[0]];
  const lines: SuitLine[] = [
    ...[lapelL, lapelR, knot, blade, jacketL, jacketR].map(r => ({ pen: 'gold' as const, path: close(r) })),
  ];
  return { panels, lines, front: [leafL, leafR, knot, blade, shirt, lapelL, lapelR, jacketL, jacketR], shirt: [leafL, leafR, shirt], back, tie: [knot, blade] };
}

/** A panel's stripes (and its cross stripes), clipped to the panel grown by `grow` and the trim. */
export function panelStripes(p: Panel, grow = 0, clip: Rect = ART): Point[][] {
  const out = stripeFill(p.ring, p.angle, p.pitch, grow);
  if (p.cross !== undefined) out.push(...stripeFill(p.ring, p.cross, p.pitch * 1.6, grow));
  return out.flatMap(path => clipToRect(path, clip)).flatMap(path => (grow ? [path] : keepAlong(path, q => insideRing(p.ring, q), 0.2)));
}

/**
 * Smooth 2D gradient noise (Perlin's, with a seeded permutation), about -1..1: neighbouring inputs give neighbouring
 * values, so a parameter fed through it moves the drawing smoothly.
 */
function gradientNoise(rng: () => number): (x: number, y: number) => number {
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const p = [...perm, ...perm];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => { const a = (h & 7) * Math.PI / 4; return Math.cos(a) * x + Math.sin(a) * y; };
  return (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255, xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = p[p[xi] + yi], ab = p[p[xi] + yi + 1], ba = p[p[xi + 1] + yi], bb = p[p[xi + 1] + yi + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.4;
  };
}
