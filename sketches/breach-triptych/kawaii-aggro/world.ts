import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import {
  atPoint, capsule, contourLines, isoLines, meshSdf, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry, sphere, toWorld,
  type IsoLine, type Sdf, type SculptMesh, type SurfacePoint, type V3,
} from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import type { GpuMesher } from '../../kit/sculpt-gpu.ts';
import { traceMask } from '../../kit/outline.ts';
import { stripeFill } from '../lodestone-cuts.ts';
import { ART, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Kawaii Aggro, the world its sheets share: a fork of Upward Erasure (`../upward-erasure/world.ts`), feminine. A
 * sculpted android girl, head cocked and chin down, glaring out from under a magenta visor whose display shows her
 * eyes in pixels; buns with spikes, pink lips, blush, a spiked metallic-pink choker with a heart. The glitch is not a
 * crown but spread over the whole figure: slices of the sheet slid sideways along the visor (the visor's own rows
 * smearing with them), blocks of gold cut through, magenta and metallic-pink pixel blocks, echoes of the drawing moved
 * elsewhere, hearts and sparkles.
 *
 * Two sheets, as Upward Erasure: the black in front (silver, gold, fluoro pink and the metallic pink, for which the
 * rose gel stands in until there is a metallic pink pen), the gold-yellow behind, showing through windows cut in the
 * black (the glitch's gold blocks, the shirt, the collar's back), with Micron 08 black on it where they show.
 */

const deg = THREE.MathUtils.degToRad;

/** The pens: silver, gold, fluoro pink and the metallic pink (`gel-rose`) on the black; the Micron 08 on the gold. */
export type Pen = 'silver' | 'gold' | 'fluoro-pink' | 'gel-rose' | 'black';
/** The metallic pink's pen: the rose gel stands in for it. */
export const METALLIC: Pen = 'gel-rose';

/** A projected, visible mark, and how the thinning ranks it (0 outlines, 1 seams and creases, 2 hatch). */
export interface Seen { pen: Pen; rank: number; id: string; piece: Point[] }
export interface SuitLine { pen: Pen; path: Point[] }
/** A panel of the suit, striped at `angle`, `pitch` apart, in `pen` (on the gold for a `window`); `solid` fills it. */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }

/**
 * A block of the glitch, in the visor's frame (u along it, v up from its top edge, mm): `gold` cut out of the black
 * (the gold behind shows, with the drawing from `du, dv` away on it in black ink when `echo`), `pink` a magenta pixel
 * block, `rose` a metallic-pink one, `echo` the drawing from `du, dv` away moved into it, `void` the drawing taken out.
 * Every kind clears the drawing under it.
 */
export interface Block { u0: number; u1: number; v0: number; v1: number; kind: 'gold' | 'pink' | 'rose' | 'echo' | 'void'; du: number; dv: number; echo: boolean; striped: boolean }
/** A slice of the sheet across the visor's direction (v0..v1 in its frame), slid `du` along it; a `gap` is taken out. */
export interface Slice { v0: number; v1: number; du: number; gap: boolean }

export interface Scene {
  head: Seen[];
  onHead: (p: Point) => boolean;
  onNose: (p: Point) => boolean;
  toPage: (u: number, v: number) => Point;
  toBar: (p: Point) => { u: number; v: number };
  barH: number;
  /** The visor's outline, its magenta rows (knocked out where the eyes are) and the eyes' silver pixels. */
  visor: Point[];
  visorRows: Point[][];
  eyePixels: Point[][];
  slices: Slice[];
  /** The slice a point is in (an index into `slices`). */
  sliceAt: (p: Point) => number;
  blocks: Block[];
  /** In a block (and which), by its page point. */
  blockAt: (p: Point) => Block | undefined;
  /** Hearts, sparkles and pixel dust: `fill`s are drawn as they are (never thinned). */
  accents: { pen: Pen; path: Point[]; fill?: boolean }[];
  panels: Panel[];
  suitLines: SuitLine[];
  bySuit: (p: Point) => boolean;
  shirt: Point[][];
  collarBack: Point[];
  bow: Point[][];
  window: Point[][];
  page: { eyes: Point[]; noseTip: Point; chin: Point; mouth: Point };
}

// ── Controls ─────────────────────────────────────────────────────────

interface Param { id: string; label: string; d: number; min: number; max: number; step: number; group: string; units?: string; head?: boolean }
const P = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string, head?: boolean): Param => ({ id, label, d, min, max, step, group, ...(units ? { units } : {}), ...(head ? { head } : {}) });
const HEAD = true;

