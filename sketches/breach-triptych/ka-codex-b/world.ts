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
import { stripeFill } from '../lodestone-cuts.ts';
import { clipToRegion, distanceToRings, offsetRing, ringsSimple } from '../../../packages/plot-core/src/region.ts';
import { ART, convexHull, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Ka-Codex B / Graphic cut-paper bob: a sculpted android looks down from under a flat magenta visor. A gold-paper
 * bob is cut through the black sheet around her head: its fringe shares the visor's line and its blunt side curtains
 * stop at the jaw. Square fragments shear horizontally out of the visor and hair toward one side of the page.
 *
 * The black front carries silver and gold skin engravings, fused fluoro-pink and gel-rose blocks, and the visor. The
 * gold-yellow back reads as the hair through the three bob windows, with restrained black strands. This keeps the
 * glamour graphic and sharp instead of literal: no props, icons, or cartoon face marks.
 *
 * The head is a sculpted human head whose skin is plates: each engraved in lines of its own direction (a few
 * cross-hatched, a few left bare), with a groove of two gold lines at every seam.
 */

const deg = THREE.MathUtils.degToRad;

/** The black ply's gels and the Micron 08 reserved for the gold ply. */
export type Pen = 'silver' | 'gold' | 'fluoro-pink' | 'gel-rose' | 'black';
/** The rose gel is the metallic-pink accent in this variation. */
export const METALLIC: Pen = 'gel-rose';

/** A projected, visible mark, and how the thinning ranks it (0 outlines, 1 seams and creases, 2 hatch). */
export interface Seen { pen: Pen; rank: number; id: string; piece: Point[] }


/** A line of the quiet collar and jacket. */
export interface SuitLine { pen: Pen; path: Point[] }

/** A simple striped suit panel. */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }

/** A fixed, page-aligned mosaic cell. `dx`/`dy` take its copied drawing from source to target. */
export interface MosaicBlock {
  x0: number; x1: number; y0: number; y1: number;
  kind: 'gold' | 'pink' | 'rose' | 'echo';
  dx: number; dy: number;
  /** The source is in the visor, so its magenta fill is punched out before the piece lands elsewhere. */
  source?: boolean;
}

export interface Erasure {
  head: Seen[];
  onHead: (p: Point) => boolean;
  onNose: (p: Point) => boolean;
  /** The magenta bar: a square-ended black-ply fill, never a window. */
  visor: Point[];
  visorRows: Point[][];
  visorEdge: Point[][];
  /** The visor's frame: a point (u along it, v up from its top edge) on the page, and back; its height. */
  toPage: (u: number, v: number) => Point;
  toBar: (p: Point) => { u: number; v: number };
  barH: number;
  /** Upper hair and its two lower curtains, all windows through the black. */
  bob: Point[][];
  /** Long Micron strands on the gold, clipped safely inside the bob. */
  bobInk: Point[][];
  blocks: MosaicBlock[];
  inBob: (p: Point) => boolean;
  inVisor: (p: Point) => boolean;
  panels: Panel[];
  suitLines: SuitLine[];
  bySuit: (p: Point) => boolean;
  window: Point[][];
  page: { eyes: Point[]; noseTip: Point; chin: Point; mouth: Point; neck: { left: Point; right: Point } };
}

// ── Controls ─────────────────────────────────────────────────────────

/** One numeric parameter: its control, and whether it shapes the head (so changing it rebuilds the head's lines). */
interface Param { id: string; label: string; d: number; min: number; max: number; step: number; group: string; units?: string; head?: boolean }
const P = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string, head?: boolean): Param => ({ id, label, d, min, max, step, group, ...(units ? { units } : {}), ...(head ? { head } : {}) });
/** Marks a parameter that shapes the head. */
const HEAD = true;