export const PARAMS: Param[] = [
  P('tilt', 'Chin down (−) or tipped back (+)', -6, -30, 40, 1, 'Pose', '°', HEAD),
  P('turn', 'Head turned on the neck', -10, -40, 40, 1, 'Pose', '°', HEAD),
  P('yaw', 'Figure turned (face toward the right)', -10, -90, 90, 1, 'Pose', '°', HEAD),
  P('cock', 'Head cocked on the neck (+ raises her left ear)', 16, -40, 40, 1, 'Pose', '°', HEAD),
  P('roll', 'Whole figure leaning toward the left of the sheet', 0, -40, 40, 1, 'Pose', '°', HEAD),
  P('lookUp', 'Camera looking up (− looks down on her)', 0, -25, 40, 1, 'Pose', '°', HEAD),
  P('noseLength', 'Nose length', 0.9, 0.6, 1.8, 0.05, 'Face', undefined, HEAD),
  P('noseWidth', 'Nose width at the wings', 0.7, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('bridge', 'Nose bridge between the eyes', 0.5, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('chin', 'Chin forward', 0.6, 0, 2.5, 0.05, 'Face', undefined, HEAD),
  P('jaw', 'Jaw', 0.75, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('lips', 'Lips', 1.45, 0.5, 2, 0.05, 'Face', undefined, HEAD),
  P('brow', 'Brow', 0.45, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('cheeks', 'Cheekbones', 1.3, 0.5, 1.8, 0.05, 'Face', undefined, HEAD),
  P('ears', 'Ears', 0.85, 0.6, 1.5, 0.05, 'Face', undefined, HEAD),
  P('cranium', 'Skull height', 1.04, 0.85, 1.2, 0.01, 'Face', undefined, HEAD),
  P('neckLength', 'Neck length', 1.7, 0.8, 2.4, 0.05, 'Face', undefined, HEAD),
  P('neckWidth', 'Neck thickness', 0.12, 0.09, 0.2, 0.005, 'Face', undefined, HEAD),
  P('bunSize', 'Buns (0: none)', 0.13, 0, 0.2, 0.005, 'Buns', undefined, HEAD),
  P('bunSpread', 'Buns apart', 0.2, 0.05, 0.32, 0.005, 'Buns', undefined, HEAD),
  P('bunHeight', 'Buns up the head', 0.42, 0.2, 0.6, 0.01, 'Buns', undefined, HEAD),
  P('bunBack', 'Buns toward the back', 0.06, -0.15, 0.3, 0.01, 'Buns', undefined, HEAD),
  P('spikes', 'Spikes on each bun', 5, 0, 9, 1, 'Buns', undefined, HEAD),
  P('spikeLength', 'Spike length', 0.11, 0.02, 0.3, 0.005, 'Buns', undefined, HEAD),
  P('headMm', 'Head height on the sheet (chin to crown)', 195, 100, 300, 1, 'Framing', 'mm', HEAD),
  P('crownY', 'Crown height on the sheet', 50, 20, 250, 1, 'Framing', 'mm', HEAD),
  P('headX', 'Head across the sheet', 140, 40, 240, 1, 'Framing', 'mm', HEAD),
  P('collarAt', 'Collar on the neck', 0.62, 0.4, 1.6, 0.01, 'Framing'),
  P('pitchMm', 'Densest line pitch', 0.95, 0.8, 3, 0.05, 'Plates', 'mm', HEAD),
  P('plateMm', 'Plate size', 24, 10, 80, 1, 'Plates', 'mm', HEAD),
  P('bareShare', 'Plates left bare', 0.12, 0, 0.6, 0.01, 'Plates', undefined, HEAD),
  P('crossShare', 'Plates cross-hatched', 0.2, 0, 0.8, 0.01, 'Plates', undefined, HEAD),
  P('plateSwing', 'Plates\' line angles vary', 0.8, 0, 1.6, 0.05, 'Plates', undefined, HEAD),
  P('lightX', 'Light from the right', -0.4, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('lightZ', 'Light from the front', 0.7, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('step', 'Mesh detail (cell, head units; larger is faster)', 0.009, 0.006, 0.02, 0.001, 'Plates', undefined, HEAD),
  P('blush', 'Blush (0: none)', 1, 0, 1.6, 0.05, 'Flair', undefined, HEAD),
  P('chokerAt', 'Choker down the neck', 0.52, 0.3, 0.9, 0.01, 'Flair', undefined, HEAD),
  P('chokerSpikes', 'Spikes round the choker', 14, 0, 28, 1, 'Flair', undefined, HEAD),
  P('heart', 'Heart on the choker (0: none)', 1, 0, 1.8, 0.05, 'Flair', undefined, HEAD),
  P('barMm', 'Visor height', 28, 12, 50, 0.5, 'Visor', 'mm'),
  P('barTilt', 'Visor tilt off the eye line', 0, -25, 25, 0.5, 'Visor', '°'),
  P('eyeInBar', 'Visor lower on the eyes', 0, -0.4, 0.4, 0.01, 'Visor'),
  P('barWrap', 'Visor past the head each side', 12, 0, 60, 1, 'Visor', 'mm'),
  P('visorPitch', 'Visor fill pitch (gel fuses at 0.55 and under)', 0.55, 0.4, 1.6, 0.05, 'Visor', 'mm'),
  P('scanlines', 'Visor scanlines dropped', 0.15, 0, 0.7, 0.01, 'Visor'),
  P('noseFront', 'Nose in front of the visor', 0.55, 0, 1, 0.01, 'Visor', undefined, HEAD),
  P('eyePx', 'Eye pixel size', 2, 0.8, 3, 0.05, 'Visor', 'mm'),
  P('glitch', 'Glitch overall', 0.7, 0, 1, 0.01, 'Glitch'),
  P('spreadMm', 'How far the glitch spreads from the head', 110, 20, 400, 1, 'Glitch', 'mm'),
  P('slices', 'Slices slid sideways', 0.6, 0, 1, 0.01, 'Glitch'),
  P('sliceShift', 'How far slices slide', 14, 0, 40, 0.5, 'Glitch', 'mm'),
  P('blocks', 'Blocks', 60, 0, 90, 1, 'Glitch'),
  P('blockMm', 'Largest block', 16, 4, 40, 0.5, 'Glitch', 'mm'),
  P('goldShare', 'Blocks cut to the gold', 0.35, 0, 1, 0.01, 'Glitch'),
  P('pinkShare', 'Blocks magenta', 0.3, 0, 1, 0.01, 'Glitch'),
  P('dust', 'Pixel dust', 0.6, 0, 1, 0.01, 'Glitch'),
  P('hearts', 'Hearts', 7, 0, 16, 1, 'Glitch'),
  P('sparkles', 'Sparkles', 6, 0, 16, 1, 'Glitch'),
  P('glitchPhase', 'Glitch phase (moves it)', 0, 0, 20, 0.01, 'Motion'),
  P('glitchMotion', 'How much the phase moves it', 0.6, 0, 1, 0.01, 'Motion'),
  P('glitchScale', 'Noise wavelength', 40, 5, 200, 1, 'Motion', 'mm'),
];
const BY_ID = new Map(PARAMS.map(p => [p.id, p]));
export function num(ctx: SketchContext, id: string): number {
  const p = BY_ID.get(id)!;
  return n(ctx, id, p.d, p.min, p.max);
}

/** The LED eyes the visor shows. */
const EYES = ['glare', 'sparkle', 'heart', 'cross', 'happy'] as const;
type EyeStyle = typeof EYES[number];
export const CONTROLS: Control[] = [
  ...PARAMS.map((p): Control => ({ type: 'slider', id: p.id, label: p.label, default: p.d, min: p.min, max: p.max, step: p.step, group: p.group, ...(p.units ? { units: p.units } : {}), ...(p.head ? { expensive: true } : {}) })),
  { type: 'select', id: 'eyes', label: 'Eyes on the visor', default: 'glare', options: [...EYES],
    optionLabels: { glare: 'Glare: slanted brows, a sparkle', sparkle: 'Sparkle: big round eyes', heart: 'Hearts', cross: '> <', happy: '^ ^' }, group: 'Visor' },
  { type: 'select', id: 'seamPen', label: 'Plate seams', default: 'metallic', options: ['metallic', 'gold'],
    optionLabels: { metallic: 'Metallic pink', gold: 'Gold' }, group: 'Plates', expensive: true },
  { type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'],
    optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no visor, no glitch)' }, group: 'Glitch' },
];

// ── The head ─────────────────────────────────────────────────────────

/** Where the crown begins (head height above which plates lie level) and the jaw's underside begins. */
const CROWN = 0.2, JAW = -0.3;
/** How far the plates' hatch stops short of a seam (head units). */
const SEAM = 0.007;
/** Paper kept between cut blocks, and between a cut block and the sheet's edge (mm). */
const BRIDGE = 3;

interface Mark { points: THREE.Vector3[]; pen: Pen; rank: number; id: string }

const FEATURES: V3[] = [
  [0, -0.11, 0.47], [0, 0.03, 0.4], [0, -0.24, 0.4], [0, -0.41, 0.33], [0, -0.47, 0.2],
  [0.18, -0.05, 0.25], [-0.18, -0.05, 0.25], [0.21, -0.3, 0.12], [-0.21, -0.3, 0.12], [0.12, 0.13, 0.33], [-0.12, 0.13, 0.33],
];

export interface HeadStage { seen: Seen[]; onHead: (p: Point) => boolean; onNose: (p: Point) => boolean; at: (p: V3) => Point; head: ReturnType<typeof sculptHead> }

let lastHead: { key: string; stage: HeadStage } | undefined;
const headKey = (ctx: SketchContext, mode: 'cpu' | 'gpu') => JSON.stringify([mode, ctx.seed, ctx.params.seamPen, ...PARAMS.filter(p => p.head).map(p => num(ctx, p.id))]);
function headStage(ctx: SketchContext): HeadStage {
  const key = headKey(ctx, 'cpu');
  if (lastHead?.key !== key) lastHead = { key, stage: buildHead(ctx) };
  return lastHead.stage;
}

const DRAFT_STEP = 0.018;
const previewHeads = new Map<string, { key: string; stage: HeadStage }>();
/** The head stage for the sketch lab, meshed by `mesher` (as Upward Erasure's `previewHeadStage`). */
export async function previewHeadStage(ctx: SketchContext, mesher: GpuMesher | CpuMesher, draft = false): Promise<HeadStage> {
  const step = draft ? Math.max(num(ctx, 'step'), DRAFT_STEP) : num(ctx, 'step');
  const key = headKey(ctx, 'gpu') + step, slot = draft ? 'draft' : 'full';
  if (previewHeads.get(slot)?.key !== key) {
    const { head, transform } = headModel(ctx);
    previewHeads.set(slot, { key, stage: buildHead(ctx, await mesher.mesh(head.sdf, head.lo, head.hi, step, transform)) });
  }
  return previewHeads.get(slot)!.stage;
}

export interface CpuMesher { mesh(sdf: Parameters<typeof meshSdf>[0], lo: V3, hi: V3, step: number, transform: THREE.Matrix4): Promise<SculptMesh> }
export const cpuMesher: CpuMesher = { mesh: async (sdf, lo, hi, step, transform) => meshSdf(sdf, lo, hi, step, transform) };

/** The buns and their spikes, in the head's own frame: each bun a sphere, each spike a cone out of it, fanned upward and out. */
function buns(ctx: SketchContext): [Sdf, number][] {
  const r = num(ctx, 'bunSize');
  if (r <= 0.005) return [];
  const out: [Sdf, number][] = [];
  const count = Math.round(num(ctx, 'spikes')), len = num(ctx, 'spikeLength');
  for (const s of [1, -1]) {
    const c: V3 = [s * num(ctx, 'bunSpread'), num(ctx, 'bunHeight'), -0.08 - num(ctx, 'bunBack')];
    out.push([sphere(c, r), 0.035]);
    // The spikes fan over the bun's outer, upper side: about the line from the skull's middle through the bun.
    const axis = new THREE.Vector3(c[0], c[1] - 0.1, c[2] + 0.07).normalize();
    const side = new THREE.Vector3(0, 0, 1).cross(axis).normalize(), up = axis.clone().cross(side).normalize();
    for (let k = 0; k < count; k++) {
      const a = count === 1 ? 0 : -0.95 + 1.9 * k / (count - 1);
      const d = axis.clone().multiplyScalar(Math.cos(a)).add(up.clone().multiplyScalar(Math.sin(a) * (k % 2 ? 1 : 0.8))).add(side.clone().multiplyScalar(Math.sin(a) * 0.45 * s)).normalize();
      const base: V3 = [c[0] + d.x * r * 0.6, c[1] + d.y * r * 0.6, c[2] + d.z * r * 0.6];
      const tip: V3 = [c[0] + d.x * (r + len), c[1] + d.y * (r + len), c[2] + d.z * (r + len)];
      out.push([capsule(base, tip, 0.032, 0.004), 0.015]);
    }
  }
  return out;
}

function headModel(ctx: SketchContext): { head: ReturnType<typeof sculptHead>; transform: THREE.Matrix4 } {
  const S = 100;
  const face = Object.fromEntries((['noseWidth', 'bridge', 'chin', 'jaw', 'lips', 'brow', 'cheeks', 'ears', 'cranium'] as const).map(k => [k, num(ctx, k)]));
  const head = sculptHead({ noseShape: 'planar', nose: num(ctx, 'noseLength'), tilt: deg(num(ctx, 'tilt')), turn: deg(num(ctx, 'turn')), cock: deg(num(ctx, 'cock')), neck: num(ctx, 'neckLength'), neckR: num(ctx, 'neckWidth'), extras: buns(ctx), ...face });
  const transform = new THREE.Matrix4().makeRotationZ(deg(num(ctx, 'roll'))).multiply(new THREE.Matrix4().makeRotationY(deg(num(ctx, 'yaw'))))
    .multiply(new THREE.Matrix4().makeScale(S, S, S));
  return { head, transform };
}

/** A heart's outline in its own plane (unit about 1 across, point down, y up), from the classic parametric curve. */
export function heartRing(k = 48): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < k; i++) {
    const t = 2 * Math.PI * i / k;
    out.push({ x: 16 * Math.sin(t) ** 3 / 34, y: (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 34 + 0.12 });
  }
  return out;
}

/** Rows `pitch` apart across a ring at `angle` (in the ring's own units), each cut exactly at the ring's edges. */
export function rowsIn(ring: Point[], pitch: number, angle = 0): Point[][] {
  const c = Math.cos(angle), s = Math.sin(angle);
  // In the rows' frame: x along them, y across.
  const q = ring.map(p => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c }));
  const ys = q.map(p => p.y), out: Point[][] = [];
  const back = (x: number, y: number): Point => ({ x: x * c - y * s, y: x * s + y * c });
  for (let y = Math.min(...ys) + pitch / 2; y < Math.max(...ys); y += pitch) {
    const xs: number[] = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    xs.sort((m, k) => m - k);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) out.push([back(xs[i], y), back(xs[i + 1], y)]);
  }
  return out;
}

function buildHead(ctx: SketchContext, meshed?: SculptMesh): HeadStage {
  const S = 100;
  const { head, transform } = headModel(ctx);
  const mesh = meshed ?? meshSdf(head.sdf, head.lo, head.hi, num(ctx, 'step'), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const isHead = (p: V3) => head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p);

  // The camera fitted so the head (buns included) is `headMm` tall, its crown at `crownY` and its middle at `headX`;
  // `lookUp` below zero raises it above her, looking down.
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

  const light = new THREE.Vector3(num(ctx, 'lightX'), 1, num(ctx, 'lightZ')).normalize();
  const exactBrightness = (nv: V3) => Math.max(0, new THREE.Vector3(...nv).transformDirection(transform).dot(light)) ** 0.8;
  let brightAt: Float64Array | undefined;
  const brightness = (sp: SurfacePoint) => {
    if (!fast || sp.a === undefined) return exactBrightness(sp.n);
    brightAt ??= perVertex(mesh, (_, nv) => exactBrightness(nv));
    return atPoint(brightAt, sp);
  };
  const TH = [-1, 0.18, 0.42];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[1];
  const headNy = (p: V3, nv: V3) => { const q = head.unplace(...p), q2 = head.unplace(p[0] + nv[0] * 0.01, p[1] + nv[1] * 0.01, p[2] + nv[2] * 0.01); return (q2[1] - q[1]) / 0.01; };
  const facing = (sp: SurfacePoint) => sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  type Zone = 'neck' | 'ear' | 'plate' | undefined;
  const zoneBy = (seam: number, p: V3): Zone => {
    if (seam > 0.004) return 'neck';
    if (seam > -0.01) return undefined;
    return Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.12 ? 'ear' : 'plate';
  };
  const zoneOf = (p: V3): Zone => zoneBy(head.parts.head(...head.unplace(...p)) - head.parts.neck(...p), p);
  const fast = meshed !== undefined;
  const seamAt = fast ? perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)) : undefined;
  const zoneAt = (sp: SurfacePoint): Zone => (seamAt ? zoneBy(atPoint(seamAt, sp), sp.p) : zoneOf(sp.p));
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
  const seamPen: Pen = ctx.params.seamPen === 'gold' ? 'gold' : METALLIC;

  // The lips and the blush, in the head's own frame: their own pink lines, the plates' hatch kept off them.
  const inLips = (q: V3) => {
    const x = Math.abs(q[0]) / 0.072;
    if (x >= 1 || q[2] < 0.33) return false;
    const top = -0.256 + 0.028 * (1 - x ** 1.6) - 0.007 * Math.exp(-((x / 0.18) ** 2)), bot = -0.256 - 0.034 * (1 - x ** 1.8);
    return q[1] < top && q[1] > bot;
  };
  const blush = num(ctx, 'blush');
  const inBlush = (q: V3) => blush > 0.02 && [1, -1].some(s => ((q[0] - s * 0.17) / (0.07 * blush)) ** 2 + ((q[1] + 0.1) / (0.035 * blush)) ** 2 < 1 && q[2] > 0.12);
  const accent = (sp: SurfacePoint) => { const q = head.unplace(...sp.p); return inLips(q) || inBlush(q); };

  // The plates.
  const rng = ctx.random('kawaii-plates');
  const seeds = scatterOn(mesh, num(ctx, 'plateMm') / headMm, rng, (p, v) => (seamAt ? zoneBy(seamAt[v], p) : zoneOf(p)) === 'plate', FEATURES.map(head.place), p => head.unplace(...p));
  const plates = platesOn(mesh, seeds, p => head.unplace(...p));
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
      keepRuns(isoLines(only(`p${k}`), value, spacing, rng() * spacing), sp => { const q = fast ? { plate: plates.plate[(sp.t ?? 0) < 0.5 ? sp.a! : sp.b!], gap: atPoint(plates.gap, sp) } : plates.at(sp.p); return q.plate === k && q.gap > SEAM && zoneAt(sp) === 'plate' && !accent(sp); }, true, 'silver', 2, 'plate');
    }
  });
  // The seams, in the metallic pink (or gold).
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
    keepRuns(isoLines(only(`s${a}-${b}`), value, 1, 0, [0]), sp => zoneAt(sp) === 'plate' && !accent(sp), false, seamPen, 1, 'seam');
  }
  // The ear's whorl.
  const earQ = head.unplace(...ear), turn = pitch * 1.3;
  const spiral = { values: hq(q => Math.atan2(q[1] - earQ[1], q[2] - earQ[2])), period: 2 * Math.PI };
  keepRuns(isoLines(near(p => Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.14), hq(q => Math.hypot(q[1] - earQ[1], q[2] - earQ[2]) / turn * 2 * Math.PI), 2 * Math.PI, 0, undefined, spiral), sp => zoneAt(sp) === 'ear', false, 'silver', 2, 'ear');
  // The neck's lines, kept off the choker.
  const chokerY = -num(ctx, 'chokerAt'), bandH = 0.035;
  const onBand = (y: number) => y < chokerY + 0.006 && y > chokerY - bandH - 0.006;
  const neckMesh = near((_, v) => seamAt![v] > -0.02);
  keepRuns(isoLines(neckMesh, perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03)), pitch / 0.15), sp => zoneAt(sp) === 'neck' && !onBand(sp.p[1]), true, 'silver', 2, 'neck');
  // The silhouette and the creases, gold.
  // (Not inside the lips: their outline is all of them.)
  for (const l of contourLines(mesh, eyeM)) {
    let run: SurfacePoint[] = [];
    const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen: 'gold', rank: 0, id: 'outline' }); run = []; };
    for (const sp of l.points) if (inLips(head.unplace(...sp.p))) flush(); else run.push(sp);
    flush();
  }
  const jawEdge = perVertex(mesh, (p, nv, v) => ((seamAt ? seamAt[v] <= 0 : isHead(p)) && head.unplace(...p)[1] < JAW ? headNy(p, nv) : 1));
  keepRuns(isoLines(mesh, jawEdge, 1, 0, [-0.35]), sp => zoneAt(sp) !== 'ear', false, 'gold', 1, 'crease');
  keepRuns(isoLines(mesh, perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)), 1, 0, [0.004]), () => true, false, 'gold', 1, 'crease');
  // The nose, a few gold edges (a small, plain nose: no nostrils).
  const inNose = (sp: SurfacePoint) => { const q = head.unplace(...sp.p); return Math.abs(q[0]) < 0.07 && q[2] > 0.33 && q[1] > -0.18 && q[1] < 0.04; };
  keepRuns(isoLines(mesh, hq(q => q[0]), 1, 0, [0]), inNose, false, 'gold', 0, 'nose');
  keepRuns(isoLines(mesh, perVertex(mesh, (p, nv) => headNy(p, nv)), 1, 0, [-0.55]), inNose, false, 'gold', 0, 'nose');
  // The lips: their outline in fluoro pink, nothing more (the plates' hatch kept out of them). The outline is the zero
  // of a field negative inside the lips' lens and rising away from it, so it closes at the corners.
  const lipEdge = (q: V3) => {
    const x = Math.abs(q[0]) / 0.072;
    if (x >= 1) return (Math.abs(q[0]) - 0.072) + Math.abs(q[1] + 0.256);
    const top = -0.256 + 0.028 * (1 - x ** 1.6) - 0.007 * Math.exp(-((x / 0.18) ** 2)), bot = -0.256 - 0.034 * (1 - x ** 1.8);
    return Math.max(q[1] - top, bot - q[1]);
  };
  keepRuns(isoLines(near(p => Math.abs(head.unplace(...p)[1] + 0.256) < 0.08), hq(lipEdge), 1, 0, [0]), sp => head.unplace(...sp.p)[2] > 0.33, false, 'fluoro-pink', 0, 'lips');
  // The blush: short slanted strokes across each cheek, //// as drawn on a face.
  if (blush > 0.02) keepRuns(isoLines(near(p => inBlush(head.unplace(...p))), hq(q => q[0] - 0.55 * q[1]), 2.4 / headMm), sp => inBlush(head.unplace(...sp.p)), false, 'fluoro-pink', 1, 'blush');
  // The pink line: the midline from the lower lip, over the chin and down the throat (the series' thread).
  const lip = toW(head.at.lipLower);
  const mid = perVertex(mesh, p => { const q = head.unplace(...p); const w = Math.max(0, Math.min(1, (head.parts.neck(...p) - head.parts.head(...q)) / 0.05 + 0.5)); return w * q[0] + (1 - w) * p[0]; });
  // The choker: a metallic-pink band round the neck, spikes out of its lower edge, a heart hanging at the front.
  const chokerAt = (y: number) => (sp: SurfacePoint) => zoneAt(sp) === 'neck' && Math.abs(sp.p[1] - y) < bandH;
  for (const l of isoLines(mesh, mid, 1, 0, [0.004])) {
    const pts = toWorld(mesh, l.points);
    let best = -1, bd = Infinity;
    pts.forEach((p, i) => { const d = p.distanceTo(lip); if (d < bd) { bd = d; best = i; } });
    if (bd > 0.05 * S) continue;
    const down = pts[Math.min(best + 3, pts.length - 1)].y < pts[best].y ? 1 : -1;
    const run: THREE.Vector3[] = [];
    // The line stops at the choker.
    for (let i = best; i >= 0 && i < pts.length; i += down) { if (l.points[i].p[1] < chokerY + bandH * 0.6) break; run.push(pts[i]); }
    if (run.length >= 2) marks.push({ points: run, pen: 'fluoro-pink', rank: 0, id: 'pink' });
  }
  const bandMesh = near(p => Math.abs(p[1] - (chokerY - bandH / 2)) < bandH * 1.5);
  keepRuns(isoLines(bandMesh, perVertex(mesh, p => p[1]), 1, 0, [chokerY, chokerY - bandH]), chokerAt(chokerY - bandH / 2), false, METALLIC, 0, 'choker');
  keepRuns(isoLines(bandMesh, perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03)), 0.6 / headMm / 0.13), sp => zoneAt(sp) === 'neck' && sp.p[1] < chokerY && sp.p[1] > chokerY - bandH, false, METALLIC, 0, 'choker');
  // Where the neck's surface is at height y, a turn `a` round it (from the front): marched in from outside.
  const axisAt = (y: number): V3 => { const t = (y + 0.12) / (-0.22 - num(ctx, 'neckLength') + 0.12); return [0, y, -0.07 + 0.06 * Math.max(0, Math.min(1, t))]; };
  const surfaceAt = (y: number, a: number): { p: V3; out: V3 } => {
    const c = axisAt(y), out: V3 = [Math.sin(a), 0, Math.cos(a)];
    let r = 0.45;
    while (r > 0 && head.sdf(c[0] + out[0] * r, y, c[2] + out[2] * r) > 0) r -= 0.002;
    return { p: [c[0] + out[0] * r, y, c[2] + out[2] * r], out };
  };
  const lower = chokerY - bandH, spikes = Math.round(num(ctx, 'chokerSpikes'));
  for (let k = 0; k < spikes; k++) {
    const a = 2 * Math.PI * (k + 0.5) / spikes;
    const { p, out } = surfaceAt(lower, a);
    const t: V3 = [Math.cos(a), 0, -Math.sin(a)], w = 0.016, len = 0.045;
    const tri: V3[] = [[p[0] - t[0] * w, p[1], p[2] - t[2] * w], [p[0] + out[0] * len, p[1] - len * 0.5, p[2] + out[2] * len], [p[0] + t[0] * w, p[1], p[2] + t[2] * w]];
    marks.push({ points: tri.map(toW), pen: 'silver', rank: 0, id: 'spike' });
  }
  const heart = num(ctx, 'heart');
  if (heart > 0.02) {
    const hs = 0.05 * heart, { p } = surfaceAt(lower - hs * 0.7, 0);
    const lift = (q: Point): V3 => [p[0] + q.x * hs, p[1] + q.y * hs, p[2] + 0.015];
    const ring = heartRing();
    marks.push({ points: [...ring, ring[0]].map(q => toW(lift(q))), pen: METALLIC, rank: 0, id: 'heart' });
    for (const row of rowsIn(ring, 0.55 / headMm / hs)) marks.push({ points: row.map(q => toW(lift(q))), pen: 'fluoro-pink', rank: 0, id: 'heart' });
    // Its loop up to the band.
    marks.push({ points: [lift({ x: 0, y: 0.55 }), [p[0], lower, p[2] + 0.012]].map(q => toW(q as V3)), pen: 'silver', rank: 0, id: 'heart' });
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

// ── The sheet: the visor, the glitch, the suit ───────────────────────

/** The LED eyes, as pixel rows (top first): X lit (silver), o dark, . the visor's pink. The inner side (toward the
 * other eye) is on the right; the eye nearer the visor's start is drawn as given, the other mirrored. */
const EYE_GLYPHS: Record<EyeStyle, string[]> = {
  glare: [
    'XX.........',
    '.XXXX......',
    '...XXXXX...',
    '......XXX..',
    '...........',
    '..XXXXXX...',
    '.XXooXXXX..',
    'XXXooXXXXX.',
    'XXXXXXXXXX.',
    '.XXXXXXXX..',
    '..XXXXX....',
  ],
  sparkle: [
    '...XXXXX...',
    '..XXXXXXX..',
    '.XXooXXXXX.',
    'XXXooXXXXXX',
    'XXXXXXXXXXX',
    'XXXXXXXoXXX',
    'XXXXXXXXXXX',
    '.XXXXXXXXX.',
    '..XXXXXXX..',
    '...XXXXX...',
  ],
  heart: [
    '.XXX...XXX.',
    'XXoXX.XXXXX',
    'XXXXXXXXXXX',
    'XXXXXXXXXXX',
    '.XXXXXXXXX.',
    '..XXXXXXX..',
    '...XXXXX...',
    '....XXX....',
    '.....X.....',
  ],
  cross: [
    'XX.......',
    '.XXX.....',
    '...XXX...',
    '.....XXX.',
    '...XXX...',
    '.XXX.....',
    'XX.......',
  ],
  happy: [
    '....XXX....',
    '..XXX.XXX..',
    '.XX.....XX.',
    'XX.......XX',
  ],
};

export function scene(ctx: SketchContext, stage?: HeadStage, options: { preview?: boolean } = {}): Scene {
  const { seen, onHead, onNose, at, head } = stage ?? headStage(ctx);

  // ── The suit ──────────────────────────────────────────────────────
  const collarY = -num(ctx, 'collarAt');
  const ring: Point[] = [];
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; ring.push(at([0.13 * Math.sin(a), collarY, -0.04 + 0.13 * Math.cos(a)])); }
  const left = ring.reduce((a, b) => (b.x < a.x ? b : a)), right = ring.reduce((a, b) => (b.x > a.x ? b : a));
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));
  const mouth = at(head.at.lipUpper);
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), mouth };

  // ── The visor ─────────────────────────────────────────────────────
  // Along the line of the eyes, over them, wrapping a little past the head on both sides, its ends pointed. In its
  // frame (u along it, v up from its top edge, mm).
  const assembled = ctx.params.view !== 'head';
  const barH = num(ctx, 'barMm');
  const eyesAt = page.eyes;
  const eyeLine = Math.atan2(eyesAt[1].y - eyesAt[0].y, eyesAt[1].x - eyesAt[0].x);
  const tilt = (Math.abs(eyeLine) > Math.PI / 2 ? eyeLine - Math.sign(eyeLine) * Math.PI : eyeLine) + deg(num(ctx, 'barTilt'));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  const eyeMid = { x: (eyesAt[0].x + eyesAt[1].x) / 2, y: (eyesAt[0].y + eyesAt[1].y) / 2 };
  const centre = { x: eyeMid.x + nrm.x * num(ctx, 'eyeInBar') * barH, y: eyeMid.y + nrm.y * num(ctx, 'eyeInBar') * barH };
  const toPage = (u: number, v: number): Point => ({ x: centre.x + dir.x * u - nrm.x * (barH / 2 + v), y: centre.y + dir.y * u - nrm.y * (barH / 2 + v) });
  const toBar = (p: Point) => ({ u: (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y, v: -((p.x - centre.x) * nrm.x + (p.y - centre.y) * nrm.y) - barH / 2 });
  const quad = (u0: number, u1: number, v0: number, v1: number): Point[] => [toPage(u0, v1), toPage(u1, v1), toPage(u1, v0), toPage(u0, v0)];
  // The head's extent along the visor's middle.
  let h0 = 0, h1 = 0;
  for (let u = -300; u <= 300; u += 0.5) if (onHead(toPage(u, -barH / 2))) { if (h0 === 0 && h1 === 0) h0 = u; h1 = u; }
  const wrap = num(ctx, 'barWrap'), tip = barH * 0.45;
  const vu0 = h0 - wrap, vu1 = h1 + wrap;
  /** The visor's left and right edges at height v: pointed at its middle. */
  const edges = (v: number) => { const k = Math.min(1, Math.abs(v + barH / 2) / (barH / 2)); return [vu0 + tip * (1 - k), vu1 - tip * (1 - k)] as const; };
  const visor = assembled ? [toPage(vu0, -barH / 2), toPage(vu0 + tip, 0), toPage(vu1 - tip, 0), toPage(vu1, -barH / 2), toPage(vu1 - tip, -barH), toPage(vu0 + tip, -barH), toPage(vu0, -barH / 2)] : [];

  // The noise the glitch moves by.
  const phase = num(ctx, 'glitchPhase'), motion = num(ctx, 'glitchMotion'), scale = num(ctx, 'glitchScale');
  const noise = gradientNoise(ctx.random('kawaii-noise'));
  const wave = (x: number, k: number) => 0.5 + 0.5 * noise(x / scale + 17.3 * k, phase * 0.35 + 5.1 * k);
  const mix = (seeded: number, x: number, k: number) => seeded + (wave(x, k) - seeded) * motion;
  const glitch = assembled ? num(ctx, 'glitch') : 0;
  const spread = num(ctx, 'spreadMm');

  // ── The slices: the sheet cut across the visor's direction, some slid along it ───
  // Every slice is drawn up front (a fixed number of draws each), so the phase only moves the shifts.
  const corners = [TRIM.x0, TRIM.x1].flatMap(x => [TRIM.y0, TRIM.y1].map(y => toBar({ x, y }).v));
  const vLo = Math.min(...corners) - 10, vHi = Math.max(...corners) + 10;
  const srng = ctx.random('kawaii-slices');
  const slices: Slice[] = [];
  /** How strongly the glitch holds at a height in the visor's frame: 1 in the visor, falling away from it. */
  const nearV = (v: number) => Math.exp(-Math.max(0, Math.abs(v + barH / 2) - barH / 2) / spread);
  for (let v = vLo; v < vHi;) {
    const hh = 1.5 + 5.5 * srng() ** 1.5, keep = srng(), s = srng(), gapRoll = srng();
    const w = nearV(v + hh / 2);
    const moved = keep < num(ctx, 'slices') * glitch * (0.25 + 0.75 * w);
    slices.push({ v0: v, v1: v + hh, du: moved ? (mix(s, v * 3, 3) * 2 - 1) * num(ctx, 'sliceShift') * (0.4 + 0.6 * w) : 0, gap: moved && gapRoll < 0.12 });
    v += hh;
  }
  const sliceAt = (p: Point) => {
    const v = toBar(p).v;
    let lo = 0, hi = slices.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (slices[m].v0 <= v) lo = m; else hi = m - 1; }
    return lo;
  };

  // ── The visor's rows, knocked out for the eyes ────────────────────
  const eyeStyle: EyeStyle = EYES.includes(ctx.params.eyes as EyeStyle) ? ctx.params.eyes as EyeStyle : 'glare';
  const glyph = EYE_GLYPHS[eyeStyle];
  // The display's two eyes, centred on her eyes' middle, as large as the visor allows (not as far apart as her eyes,
  // which a turned head brings together).
  const cols = Math.max(...glyph.map(r => r.length)), rows = glyph.length;
  const px = Math.min(num(ctx, 'eyePx'), (barH - 2.5) / rows);
  const mids = eyesAt.map(toBar).sort((a, b) => a.u - b.u), midU = (mids[0].u + mids[1].u) / 2;
  const apart = Math.max(mids[1].u - mids[0].u, (cols + 3) * px);
  const eyeUV = [{ u: midU - apart / 2 }, { u: midU + apart / 2 }];
  /** Each eye's pixels: lit or dark, as boxes in the visor's frame. */
  const pixels: { u0: number; u1: number; v0: number; v1: number; lit: boolean }[] = [];
  if (assembled && px > 0.4) eyeUV.forEach((e, i) => {
    glyph.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const cc = i === 0 ? c : cols - 1 - c;
      const u = e.u + (cc - (cols - 1) / 2) * px, v = -barH / 2 + ((rows - 1) / 2 - r) * px;
      pixels.push({ u0: u - px / 2, u1: u + px / 2, v0: v - px / 2, v1: v + px / 2, lit: ch === 'X' });
    }));
  });
  const visorRows: Point[][] = [], eyePixels: Point[][] = [];
  if (assembled) {
    const vp = num(ctx, 'visorPitch'), drop = num(ctx, 'scanlines');
    const grng = ctx.random('kawaii-scanlines');
    let group = -1, dropped = false;
    for (let v = -barH + vp / 2, i = 0; v < 0; v += vp, i++) {
      // Scanlines: three rows at a time, some dropped.
      if (Math.floor(i / 3) !== group) { group = Math.floor(i / 3); dropped = mix(grng(), group * 4, 4) < drop; }
      if (dropped) continue;
      const [a, b] = edges(v);
      // The row less the eyes' pixels.
      const holes = pixels.filter(q => v >= q.v0 && v <= q.v1).map(q => [q.u0, q.u1] as const).sort((x, y) => x[0] - y[0]);
      let from = a;
      const runs: [number, number][] = [];
      for (const [h0u, h1u] of holes) { if (h0u > from) runs.push([from, Math.min(h0u, b)]); from = Math.max(from, h1u); }
      if (from < b) runs.push([from, b]);
      for (const [r0, r1] of runs) if (r1 - r0 > 0.3) visorRows.push([toPage(r0, v), toPage(r1, v)]);
    }
    // The lit pixels, silver rows close enough to fuse.
    for (const q of pixels) if (q.lit) for (let v = q.v0 + 0.22; v < q.v1 - 0.1; v += 0.42) eyePixels.push([toPage(q.u0 + 0.12, v), toPage(q.u1 - 0.12, v)]);
  }

  // ── The blocks ────────────────────────────────────────────────────
  // Sampled over the sheet, more of them nearer the head; sizes on a 1.5 mm grid, as pixels. Each block draws a fixed
  // number of values from its own stream, so one block's fate never changes the next one's.
  const headC = (() => { const ps = [...eyesAt, page.chin, page.noseTip]; return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length - 15 }; })();
  const nearHead = (p: Point) => Math.exp(-Math.max(0, Math.hypot(p.x - headC.x, p.y - headC.y) - 70) / spread);
  const snap = (x: number) => Math.round(x / 1.5) * 1.5;
  const inTrim = (q: Point, m = 6) => q.x > TRIM.x0 + m && q.x < TRIM.x1 - m && q.y > TRIM.y0 + m && q.y < TRIM.y1 - m;
  // (and the heart on the choker)
  const face = [page.noseTip, mouth, page.chin, at([0, -num(ctx, 'chokerAt') - 0.08, 0.1])];
  const blocks: Block[] = [];
  const overlaps = (b: Omit<Block, 'kind' | 'du' | 'dv' | 'echo' | 'striped'>, gap: number) => blocks.some(o => b.u0 < o.u1 + gap && b.u1 > o.u0 - gap && b.v0 < o.v1 + gap && b.v1 > o.v0 - gap);
  const count = Math.round(num(ctx, 'blocks') * glitch), big = num(ctx, 'blockMm');
  const uLo = Math.min(...[TRIM.x0, TRIM.x1].flatMap(x => [TRIM.y0, TRIM.y1].map(y => toBar({ x, y }).u))), uHi = Math.max(...[TRIM.x0, TRIM.x1].flatMap(x => [TRIM.y0, TRIM.y1].map(y => toBar({ x, y }).u)));
  for (let i = 0, tries = 0; blocks.length < count && tries < count * 40; tries++, i++) {
    const brng = ctx.random(`kawaii-block-${i}`);
    const [ru, rv, rw, rh, accept, kindRoll, du, dv, echoRoll, stripeRoll] = Array.from({ length: 10 }, brng);
    const w = snap(2 + (big - 2) * rw ** 1.6), h = snap(1.5 + (big * 0.6 - 1.5) * rh ** 1.6);
    const u0 = snap(uLo + (uHi - uLo) * mix(ru, i * 7, 5)), v0 = snap(vLo + (vHi - vLo) * mix(rv, i * 7, 6));
    const b = { u0, u1: u0 + w, v0, v1: v0 + h };
    const mid = toPage((b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2);
    if (accept > 0.25 + 0.75 * Math.max(nearHead(mid), nearV((b.v0 + b.v1) / 2) * 0.7)) continue;
    const ring = quad(b.u0, b.u1, b.v0, b.v1);
    if (!ring.every(q => inTrim(q, 2))) continue;
    // The face's middle stays readable: nose, mouth and chin.
    if (face.some(f => Math.hypot(f.x - mid.x, f.y - mid.y) < 9 + Math.max(w, h) / 2)) continue;
    const gold = kindRoll < num(ctx, 'goldShare');
    const share = (1 - num(ctx, 'goldShare')) || 1, rest = (kindRoll - num(ctx, 'goldShare')) / share;
    const kind: Block['kind'] = gold ? 'gold' : rest < num(ctx, 'pinkShare') ? 'pink' : rest < num(ctx, 'pinkShare') + 0.2 ? 'rose' : rest < num(ctx, 'pinkShare') + 0.32 ? 'void' : 'echo';
    // A cut block keeps paper round it and is big enough to cut cleanly.
    if (gold && (w < 4.5 || h < 4.5 || !ring.every(q => inTrim(q, BRIDGE + 3)) || overlaps(b, BRIDGE))) continue;
    if (!gold && overlaps(b, 1.5)) continue;
    blocks.push({ ...b, kind, du: snap((du * 2 - 1) * 40), dv: snap((dv * 2 - 1) * 25), echo: kind === 'echo' || (gold && echoRoll < 0.55), striped: stripeRoll < 0.35 });
  }
  const blockAt = (p: Point) => { const q = toBar(p); return blocks.find(b => q.u >= b.u0 && q.u <= b.u1 && q.v >= b.v0 && q.v <= b.v1); };

  // ── Accents: block fills, hearts, sparkles, pixel dust ────────────
  const accents: Scene['accents'] = [];
  const vp = num(ctx, 'visorPitch');
  for (const b of blocks) {
    const ring = quad(b.u0, b.u1, b.v0, b.v1);
    if (b.kind === 'pink') for (let v = b.v0 + vp / 2, i = 0; v < b.v1; v += vp, i++) { if (b.striped && Math.floor(i / 2) % 2) continue; accents.push({ pen: 'fluoro-pink', path: [toPage(b.u0, v), toPage(b.u1, v)], fill: true }); }
    if (b.kind === 'rose') {
      accents.push({ pen: METALLIC, path: [...ring, ring[0]], fill: true });
      for (const row of rowsIn(ring, 1.1, tilt + Math.PI / 4)) accents.push({ pen: METALLIC, path: row, fill: true });
    }
    if (b.kind === 'echo') accents.push({ pen: 'silver', path: [...ring, ring[0]] });
  }
  const arng = ctx.random('kawaii-accents');
  const clear = (p: Point, r: number) => !blockAt(p) && !onHead(p) && inTrim(p, r + 4) && !insideRing(visor.length ? visor : [p, p, p], p) && Math.hypot(p.x - headC.x, p.y - headC.y) < 70 + spread * 1.6;
  const placed: { p: Point; r: number }[] = [];
  const free = (p: Point, r: number) => clear(p, r) && placed.every(o => Math.hypot(o.p.x - p.x, o.p.y - p.y) > o.r + r + 2);
  const scatter = (k: number, rOf: (roll: number) => number, draw: (p: Point, r: number, a: number, style: number) => void) => {
    for (let i = 0, done = 0; done < k && i < k * 40; i++) {
      const [rx, ry, rr, ra, rs] = Array.from({ length: 5 }, arng);
      const r = rOf(rr), p = { x: headC.x + (rx * 2 - 1) * (80 + spread), y: headC.y + (ry * 2 - 1) * (80 + spread) * 1.2 };
      if (!assembled || !free(p, r)) continue;
      placed.push({ p, r });
      draw(p, r, (ra * 2 - 1) * 0.45, rs);
      done++;
    }
  };
  const turned = (ps: Point[], c: Point, r: number, a: number) => ps.map(q => ({ x: c.x + (q.x * Math.cos(a) - -q.y * Math.sin(a)) * r, y: c.y + (q.x * Math.sin(a) + -q.y * Math.cos(a)) * r }));
  const heartShape = heartRing();
  scatter(Math.round(num(ctx, 'hearts') * (0.3 + 0.7 * glitch)), rr => 3 + 4.5 * rr, (p, r, a, style) => {
    const ring2 = turned(heartShape, p, r * 2, a);
    if (style < 0.55) { for (const row of rowsIn(ring2, vp, tilt)) accents.push({ pen: 'fluoro-pink', path: row, fill: true }); }
    accents.push({ pen: style < 0.55 ? METALLIC : style < 0.8 ? 'fluoro-pink' : 'silver', path: [...ring2, ring2[0]], fill: true });
  });
  scatter(Math.round(num(ctx, 'sparkles') * (0.3 + 0.7 * glitch)), rr => 2 + 3.5 * rr, (p, r, a) => {
    // A four-point sparkle: two thin diamonds crossed.
    const star: Point[] = [];
    for (let k = 0; k < 8; k++) { const t = a + k * Math.PI / 4, rad = k % 2 ? r * 0.22 : r; star.push({ x: p.x + Math.cos(t) * rad, y: p.y + Math.sin(t) * rad }); }
    accents.push({ pen: 'silver', path: [...star, star[0]] });
  });
  const dust = Math.round(num(ctx, 'dust') * glitch * 70);
  for (let i = 0; i < dust; i++) {
    const [ru, rv, rs, rp] = Array.from({ length: 4 }, arng);
    const s = 0.9 + 1.4 * rs, u = snap(uLo + (uHi - uLo) * ru), v = snap(vLo + (vHi - vLo) * rv);
    const c = toPage(u, v);
    if (rp > 0.1 + 0.9 * Math.max(nearHead(c), nearV(v))) continue;
    if (!free(c, s)) continue;
    placed.push({ p: c, r: s });
    const sq = quad(u - s / 2, u + s / 2, v - s / 2, v + s / 2);
    accents.push({ pen: rp < 0.4 ? 'fluoro-pink' : rp < 0.6 ? METALLIC : 'silver', path: [...sq, sq[0]] });
  }

  // ── The black's windows ───────────────────────────────────────────
  // The gold blocks, the shirt (less the bow) and the collar's back (less the neck).
  type Opening = { group: 0 | 1 | 2; holds: (p: Point) => boolean; ring: Point[] };
  const openings: Opening[] = [
    ...blocks.filter(b => b.kind === 'gold').map(b => ({ group: 0 as const, ring: quad(b.u0, b.u1, b.v0, b.v1), holds: (p: Point) => { const q = toBar(p); return q.u >= b.u0 && q.u <= b.u1 && q.v >= b.v0 && q.v <= b.v1; } })),
    ...suit.shirt.map(r => ({ group: 1 as const, ring: r, holds: (p: Point) => insideRing(r, p) })),
    { group: 2 as const, ring: suit.back, holds: (p: Point) => insideRing(suit.back, p) },
  ];
  const COARSE = 4, gx = Math.ceil(PAGE.width / COARSE) + 1, gy = Math.ceil(PAGE.height / COARSE) + 1;
  const coarse: Opening[][] = Array.from({ length: gx * gy }, () => []);
  const clampG = (v: number, k: number) => Math.max(0, Math.min(k - 1, Math.floor(v / COARSE)));
  for (const o of openings) {
    const xs = o.ring.map(q => q.x), ys = o.ring.map(q => q.y);
    for (let j = clampG(Math.min(...ys), gy); j <= clampG(Math.max(...ys), gy); j++) for (let i = clampG(Math.min(...xs), gx); i <= clampG(Math.max(...xs), gx); i++) coarse[j * gx + i].push(o);
  }
  const windowAt = (p: Point) => {
    const here = coarse[clampG(p.y, gy) * gx + clampG(p.x, gx)];
    if (!here.length) return false;
    const inGroup = (g: number) => here.some(o => o.group === g && o.holds(p));
    return (inGroup(0) && !onNose(p)) || (inGroup(1) && !suit.bow.some(r => insideRing(r, p))) || (inGroup(2) && !onHead(p));
  };
  const window = traceMask(windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, options.preview ? 0.5 : 0.25, { simplify: options.preview ? 0.15 : 0.08, minRadius: 1.2, minArea: 6 });

  return {
    head: seen, onHead, onNose, toPage, toBar, barH, visor, visorRows, eyePixels, slices, sliceAt, blocks, blockAt, accents,
    panels: suit.panels, suitLines: suit.lines, bySuit, shirt: suit.shirt, collarBack: suit.back, bow: suit.bow, window, page,
  };
}

function subMesh(m: SculptMesh, keep: (p: V3) => boolean): THREE.BufferGeometry {
  const ok = new Uint8Array(m.pos.length / 3);
  for (let v = 0; v < ok.length; v++) ok[v] = keep([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]]) ? 1 : 0;
  const tri: number[] = [];
  for (let t = 0; t < m.tri.length; t += 3) if (ok[m.tri[t]] && ok[m.tri[t + 1]] && ok[m.tri[t + 2]]) tri.push(m.tri[t], m.tri[t + 1], m.tri[t + 2]);
  return sculptGeometry({ ...m, tri: Uint32Array.from(tri) });
}

// ── The suit ─────────────────────────────────────────────────────────

/**
 * Upward Erasure's suit, cut for her: the jacket and lapels silver on the black, piped in the metallic pink; the shirt
 * and collar cut out of the black onto the gold; and for the tie a bow, sharp-cornered, magenta, its knot and tails.
 */
function suitOf(left: Point, right: Point): { panels: Panel[]; lines: SuitLine[]; front: Point[][]; shirt: Point[][]; back: Point[]; bow: Point[][] } {
  const c = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, w = right.x - left.x;
  const slope = (right.y - left.y) / (right.x - left.x);
  const P = (u: number, v: number): Point => ({ x: c.x + u * w, y: c.y + v * w + u * w * slope });
  const bottom = TRIM.y1 + 10, L = TRIM.x0 - 10, R = TRIM.x1 + 10;
  const down = (p: Point, x: number): Point => ({ x, y: p.y });
  const leafL = [P(-0.56, -0.08), P(-0.8, 0.24), P(-0.34, 1.0), P(-0.08, 0.6)];
  const leafR = [P(0.56, -0.12), P(0.82, 0.18), P(0.44, 0.96), P(0.1, 0.58)];
  const back = [P(-0.56, -0.08), P(-0.5, -0.3), P(0.5, -0.36), P(0.56, -0.12)];
  const shirt = [P(-0.34, 1.0), P(-0.08, 0.6), P(0.1, 0.58), P(0.44, 0.96), { x: P(0.5, 0).x, y: bottom }, { x: P(-0.3, 0).x, y: bottom }];
  const lapelL = [P(-0.8, 0.24), P(-1.28, 0.78), P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }, { x: P(-0.3, 0).x, y: bottom }, P(-0.34, 1.0)];
  const lapelR = [P(0.82, 0.18), P(1.2, 0.7), P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom }, { x: P(0.5, 0).x, y: bottom }, P(0.44, 0.96)];
  const jacketL = [P(-0.8, 0.24), down(P(-2.6, 0.62), L), { x: L, y: bottom }, { x: P(-0.42, 0).x, y: bottom }, P(-1.1, 0.98), P(-1.28, 0.78)];
  const jacketR = [P(0.82, 0.18), down(P(2.6, 0.86), R), { x: R, y: bottom }, { x: P(0.62, 0).x, y: bottom }, P(1.04, 0.9), P(1.2, 0.7)];
  // The bow: two sharp wings from a knot, two tails under it.
  const knot = [P(-0.1, 0.56), P(0.13, 0.55), P(0.15, 0.78), P(-0.09, 0.79)];
  const wingL = [P(-0.08, 0.6), P(-0.78, 0.36), P(-0.62, 0.72), P(-0.86, 1.02), P(-0.07, 0.76)];
  const wingR = [P(0.12, 0.58), P(0.84, 0.32), P(0.66, 0.68), P(0.9, 0.98), P(0.14, 0.74)];
  const tailL = [P(-0.06, 0.76), P(-0.34, 1.5), P(-0.2, 1.42), P(-0.12, 1.62), P(0.04, 0.78)];
  const tailR = [P(0.06, 0.78), P(0.32, 1.46), P(0.2, 1.4), P(0.16, 1.62), P(0.12, 0.76)];
  const angleOf = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
  const aL = angleOf(P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }), aR = angleOf(P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom });
  const panels: Panel[] = [
    { id: 'jacket-l', ring: jacketL, angle: aL, pitch: 2.2, pen: 'silver' },
    { id: 'jacket-r', ring: jacketR, angle: aR, pitch: 2.2, pen: 'silver' },
    { id: 'lapel-l', ring: lapelL, angle: angleOf(P(-1.28, 0.78), { x: P(-0.42, 0).x, y: bottom }) + 0.12, pitch: 1.3, pen: 'silver' },
    { id: 'lapel-r', ring: lapelR, angle: angleOf(P(1.2, 0.7), { x: P(0.62, 0).x, y: bottom }) - 0.12, pitch: 1.3, pen: 'silver' },
    { id: 'shirt', ring: shirt, angle: angleOf(P(0.03, 0.82), { x: P(0.1, 0).x, y: bottom }), pitch: 1.3, pen: 'black', window: true },
    { id: 'leaf-l', ring: leafL, angle: angleOf(P(-0.8, 0.24), P(-0.34, 1.0)), pitch: 1.4, pen: 'black', window: true },
    { id: 'leaf-r', ring: leafR, angle: angleOf(P(0.82, 0.18), P(0.44, 0.96)), pitch: 1.4, pen: 'black', window: true },
    { id: 'collar-back', ring: back, angle: angleOf(P(-0.5, -0.3), P(0.5, -0.36)), pitch: 1.2, pen: 'black', window: true },
    // The bow, magenta: wings and tails fused solid, the knot metallic pink.
    { id: 'bow-l', ring: wingL, angle: angleOf(P(-0.08, 0.6), P(-0.78, 0.36)), pitch: 0.55, pen: 'fluoro-pink' },
    { id: 'bow-r', ring: wingR, angle: angleOf(P(0.12, 0.58), P(0.84, 0.32)), pitch: 0.55, pen: 'fluoro-pink' },
    { id: 'tail-l', ring: tailL, angle: angleOf(P(-0.06, 0.76), P(-0.34, 1.5)), pitch: 0.55, pen: 'fluoro-pink' },
    { id: 'tail-r', ring: tailR, angle: angleOf(P(0.06, 0.78), P(0.32, 1.46)), pitch: 0.55, pen: 'fluoro-pink' },
    { id: 'knot', ring: knot, angle: 1.2, pitch: 0.55, pen: METALLIC },
  ];
  const close = (r: Point[]) => [...r, r[0]];
  const lines: SuitLine[] = [
    ...[lapelL, lapelR, jacketL, jacketR].map(r => ({ pen: METALLIC, path: close(r) })),
    ...[wingL, wingR, tailL, tailR, knot].map(r => ({ pen: METALLIC, path: close(r) })),
  ];
  const bow = [wingL, wingR, tailL, tailR, knot];
  return { panels, lines, front: [leafL, leafR, shirt, lapelL, lapelR, jacketL, jacketR, ...bow], shirt: [leafL, leafR, shirt], back, bow };
}

/** A panel's stripes (and its cross stripes), clipped to the panel grown by `grow` and the art. */
export function panelStripes(p: Panel, grow = 0, clip: Rect = ART): Point[][] {
  const out = stripeFill(p.ring, p.angle, p.pitch, grow);
  if (p.cross !== undefined) out.push(...stripeFill(p.ring, p.cross, p.pitch * 1.6, grow));
  return out.flatMap(path => clipToRect(path, clip)).flatMap(path => (grow ? [path] : keepAlong(path, q => insideRing(p.ring, q), 0.2)));
}

/** Smooth 2D gradient noise (Perlin's, seeded), about -1..1. */
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