/** Every numeric parameter, in the order the controls show them. */
export const PARAMS: Param[] = [
  P('tilt', 'Chin down (−) or tipped back (+)', -16, -30, 40, 1, 'Pose', '°', HEAD),
  P('turn', 'Head turned on the neck', 2, -40, 40, 1, 'Pose', '°', HEAD),
  P('yaw', 'Figure turned', 7, -90, 90, 1, 'Pose', '°', HEAD),
  P('cock', 'Head cocked (+ raises left ear)', 12, -40, 40, 1, 'Pose', '°', HEAD),
  P('roll', 'Whole figure leaning', 0, -40, 40, 1, 'Pose', '°', HEAD),
  P('noseLength', 'Nose length', 0.9, 0.6, 1.8, 0.05, 'Face', undefined, HEAD),
  P('noseWidth', 'Nose width at the wings', 0.7, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('bridge', 'Nose bridge between the eyes', 0.5, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('chin', 'Chin forward', 0.6, 0, 2.5, 0.05, 'Face', undefined, HEAD),
  P('jaw', 'Jaw', 0.8, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('lips', 'Lips', 1.25, 0.5, 2, 0.05, 'Face', undefined, HEAD),
  P('brow', 'Brow glare', 1.45, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('cheeks', 'Cheekbones', 1.1, 0.5, 1.8, 0.05, 'Face', undefined, HEAD),
  P('ears', 'Ears', 0.8, 0.6, 1.5, 0.05, 'Face', undefined, HEAD),
  P('cranium', 'Skull height', 0.9, 0.85, 1.2, 0.01, 'Face', undefined, HEAD),
  P('neckLength', 'Neck length', 2.05, 0.8, 2.4, 0.05, 'Face', undefined, HEAD),
  P('neckWidth', 'Neck thickness', 0.115, 0.09, 0.2, 0.005, 'Face', undefined, HEAD),
  P('headMm', 'Head height on the sheet', 216, 100, 300, 1, 'Framing', 'mm', HEAD),
  P('crownY', 'Crown height on the sheet', 55, 20, 250, 1, 'Framing', 'mm', HEAD),
  P('headX', 'Head across the sheet', 140, 40, 240, 1, 'Framing', 'mm', HEAD),
  P('lookUp', 'Camera looking up', 0, -25, 40, 1, 'Framing', '°', HEAD),
  P('collarAt', 'Collar on the neck', 0.7, 0.4, 1.6, 0.01, 'Framing'),
  P('pitchMm', 'Densest line pitch', 0.95, 0.8, 3, 0.05, 'Plates', 'mm', HEAD),
  P('plateMm', 'Plate size', 27, 10, 80, 1, 'Plates', 'mm', HEAD),
  P('bareShare', 'Plates left bare', 0.12, 0, 0.6, 0.01, 'Plates', undefined, HEAD),
  P('crossShare', 'Plates cross-hatched', 0.2, 0, 0.8, 0.01, 'Plates', undefined, HEAD),
  P('plateSwing', 'Plates\' line angles vary', 0.8, 0, 1.6, 0.05, 'Plates', undefined, HEAD),
  P('lightX', 'Light from the right', 0.35, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('lightZ', 'Light from the front', 0.55, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('neckRings', 'Neck segment rings', 2, 0, 6, 1, 'Plates', undefined, HEAD),
  P('step', 'Mesh detail (cell, head units; larger is faster)', 0.009, 0.006, 0.02, 0.001, 'Plates', undefined, HEAD),
  P('barMm', 'Visor height', 26, 22, 30, 0.5, 'Visor', 'mm'),
  P('barTilt', 'Visor tilt off the eye line', 0, -25, 25, 0.5, 'Visor', '°'),
  P('eyeInBar', 'Visor lower on the eyes', 0, -0.4, 0.4, 0.01, 'Visor'),
  P('noseFront', 'Nose in front of visor', 0.45, 0, 1, 0.01, 'Visor', undefined, HEAD),
  P('barWrap', 'Visor past the bob', 8, 0, 30, 1, 'Visor', 'mm'),
  // A magenta visor is a fused fill, never an adjustable visible-line treatment: it must remain at 0.5 mm.
  P('visorPitch', 'Visor fill pitch', 0.5, 0.5, 0.5, 0.05, 'Visor', 'mm'),
  P('bobMargin', 'Bob outside the skull', 10, 3, 22, 0.5, 'Bob', 'mm'),
  P('strandPitch', 'Hair-strand spacing', 3.6, 2.5, 5, 0.1, 'Bob', 'mm'),
  P('cell', 'Mosaic cell', 3, 3, 9, 0.5, 'Glitch', 'mm'),
  P('glitch', 'Mosaic density', 0.7, 0, 1, 0.01, 'Glitch'),
  P('reachMm', 'Mosaic reach', 120, 30, 230, 1, 'Glitch', 'mm'),
  P('goldShare', 'Gold-window share', 0.25, 0, 1, 0.01, 'Glitch'),
  P('pinkShare', 'Magenta share', 0.43, 0, 1, 0.01, 'Glitch'),
  P('roseShare', 'Metallic-pink share', 0.12, 0, 1, 0.01, 'Glitch'),
  P('echoShare', 'Drawing echo share', 0.2, 0, 1, 0.01, 'Glitch'),
  P('glitchPhase', 'Glitch phase (moves mosaic)', 0, 0, 20, 0.01, 'Motion'),
  P('glitchMotion', 'How much the phase moves it', 0.6, 0, 1, 0.01, 'Motion'),
  P('glitchScale', 'Motion wavelength', 40, 5, 200, 1, 'Motion', 'mm'),
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
  { type: 'select', id: 'driftSide', label: 'Mosaic drifts', default: 'auto', options: ['auto', 'left', 'right'],
    optionLabels: { auto: 'Away from the raised ear', left: 'To the left', right: 'To the right' }, group: 'Glitch' },
];

// ── The head ─────────────────────────────────────────────────────────

/** One empty page-grid cell separates every independent gold window. */
const BRIDGE = 3;
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
  const head = sculptHead({ noseShape: 'planar', nose: num(ctx, 'noseLength'), tilt: deg(num(ctx, 'tilt')), turn: deg(num(ctx, 'turn')), cock: deg(num(ctx, 'cock')), neck: num(ctx, 'neckLength'), neckR: num(ctx, 'neckWidth'), ...face });
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
  /** A small lens on the surface: plates and seams leave it quiet for the single pink lip outline. */
  const inLips = (q: V3) => {
    const x = Math.abs(q[0]) / 0.072;
    if (x >= 1 || q[2] < 0.33) return false;
    const top = -0.256 + 0.028 * (1 - x ** 1.6) - 0.007 * Math.exp(-((x / 0.18) ** 2));
    const bottom = -0.256 - 0.034 * (1 - x ** 1.8);
    return q[1] < top && q[1] > bottom;
  };

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
      keepRuns(isoLines(only(`p${k}`), value, spacing, rng() * spacing), sp => { const q = fast ? { plate: plates.plate[(sp.t ?? 0) < 0.5 ? sp.a! : sp.b!], gap: atPoint(plates.gap, sp) } : plates.at(sp.p); return q.plate === k && q.gap > SEAM && zoneAt(sp) === 'plate' && !inLips(head.unplace(...sp.p)); }, true, 'silver', 2, 'plate');
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
    keepRuns(isoLines(only(`s${a}-${b}`), value, 1, 0, [0]), sp => zoneAt(sp) === 'plate' && !inLips(head.unplace(...sp.p)), false, 'gold', 1, 'seam');
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
  // The nostrils remain mechanical gold rings; the lips are only a restrained fluoro-pink outline.
  for (const c of head.at.nostrils) keepRuns(isoLines(mesh, perVertex(mesh, p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 1, 0, [0.02]), () => true, false, 'gold', 1, 'nostril');
  const lipEdge = (q: V3) => {
    const x = Math.abs(q[0]) / 0.072;
    if (x >= 1) return (Math.abs(q[0]) - 0.072) + Math.abs(q[1] + 0.256);
    const top = -0.256 + 0.028 * (1 - x ** 1.6) - 0.007 * Math.exp(-((x / 0.18) ** 2));
    const bottom = -0.256 - 0.034 * (1 - x ** 1.8);
    return Math.max(q[1] - top, bottom - q[1]);
  };
  keepRuns(isoLines(near(p => Math.abs(head.unplace(...p)[1] + 0.256) < 0.08), hq(lipEdge), 1, 0, [0]), sp => head.unplace(...sp.p)[2] > 0.33, false, 'fluoro-pink', 0, 'lips');

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

/** The two-ply sheet world: projected bob, visor, page-grid mosaic, and a deliberately quiet suit. */
export function erasure(ctx: SketchContext, stage?: HeadStage, options: { preview?: boolean } = {}): Erasure {
  const { seen, onHead, onNose, at, head } = stage ?? headStage(ctx);
  const assembled = ctx.params.view !== 'head';

  // The suit starts at a sampled neck circle, so it follows the same slightly cocked pose as the head.
  const collarY = -num(ctx, 'collarAt'), neckRing: Point[] = [];
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; neckRing.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)])); }
  const left = neckRing.reduce((a, b) => (b.x < a.x ? b : a)), right = neckRing.reduce((a, b) => (b.x > a.x ? b : a));
  const suitGeometry = suitOf(left, right);
  const suit = assembled ? suitGeometry : { panels: [] as Panel[], lines: [] as SuitLine[], front: [] as Point[][] };
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), mouth: at(head.at.lipUpper), neck: { left, right } };

  // ── Visor frame ───────────────────────────────────────────────────
  const barH = num(ctx, 'barMm'), eyesAt = page.eyes;
  const eyeLine = Math.atan2(eyesAt[1].y - eyesAt[0].y, eyesAt[1].x - eyesAt[0].x);
  const tilt = (Math.abs(eyeLine) > Math.PI / 2 ? eyeLine - Math.sign(eyeLine) * Math.PI : eyeLine) + deg(num(ctx, 'barTilt'));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  const eyeMid = { x: (eyesAt[0].x + eyesAt[1].x) / 2, y: (eyesAt[0].y + eyesAt[1].y) / 2 };
  const centre = { x: eyeMid.x + nrm.x * num(ctx, 'eyeInBar') * barH, y: eyeMid.y + nrm.y * num(ctx, 'eyeInBar') * barH };
  const toPage = (u: number, v: number): Point => ({ x: centre.x + dir.x * u - nrm.x * (barH / 2 + v), y: centre.y + dir.y * u - nrm.y * (barH / 2 + v) });
  const toBar = (p: Point) => ({ u: (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y, v: -((p.x - centre.x) * nrm.x + (p.y - centre.y) * nrm.y) - barH / 2 });
  const quad = (u0: number, u1: number, v0: number, v1: number): Point[] => [toPage(u0, v1), toPage(u1, v1), toPage(u1, v0), toPage(u0, v0)];

  // ── Bob window ────────────────────────────────────────────────────
  // Sample just the skull above the intended fringe, hull it, then offset/clip it in the visor frame. The hull gives
  // straight, chamfered cut-paper facets while the samples make it genuinely hug the particular projected head.
  const skull: Point[] = [];
  for (let v = 0; v <= 190; v += 2) for (let u = -145; u <= 145; u += 2) if (onHead(toPage(u, v))) skull.push(toPage(u, v));
  const rawHull = skull.length >= 3 ? convexHull(skull) : quad(-58, 58, 0, 105);
  const expanded = offsetRing(rawHull, num(ctx, 'bobMargin'), 2);
  // Hull the offset, not the original silhouette: this removes little sampling nicks while retaining the skull's
  // measured crown and side clearance. It is deliberately a faceted bell, never a box grown around the head.
  const hairHull = ringsSimple([expanded]) ? convexHull(expanded) : rawHull;
  const clippedUpper = clipAtFrameV(hairHull, 0, toBar, toPage);
  const onFringe = clippedUpper.filter(p => Math.abs(toBar(p).v) < 1e-5).map(p => toBar(p).u);
  const fallback = [-62, 62];
  const fringeU0 = onFringe.length ? Math.min(...onFringe) : fallback[0], fringeU1 = onFringe.length ? Math.max(...onFringe) : fallback[1];
  // Sample the actual offset hull's upper support at a few even stations. The resulting octagon-like crown hugs the
  // skull (10 mm at its highest point) and has no synthetic rectangular roof or top-right notch.
  const hairFrame = hairHull.map(toBar);
  const crownAt = (u: number) => {
    const hits: number[] = [];
    for (let i = 0; i < hairFrame.length; i++) {
      const a = hairFrame[i], b = hairFrame[(i + 1) % hairFrame.length];
      if (Math.abs(a.u - b.u) < 1e-6) {
        if (Math.abs(u - a.u) < 1e-5) hits.push(a.v, b.v);
      } else if ((u - a.u) * (u - b.u) <= 1e-8) {
        const t = (u - a.u) / (b.u - a.u);
        hits.push(a.v + (b.v - a.v) * t);
      }
    }
    return hits.length ? Math.max(...hits) : 0;
  };
  const crownStations = [0, 0.11, 0.24, 0.38, 0.5, 0.62, 0.76, 0.89, 1];
  const upper = crownStations.map(f => {
    const u = fringeU0 + (fringeU1 - fringeU0) * f;
    // The two end stations are the shared fringe itself, exactly on the visor's top rule.
    return toPage(u, f === 0 || f === 1 ? 0 : Math.max(0, crownAt(u)));
  });
  // A razor bob is a flared bell, not two parallel headband tails.  Its outer edge begins at the measured temple
  // margin and opens to 24 mm outside the jaw, while the inner edge stays tucked two millimetres over the cheek.
  // The lower cut is deliberately just above the chin and therefore remains a single dead-straight visor-frame line.
  const templeWidth = 12, jawFlare = 24, jawTuck = 2;
  const jawV = Math.min(-barH - 14, toBar(page.chin).v + 3);
  const jawSides: number[] = [];
  for (let u = -150; u <= 150; u += 1) if (onHead(toPage(u, jawV))) jawSides.push(u);
  const jawLeft = jawSides.length ? Math.min(...jawSides) : fringeU0 + 12;
  const jawRight = jawSides.length ? Math.max(...jawSides) : fringeU1 - 12;
  const leftCurtain = [
    toPage(fringeU0, -barH), toPage(fringeU0 + templeWidth, -barH),
    toPage(jawLeft + jawTuck, jawV), toPage(jawLeft - jawFlare, jawV),
  ];
  const rightCurtain = [
    toPage(fringeU1 - templeWidth, -barH), toPage(fringeU1, -barH),
    toPage(jawRight + jawFlare, jawV), toPage(jawRight - jawTuck, jawV),
  ];
  const bob = assembled ? [upper, leftCurtain, rightCurtain].filter(r => r.length >= 3) : [];
  const inBob = (p: Point) => bob.some(r => insideRing(r, p));
  const visor = assembled ? quad(fringeU0 - num(ctx, 'barWrap'), fringeU1 + num(ctx, 'barWrap'), -barH, 0) : [];
  const inVisor = (p: Point) => visor.length >= 3 && insideRing(visor, p);

  // ── Page-grid mosaic ──────────────────────────────────────────────
  // Every record is a whole rectangular cluster, never a loose list of 3 mm cells. This preserves square cut corners
  // under the 1.2 mm knife radius and lets a source row visibly tear from the figure before it streams sideways.
  const cell = num(ctx, 'cell'), phase = num(ctx, 'glitchPhase'), motion = num(ctx, 'glitchMotion'), scale = num(ctx, 'glitchScale');
  const noise = gradientNoise(ctx.random('ka-codex-b-motion'));
  const wave = (x: number, y: number, k: number) => 0.5 + 0.5 * noise(x / scale + 11.7 * k, y / scale + phase * 0.35 + 7.3 * k);
  const headCentre = { x: (page.eyes[0].x + page.eyes[1].x + page.chin.x) / 3, y: (page.eyes[0].y + page.eyes[1].y + page.chin.y) / 3 };
  const sideChoice = ctx.params.driftSide;
  const side = sideChoice === 'left' ? -1 : sideChoice === 'right' ? 1 : (num(ctx, 'cock') >= 0 ? 1 : -1);
  const ix0 = Math.ceil(6 / cell), ix1 = Math.floor((TRIM.x1 - TRIM.x0 - 6) / cell) - 1;
  const iy0 = Math.ceil(6 / cell), iy1 = Math.floor((TRIM.y1 - TRIM.y0 - 6) / cell) - 1;
  const box = (ix: number, iy: number, w = 1, h = 1): MosaicBlock => ({
    x0: TRIM.x0 + ix * cell, x1: TRIM.x0 + (ix + w) * cell, y0: TRIM.y0 + iy * cell, y1: TRIM.y0 + (iy + h) * cell,
    kind: 'echo', dx: 0, dy: 0,
  });
  const centreOf = (b: MosaicBlock): Point => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const pointsOf = (b: MosaicBlock) => [
    { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
    { x: (b.x0 + b.x1) / 2, y: b.y0 }, { x: b.x1, y: (b.y0 + b.y1) / 2 }, { x: (b.x0 + b.x1) / 2, y: b.y1 }, { x: b.x0, y: (b.y0 + b.y1) / 2 }, centreOf(b),
  ];
  const gridCentres = (b: MosaicBlock) => {
    const out: Point[] = [];
    for (let y = b.y0 + cell / 2; y < b.y1 - 1e-6; y += cell) for (let x = b.x0 + cell / 2; x < b.x1 - 1e-6; x += cell) out.push({ x, y });
    return out;
  };
  const clearCell = (b: MosaicBlock) => pointsOf(b).every(p => p.x >= TRIM.x0 + 6 && p.x <= TRIM.x1 - 6 && p.y >= TRIM.y0 + 6 && p.y <= TRIM.y1 - 6 && !inBob(p) && !inVisor(p));
  const blocks: MosaicBlock[] = [], gold: MosaicBlock[] = [], goldGroups: MosaicBlock[][] = [], sourceBlocks: MosaicBlock[] = [];
  const overlaps = (a: MosaicBlock, b: MosaicBlock) => a.x0 < b.x1 - 1e-6 && a.x1 > b.x0 + 1e-6 && a.y0 < b.y1 - 1e-6 && a.y1 > b.y0 + 1e-6;
  const occupied = (b: MosaicBlock) => blocks.some(o => !o.source && overlaps(o, b));
  const sourceTaken = (b: MosaicBlock) => sourceBlocks.some(o => overlaps(o, b));
  const gap = (a: MosaicBlock, b: MosaicBlock) => ({ x: Math.max(0, a.x0 - b.x1, b.x0 - a.x1), y: Math.max(0, a.y0 - b.y1, b.y0 - a.y1) });
  const goldClear = (cluster: MosaicBlock[]) => {
    if (cluster.some(b => !clearCell(b) || pointsOf(b).some(p => distanceToRings(p, bob) < BRIDGE + 0.5))) return false;
    return goldGroups.every(other => cluster.every(b => other.every(o => { const d = gap(b, o); return d.x >= BRIDGE + 0.5 || d.y >= BRIDGE + 0.5; })));
  };
  const shares = () => {
    const g = num(ctx, 'goldShare'), p = num(ctx, 'pinkShare'), r = num(ctx, 'roseShare'), e = num(ctx, 'echoShare');
    const total = Math.max(1e-9, g + p + r + e);
    return [g / total, p / total, r / total];
  };
  const kindOf = (roll: number): MosaicBlock['kind'] => { const [g, p, r] = shares(); return roll < g ? 'gold' : roll < g + p ? 'pink' : roll < g + p + r ? 'rose' : 'echo'; };
  const shareOf = (kind: MosaicBlock['kind']) => kind === 'gold' ? num(ctx, 'goldShare') : kind === 'pink' ? num(ctx, 'pinkShare') : kind === 'rose' ? num(ctx, 'roseShare') : num(ctx, 'echoShare');
  type StreamSpec = { kind: MosaicBlock['kind']; tail: number; size?: { w: number; h: number } };
  // Bites are compact enough to remain attached to their source edge. Their re-emitted stream pieces below are
  // deliberately much longer, so the figure is actually eaten while the page receives a graphic pixel flow.
  const biteDimensions = (kind: MosaicBlock['kind'], rng: () => number) => kind === 'gold'
    ? { w: 2, h: 2 }
    : kind === 'echo' ? { w: 2, h: 1 + Math.floor(rng() * 2) }
      : { w: 2 + Math.floor(rng() * 2), h: 1 + Math.floor(rng() * 2) };
  const streamDimensions = (kind: MosaicBlock['kind'], rng: () => number) => kind === 'gold'
    ? { w: 6 + Math.floor(rng() * 3), h: 2 }
    : kind === 'echo' ? { w: 5 + Math.floor(rng() * 3), h: 1 + Math.floor(rng() * 2) }
      : { w: 6 + Math.floor(rng() * 4), h: 1 + Math.floor(rng() * 2) };
  const reachable = (p: Point) => {
    const along = side * (p.x - headCentre.x), vertical = Math.abs(p.y - eyeMid.y);
    return along >= -cell && along <= num(ctx, 'reachMm') && vertical < 195;
  };
  const fullyInVisor = (b: MosaicBlock) => gridCentres(b).every(p => inVisor(p) && !onNose(p));
  const visorSource = (iy: number, w: number, h: number, whichSide: number) => {
    for (let ix = whichSide > 0 ? ix1 - w + 1 : ix0; whichSide > 0 ? ix >= ix0 : ix <= ix1 - w + 1; ix -= whichSide) {
      const b = box(ix, iy, w, h);
      if (fullyInVisor(b) && !sourceTaken(b)) return b;
    }
    return undefined;
  };
  /** A rectangle that crosses an outer silhouette edge and reaches back into it: a real bite, not a nearby speck. */
  const edgeSource = (ring: Point[], iy: number, w: number, h: number, whichSide: number) => {
    let edgeIx: number | undefined, score = -Infinity;
    for (let ix = ix0; ix <= ix1; ix++) {
      const probe = box(ix, iy, 1, h), centres = gridCentres(probe);
      if (!centres.some(p => insideRing(ring, p)) || Math.min(...pointsOf(probe).map(p => distanceToRings(p, [ring]))) > cell * 1.35) continue;
      const next = whichSide * toBar(centreOf(probe)).u;
      if (next > score) { edgeIx = ix; score = next; }
    }
    if (edgeIx === undefined) return undefined;
    // End at the outermost interior cell and grow back into the material. The sampled outer cell supplies a joined
    // black-paper exit; the extra inner cells make the loss read as a deliberate bite in the bob or shoulder.
    const b = box(whichSide > 0 ? edgeIx - w + 1 : edgeIx, iy, w, h), samples = pointsOf(b);
    return samples.some(p => insideRing(ring, p)) && samples.some(p => !insideRing(ring, p)) && !sourceTaken(b) ? b : undefined;
  };
  /** Place a page-grid stream target with its copied drawing translated from the source's upper-left cell. */
  const streamTarget = (source: MosaicBlock, spec: StreamSpec, whichSide: number, key: number) => {
    const c = centreOf(source), rng = ctx.random(`ka-codex-b-stream-shift-${key}-${spec.tail}`);
    const ix = Math.round((source.x0 - TRIM.x0) / cell), iy = Math.round((source.y0 - TRIM.y0) / cell);
    const sourceW = Math.round((source.x1 - source.x0) / cell);
    const size = spec.size ?? streamDimensions(spec.kind, rng), { w, h } = size;
    const room = whichSide > 0 ? ix1 - w + 1 - (ix + sourceW) : ix - w - ix0;
    if (room < 3) return false;
    const raw = Math.max(3, Math.round(3 + Math.floor(rng() * 3) + spec.tail * (5 + Math.floor(rng() * 3))
      + motion * (1 + 8 * wave(c.x, c.y, key + spec.tail) + 1.4 * Math.sin(phase * 0.47 + c.y * 0.045 + key))));
    const maxShift = room, base = Math.min(maxShift, raw);
    for (const delta of [0, 2, 4, -1, -3]) {
      const shift = Math.max(3, Math.min(maxShift, base + delta));
      const targetIx = whichSide > 0 ? ix + sourceW + shift : ix - w - shift;
      const target = { ...box(targetIx, iy, w, h), kind: spec.kind, dx: (targetIx - ix) * cell, dy: 0 };
      if ((whichSide === side && !reachable(centreOf(target))) || !clearCell(target) || occupied(target)) continue;
      if (spec.kind === 'gold' && !goldClear([target])) continue;
      blocks.push(target);
      if (spec.kind === 'gold') { gold.push(target); goldGroups.push([target]); }
      return true;
    }
    return false;
  };
  const take = (source: MosaicBlock) => { blocks.push({ ...source, source: true }); sourceBlocks.push(source); };
  /** A source becomes a local-to-distant row of whole-cell targets; farther tails naturally thin towards the trim. */
  const emitStream = (source: MosaicBlock, whichSide: number, key: number, specs: StreamSpec[]) => {
    let placed = false;
    specs.forEach((spec, i) => { if (streamTarget(source, spec, whichSide, key * 10 + i)) placed = true; });
    if (placed) take(source);
    return placed;
  };
  if (assembled) {
    // The mosaic is a set of connected losses and rows, not an afterthought sprinkled over the page.  Each emitted
    // row starts at the figure, then uses a near and a far whole-cell target to make the density fall off to the trim.
    const scaled = (count: number) => Math.max(0, Math.round(count * num(ctx, 'glitch') / 0.7));
    const sharedKind = (wanted: MosaicBlock['kind'], rng: () => number) => shareOf(wanted) > 1e-6 ? wanted : kindOf(rng());
    const specs = (rng: () => number, wanted: MosaicBlock['kind'][], largeGoldAt = -1): StreamSpec[] => wanted.map((want, tail) => {
      const kind = sharedKind(want, rng);
      const size = kind === 'gold' && tail === largeGoldAt ? { w: 4, h: 3 }
        : streamDimensions(kind, rng);
      return { kind, tail, size };
    });
    const mainPatterns: MosaicBlock['kind'][][] = [
      ['pink', 'gold'], ['gold', 'echo'], ['pink', 'rose'], ['echo', 'pink'],
      ['rose', 'gold'], ['pink', 'echo'], ['gold', 'pink'], ['echo', 'rose'],
    ];
    /** Take edge-crossing source rectangles at evenly distributed frame heights and send each through its row plan. */
    const frameEdgeRuns = (ring: Point[], v0: number, v1: number, limit: number, whichSide: number, name: string, keyBase: number, patterns: MosaicBlock['kind'][][], largeGoldSlots: number[] = []) => {
      let taken = 0;
      for (let slot = 0; slot < limit; slot++) {
        const rng = ctx.random(`ka-codex-b-${name}-row-${slot}`), wanted = patterns[slot % patterns.length];
        const lead = sharedKind(wanted[0], rng), { w, h } = biteDimensions(lead, rng);
        const v = v0 + (v1 - v0) * ((slot + 0.5) / limit);
        const centreIy = Math.round((toPage(0, v).y - TRIM.y0) / cell - 0.5);
        let source: MosaicBlock | undefined;
        for (const offset of [0, -1, 1, -2, 2]) {
          const iy = centreIy + offset;
          if (iy < iy0 || iy + h - 1 > iy1) continue;
          source = edgeSource(ring, iy, w, h, whichSide);
          if (source) break;
        }
        const row = specs(rng, wanted.slice(0, 1), largeGoldSlots.includes(slot) ? 0 : -1);
        if (source && emitStream(source, whichSide, keyBase + slot, row)) taken++;
      }
      return taken;
    };
    /** The collar and shoulder use the same edge-loss logic, but their slots are placed in page y rather than visor v. */
    const pageEdgeRuns = (ring: Point[], y0: number, y1: number, limit: number, whichSide: number, name: string, keyBase: number, patterns: MosaicBlock['kind'][][], pieces = 1) => {
      let taken = 0;
      for (let slot = 0; slot < limit; slot++) {
        const rng = ctx.random(`ka-codex-b-${name}-row-${slot}`), wanted = patterns[slot % patterns.length];
        const lead = sharedKind(wanted[0], rng), { w, h } = biteDimensions(lead, rng);
        const y = y0 + (y1 - y0) * ((slot + 0.5) / limit), centreIy = Math.round((y - TRIM.y0) / cell - 0.5);
        let source: MosaicBlock | undefined;
        for (const offset of [0, -1, 1, -2, 2]) {
          const iy = centreIy + offset;
          if (iy < iy0 || iy + h - 1 > iy1) continue;
          source = edgeSource(ring, iy, w, h, whichSide);
          if (source) break;
        }
        if (source && emitStream(source, whichSide, keyBase + slot, specs(rng, wanted.slice(0, pieces)))) taken++;
      }
      return taken;
    };

    // Dense visor rows: their second target is the long, far fragment, so several rows approach the 8 mm trim gutter.
    let visorRowsTaken = 0;
    const visorLimit = scaled(7);
    for (let iy = iy0; iy <= iy1 && visorRowsTaken < visorLimit; iy++) {
      const rng = ctx.random(`ka-codex-b-visor-row-${iy}`), wanted = mainPatterns[visorRowsTaken % mainPatterns.length];
      const lead = sharedKind(wanted[0], rng), { w, h } = biteDimensions(lead, rng), source = visorSource(iy, w, h, side);
      const largeGoldAt = visorRowsTaken === 1 ? 0 : -1;
      if (source && emitStream(source, side, visorRowsTaken, specs(rng, wanted, largeGoldAt))) visorRowsTaken++;
    }

    // Five high-to-low losses along the outer dome and five down the flared curtain distribute the break from crown
    // through jaw.  The selected 4×3 gold pieces are large enough to carry obvious black Micron strand echoes.
    const crownV = Math.max(...upper.map(p => toBar(p).v));
    frameEdgeRuns(upper, 8, crownV - 7, scaled(5), side, 'crown', 100,
      [['gold'], ['echo'], ['gold'], ['pink'], ['echo']], [0, 2]);
    frameEdgeRuns(side > 0 ? rightCurtain : leftCurtain, -barH + 4, jawV - 4, scaled(5), side, 'curtain', 130,
      [['pink'], ['gold'], ['echo']], [1]);

    // The collar and right shoulder also shed row fragments, extending the composition through the figure rather than
    // stopping at the visor. These source cells erase silver/gold drawing only; they do not make unwanted body cuts.
    const collar = suit.front[0], jacket = suit.front[1];
    if (collar) {
      const ys = collar.map(p => p.y);
      pageEdgeRuns(collar, Math.min(...ys) + 5, Math.max(...ys) - 5, scaled(2), side, 'collar', 160, [['rose'], ['pink']]);
    }
    if (jacket) {
      const ys = jacket.map(p => p.y), top = Math.min(...ys);
      pageEdgeRuns(jacket, top + 7, top + 42, scaled(2), side, 'shoulder', 170, [['echo', 'pink'], ['pink', 'echo']], 2);
    }

    // Two small counter-bites answer the main stream, but remain losses in the source rather than becoming a detached
    // left-side target. That keeps the asymmetry intentional without introducing a stray pill in empty space.
    const minorRng = ctx.random('ka-codex-b-left-response');
    const minorLead = sharedKind('pink', minorRng), minorSize = biteDimensions(minorLead, minorRng);
    const minorY = Math.round((toPage(0, -barH / 2).y - TRIM.y0) / cell - 0.5);
    const minor = visorSource(minorY, minorSize.w, minorSize.h, -side);
    if (minor) take(minor);
    const counterV = -barH + (jawV + barH) * 0.45;
    const counterIy = Math.round((toPage(0, counterV).y - TRIM.y0) / cell - 0.5);
    const counter = edgeSource(side > 0 ? leftCurtain : rightCurtain, counterIy, 2, 1, -side);
    if (counter) take(counter);
  }

  // Six 0.5 mm rows fuse into a solid 3 mm visor/cell. Source cells are left black, making the break explicit.
  const visorRows: Point[][] = [];
  for (let v = -barH + 0.25; assembled && v <= -0.25 + 1e-9; v += num(ctx, 'visorPitch')) {
    const row = [toPage(fringeU0 - num(ctx, 'barWrap'), v), toPage(fringeU1 + num(ctx, 'barWrap'), v)];
    // The split comes from clipping in `sheets`, preserving exact page-grid bites rather than approximating their edge.
    visorRows.push(row);
  }
  const visorEdge = visor.length ? [[...visor, visor[0]]] : [];

  // Long, sparse strands are confined to at least 1.3 mm inside the gold hair windows. Every fourth one runs from the
  // crown support to the jaw line (with matching upper/lower pieces across the black visor), so the bob has a few
  // continuous graphic falls rather than only short, jittery marks.
  const bobInk: Point[][] = [];
  if (assembled && bob.length) {
    const strands = ctx.random('ka-codex-b-strands'), pitch = num(ctx, 'strandPitch');
    const top = Math.max(...upper.map(p => toBar(p).v));
    let strandIndex = 0;
    for (let u = fringeU0 + 2; u < fringeU1 - 2; u += pitch, strandIndex++) {
      const a = u + (strands() - 0.5) * 0.8, b = a + (strands() - 0.5) * 2;
      const long = strandIndex % 4 === 1;
      const start = long ? top - 0.5 : 2 + strands() * Math.max(8, top - 4);
      const end = long ? jawV + 0.8 : jawV + 2 + strands() * 7;
      for (const piece of clipToRegion([[toPage(a, start), toPage(b, end)]], { and: [{ rings: bob }, { not: { near: bob, distance: 1.3 } }] })) if (pathLength(piece) >= 4) bobInk.push(piece);
    }
  }

  // `traceMask` rounds the knife corners; all isolated gold candidates have already been kept 3.5 mm apart and from
  // the bob, and every cut stays at least 6 mm inside trim.
  const inGold = (p: Point) => gold.some(b => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
  const inBobBite = (p: Point) => blocks.some(b => b.source && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && inBob(p));
  const safeWindow = (p: Point) => p.x >= TRIM.x0 + 6 && p.x <= TRIM.x1 - 6 && p.y >= TRIM.y0 + 6 && p.y <= TRIM.y1 - 6;
  const windowAt = (p: Point) => safeWindow(p) && ((inBob(p) && !inBobBite(p)) || inGold(p));
  const window = traceMask(windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, options.preview ? 0.5 : 0.25, { simplify: options.preview ? 0.15 : 0.08, minRadius: 1.2, minArea: 6 });
  return { head: seen, onHead, onNose, visor, visorRows, visorEdge, toPage, toBar, barH, bob, bobInk, blocks, inBob, inVisor, panels: suit.panels, suitLines: suit.lines, bySuit, window, page };
}

/** The part of a mesh whose triangles' vertices all pass `keep`, in world units. */
function subMesh(m: SculptMesh, keep: (p: V3) => boolean): THREE.BufferGeometry {
  const ok = new Uint8Array(m.pos.length / 3);
  for (let v = 0; v < ok.length; v++) ok[v] = keep([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]]) ? 1 : 0;
  const tri: number[] = [];
  for (let t = 0; t < m.tri.length; t += 3) if (ok[m.tri[t]] && ok[m.tri[t + 1]] && ok[m.tri[t + 2]]) tri.push(m.tri[t], m.tri[t + 1], m.tri[t + 2]);
  return sculptGeometry({ ...m, tri: Uint32Array.from(tri) });
}

// ── The quiet suit, flat on the sheet ─────────────────────────────────

/** A high stand collar and one quiet, continuous jacket plane: enough figure beneath the head, no extra story. */
function suitOf(left: Point, right: Point): { panels: Panel[]; lines: SuitLine[]; front: Point[][] } {
  const c = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, w = right.x - left.x;
  const slope = (right.y - left.y) / (right.x - left.x);
  const P = (u: number, v: number): Point => ({ x: c.x + u * w, y: c.y + v * w + u * w * slope });
  // One continuous, shallow octagonal stand collar: it reads as a single engineered band around the neck, not two
  // detached lapel wedges. The lower jacket exits beyond trim so its last stripe is either full width or absent.
  const bottom = TRIM.y1 + 30, L = TRIM.x0 - 30, R = TRIM.x1 + 30;
  const collar = [
    P(-0.62, 0.16), P(-0.56, -0.28), P(-0.34, -0.48), P(0.34, -0.48),
    P(0.56, -0.28), P(0.62, 0.16), P(0.31, 0.27), P(-0.31, 0.27),
  ];
  const jacket = [
    P(-0.62, 0.14), { x: L, y: P(-2.7, 0.72).y }, { x: L, y: bottom }, { x: R, y: bottom },
    { x: R, y: P(2.7, 0.72).y }, P(0.62, 0.14),
  ];
  const panels: Panel[] = [
    { id: 'collar', ring: collar, angle: Math.PI / 2, pitch: 1.8, pen: 'silver' },
    { id: 'jacket', ring: jacket, angle: 0, pitch: 2.8, pen: 'silver' },
  ];
  const close = (r: Point[]) => [...r, r[0]];
  const lines: SuitLine[] = [collar, jacket].map(r => ({ pen: 'gold' as const, path: close(r) }));
  return { panels, lines, front: [collar, jacket] };
}

/** A panel's stripes (and its cross stripes), clipped to the panel grown by `grow` and the trim. */
export function panelStripes(p: Panel, grow = 0, clip: Rect = ART): Point[][] {
  const out = stripeFill(p.ring, p.angle, p.pitch, grow);
  if (p.cross !== undefined) out.push(...stripeFill(p.ring, p.cross, p.pitch * 1.6, grow));
  return out.flatMap(path => clipToRect(path, clip)).flatMap(path => (grow ? [path] : keepAlong(path, q => insideRing(p.ring, q), 0.2)));
}

/** Clip a page polygon to the part at or above `v` in the visor frame, putting every new edge exactly on that frame line. */
function clipAtFrameV(ring: Point[], v: number, toBar: (p: Point) => { u: number; v: number }, toPage: (u: number, v: number) => Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], qa = toBar(a), qb = toBar(b);
    const aIn = qa.v >= v, bIn = qb.v >= v;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (v - qa.v) / (qb.v - qa.v);
      out.push(toPage(qa.u + (qb.u - qa.u) * t, v));
    }
  }
  return out;
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
