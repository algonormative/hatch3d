import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import {
  atPoint, blend, contourLines, ellipsoid, isoLines, meshSdf, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry, toWorld,
  type IsoLine, type Sdf, type SculptMesh, type SurfacePoint, type V3,
} from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import type { GpuMesher } from '../../kit/sculpt-gpu.ts';
import { traceMask } from '../../kit/outline.ts';
import { stripeFill } from '../lodestone-cuts.ts';
import { ART, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Over the shoulder, the world its sheets share: an android whose body has turned away while its sculpted head turns
 * back toward us, chin lowered and cocked. A slick silver-line hair cap, a magenta surface visor and pink-only lips
 * sharpen the sideways glance; a slim twisted neck lands in a high-backed suit below.
 *
 * Two sheets, as Lodestone L: black in front takes silver, gold, fluoro-pink and one metallic-pink accent; gold-yellow
 * behind carries black Micron through the collar and a few guarded scan-bar windows. Vertical scan bars cross the whole
 * composition, shifting the drawing or becoming sparse columns rather than erasing the crown into literal pieces.
 *
 * The bare skin remains plated silver with gold seams. The hair is a separate SDF cap, so its flowing engraving and
 * hairline never receive the skin's plate hatch.
 */

const deg = THREE.MathUtils.degToRad;

/** The pens: gels on black and black Micron on gold. */
export type Pen = 'silver' | 'gold' | 'fluoro-pink' | 'gel-rose' | 'black';
/** The one metallic-pink gel, kept as an unthinned accent. */
export const METALLIC: Pen = 'gel-rose';

/** A projected visible mark and its thinning priority (outline, seam, hatch). */
export interface Seen { pen: Pen; rank: number; id: string; piece: Point[] }

/** A suit edge; collar-back edges can sit behind the head. */
export interface SuitLine { pen: Pen; path: Point[]; behind?: boolean }

/** A flat suit panel striped at its own direction. `window` puts its ink on the gold ply. */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }

/** A page-space scan band. `dv` is subtracted from source strokes before they are clipped back to this band. */
export interface ScanBand { x0: number; x1: number; y0: number; y1: number; dv: number; kind: 'shift' | 'silver' | 'pink' | 'cut' }

export interface Erasure {
  assembled: boolean;
  head: Seen[];
  visor: Seen[];
  onHead: (p: Point) => boolean;
  onNose: (p: Point) => boolean;
  panels: Panel[];
  suitLines: SuitLine[];
  bySuit: (p: Point) => boolean;
  shirt: Point[][];
  collarBack: Point[][];
  scan: ScanBand[];
  window: Point[][];
  page: { eyes: Point[]; noseTip: Point; chin: Point; neck: { left: Point; right: Point } };
}

// ── Controls ─────────────────────────────────────────────────────────

/** One numeric parameter, including whether it rebuilds the sculpted head cache. */
interface Param { id: string; label: string; d: number; min: number; max: number; step: number; group: string; units?: string; head?: boolean }
const P = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string, head?: boolean): Param => ({ id, label, d, min, max, step, group, ...(units ? { units } : {}), ...(head ? { head } : {}) });
const HEAD = true;

/** Every numeric parameter, in the order the controls show them. */
export const PARAMS: Param[] = [
  P('tilt', 'Head tipped (negative is chin down)', -14, -38, 48, 1, 'Pose', '°', HEAD),
  P('turn', 'Head turned back on the neck', -82, -100, 100, 1, 'Pose', '°', HEAD),
  P('cock', 'Head cock (raises left ear)', 12, -42, 42, 1, 'Pose', '°', HEAD),
  P('yaw', 'Body turned away', 130, -180, 180, 1, 'Pose', '°', HEAD),
  P('roll', 'Lean across the sheet', -7, -40, 40, 1, 'Pose', '°', HEAD),
  P('noseLength', 'Nose length', 1.15, 0.6, 1.8, 0.05, 'Face', undefined, HEAD),
  P('noseWidth', 'Nose width at the wings', 0.9, 0.6, 1.6, 0.05, 'Face', undefined, HEAD),
  P('bridge', 'Nose bridge between the eyes', 0.8, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('chin', 'Chin forward', 0.8, 0, 2.5, 0.05, 'Face', undefined, HEAD),
  P('jaw', 'Fine jaw', 0.8, 0.6, 1.6, 0.05, 'Face', undefined, HEAD),
  P('lips', 'Lips', 1.1, 0.5, 1.6, 0.05, 'Face', undefined, HEAD),
  P('brow', 'Soft brow', 0.55, 0, 2, 0.05, 'Face', undefined, HEAD),
  P('cheeks', 'High cheekbones', 1.35, 0.5, 1.7, 0.05, 'Face', undefined, HEAD),
  P('ears', 'Ears', 0.9, 0.6, 1.5, 0.05, 'Face', undefined, HEAD),
  P('cranium', 'Skull height', 1.04, 0.85, 1.2, 0.01, 'Face', undefined, HEAD),
  P('neckLength', 'Long neck', 2.1, 0.8, 2.4, 0.05, 'Face', undefined, HEAD),
  P('neckWidth', 'Fine neck', 0.105, 0.09, 0.22, 0.005, 'Face', undefined, HEAD),
  P('headMm', 'Head height on the sheet', 225, 120, 300, 1, 'Framing', 'mm', HEAD),
  P('crownY', 'Crown height on the sheet', 52, 20, 200, 1, 'Framing', 'mm', HEAD),
  P('headX', 'Head across the sheet', 142, 40, 240, 1, 'Framing', 'mm', HEAD),
  P('lookUp', 'Camera looking up', 0, -20, 30, 1, 'Framing', '°', HEAD),
  P('collarAt', 'Collar down the neck', 0.74, 0.4, 1.6, 0.01, 'Framing'),
  P('pitchMm', 'Densest skin pitch', 0.95, 0.8, 3, 0.05, 'Plates', 'mm', HEAD),
  P('plateMm', 'Plate size', 26, 10, 80, 1, 'Plates', 'mm', HEAD),
  P('bareShare', 'Plates left bare', 0.14, 0, 0.6, 0.01, 'Plates', undefined, HEAD),
  P('crossShare', 'Plates cross-hatched', 0.18, 0, 0.8, 0.01, 'Plates', undefined, HEAD),
  P('plateSwing', 'Plate line swing', 0.8, 0, 1.6, 0.05, 'Plates', undefined, HEAD),
  P('lightX', 'Light from the right', 0.3, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('lightZ', 'Light from the front', 0.65, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('neckRings', 'Neck segment rings', 2, 0, 6, 1, 'Plates', undefined, HEAD),
  P('step', 'Mesh detail (cell, head units; larger is faster)', 0.009, 0.006, 0.02, 0.001, 'Plates', undefined, HEAD),
  P('barMm', 'Magenta visor height', 23, 16, 42, 0.5, 'Visor', 'mm', HEAD),
  P('visorY', 'Visor centre at the eyes', 0.045, -0.08, 0.16, 0.005, 'Visor', undefined, HEAD),
  P('bands', 'Scan bars', 82, 24, 96, 1, 'Glitch'),
  P('glitchPhase', 'Glitch phase (moves bars)', 0, 0, 20, 0.01, 'Motion'),
  P('glitchMotion', 'How much phase moves bars', 0.62, 0, 1, 0.01, 'Motion'),
  P('glitchScale', 'Noise wavelength across the sheet', 42, 5, 200, 1, 'Motion', 'mm'),
];
const BY_ID = new Map(PARAMS.map(p => [p.id, p]));
/** A numeric parameter, clamped, or its default. */
export function num(ctx: SketchContext, id: string): number {
  const p = BY_ID.get(id)!;
  return n(ctx, id, p.d, p.min, p.max);
}

export const CONTROLS: Control[] = [
  ...PARAMS.map((p): Control => ({ type: 'slider', id: p.id, label: p.label, default: p.d, min: p.min, max: p.max, step: p.step, group: p.group, ...(p.units ? { units: p.units } : {}), ...(p.head ? { expensive: true } : {}) })),
  { type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'], optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no visor, no scan bars)' }, group: 'Glitch' },
];

// ── The head ─────────────────────────────────────────────────────────

const CROWN = 0.2;
const JAW = -0.3;
const SEAM = 0.007;
/** The physical fused-row target, precompensated for this oblique camera's local magnification. */
const VISOR_PITCH_MM = 0.5;
const VISOR_FRAME_PITCH = 0.78;

interface Mark { points: THREE.Vector3[]; pen: Pen; rank: number; id: string; layer: 'head' | 'visor' }

/** Seeds placed on features, so the nose, lips and chin each sit on a coherent skin plate. */
const FEATURES: V3[] = [
  [0, -0.11, 0.47], [0, 0.03, 0.4], [0, -0.24, 0.4], [0, -0.41, 0.33], [0, -0.47, 0.2],
  [0.18, -0.05, 0.25], [-0.18, -0.05, 0.25], [0.21, -0.3, 0.12], [-0.21, -0.3, 0.12], [0.12, 0.13, 0.33], [-0.12, 0.13, 0.33],
];

/** The head marks, surface masks and page projector retained for a sheet build. */
export interface HeadStage { seen: Seen[]; visor: Seen[]; onHead: (p: Point) => boolean; onNose: (p: Point) => boolean; at: (p: V3) => Point; head: ReturnType<typeof sculptHead> }

let lastHead: { key: string; stage: HeadStage } | undefined;
const headKey = (ctx: SketchContext, mode: 'cpu' | 'gpu') => JSON.stringify([mode, ctx.seed, ...PARAMS.filter(p => p.head).map(p => num(ctx, p.id))]);
function headStage(ctx: SketchContext): HeadStage {
  const key = headKey(ctx, 'cpu');
  if (lastHead?.key !== key) lastHead = { key, stage: buildHead(ctx) };
  return lastHead.stage;
}

const DRAFT_STEP = 0.018;
const previewHeads = new Map<string, { key: string; stage: HeadStage }>();
/** The sketch lab's equivalent head stage, meshed on the GPU where it is available. */
export async function previewHeadStage(ctx: SketchContext, mesher: GpuMesher | CpuMesher, draft = false): Promise<HeadStage> {
  const step = draft ? Math.max(num(ctx, 'step'), DRAFT_STEP) : num(ctx, 'step');
  const key = headKey(ctx, 'gpu') + step;
  const slot = draft ? 'draft' : 'full';
  if (previewHeads.get(slot)?.key !== key) {
    const { head, transform } = headModel(ctx);
    previewHeads.set(slot, { key, stage: buildHead(ctx, await mesher.mesh(head.sdf, head.lo, head.hi, step, transform)) });
  }
  return previewHeads.get(slot)!.stage;
}

/** `meshSdf` behind the GPU mesher's interface, for a preview without WebGPU. */
export interface CpuMesher { mesh(sdf: Parameters<typeof meshSdf>[0], lo: V3, hi: V3, step: number, transform: THREE.Matrix4): Promise<SculptMesh> }
export const cpuMesher: CpuMesher = { mesh: async (sdf, lo, hi, step, transform) => meshSdf(sdf, lo, hi, step, transform) };

/** A close-cropped shell: proud over crown/back/sides, carved away from the brow and face. */
function hairCap(): Sdf {
  return blend(
    ellipsoid([0, 0.15, -0.1], [0.318, 0.412, 0.414]),
    [ellipsoid([0, -0.2, 0.39], [0.39, 0.35, 0.3]), -0.12],
    [ellipsoid([0, -0.34, 0.2], [0.34, 0.16, 0.22]), -0.08],
  );
}

/** The sculpted head, its bare counterpart for hair classification, and its world placement. */
function headModel(ctx: SketchContext): { head: ReturnType<typeof sculptHead>; bare: ReturnType<typeof sculptHead>; hair: Sdf; transform: THREE.Matrix4 } {
  const S = 100;
  const face = Object.fromEntries((['noseWidth', 'bridge', 'chin', 'jaw', 'lips', 'brow', 'cheeks', 'ears', 'cranium'] as const).map(k => [k, num(ctx, k)]));
  const options = {
    noseShape: 'planar' as const, nose: num(ctx, 'noseLength'), tilt: deg(num(ctx, 'tilt')), turn: deg(num(ctx, 'turn')), cock: deg(num(ctx, 'cock')),
    neck: num(ctx, 'neckLength'), neckR: num(ctx, 'neckWidth'), ...face,
  };
  const hair = hairCap();
  const bare = sculptHead(options);
  const head = sculptHead({ ...options, extras: [[hair, 0.026] as [Sdf, number]] });
  // The body's yaw turns away; the opposing neck turn brings the face back over its shoulder.
  const transform = new THREE.Matrix4().makeRotationZ(deg(num(ctx, 'roll'))).multiply(new THREE.Matrix4().makeRotationY(deg(num(ctx, 'yaw'))))
    .multiply(new THREE.Matrix4().makeScale(S, S, S));
  return { head, bare, hair, transform };
}

function buildHead(ctx: SketchContext, meshed?: SculptMesh): HeadStage {
  const S = 100;
  const { head, bare, hair, transform } = headModel(ctx);
  const mesh = meshed ?? meshSdf(head.sdf, head.lo, head.hi, num(ctx, 'step'), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const isHead = (p: V3) => head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p);

  // A nearly level camera fits the entire crowned head to the requested physical height; the long neck then finds its
  // real collar position from the projection rather than from a fixed page guess.
  const target = toW(head.at.chin).lerp(toW(head.at.neckBase), 0.42);
  const D = 8 * S;
  const lookUp = deg(num(ctx, 'lookUp'));
  const sample: THREE.Vector3[] = [];
  for (let v = 0; v < mesh.pos.length; v += 3 * 29) {
    const p: V3 = [mesh.pos[v], mesh.pos[v + 1], mesh.pos[v + 2]];
    if (isHead(p)) sample.push(toW(p));
  }
  const want = { h: num(ctx, 'headMm'), top: num(ctx, 'crownY'), x: num(ctx, 'headX') };
  const camera = (fov: number, ox: number, oy: number) => {
    const c = new THREE.PerspectiveCamera(fov, W / H, 1, 1e6);
    c.position.copy(target).add(new THREE.Vector3(0, -Math.sin(lookUp), Math.cos(lookUp)).multiplyScalar(D));
    c.lookAt(target);
    c.setViewOffset(W, H, ox, oy, W, H);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  let fov = 20;
  let ox = 0;
  let oy = 0;
  for (let it = 0; it < 30; it++) {
    const ps = sample.map(p => pageOf(camera(fov, ox, oy), p, PAGE));
    const y0 = Math.min(...ps.map(p => p.y));
    const y1 = Math.max(...ps.map(p => p.y));
    const x0 = Math.min(...ps.map(p => p.x));
    const x1 = Math.max(...ps.map(p => p.x));
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
  const noseGeo = subMesh(mesh, p => {
    const q = head.unplace(...p);
    return Math.abs(q[0]) < 0.085 && q[2] > 0.325 && q[1] > -0.19 && q[1] < 0.06;
  });
  // Keep the protective page mask tight to the real projected nose: a wide rectangular clearance turns a wrapped
  // lens into a notched billboard at three-quarter view.
  const onNose = meshCoverage([noseGeo], view, PAGE, 0);
  noseGeo.dispose();
  const eyeM = modelPoint(mesh, view.position);

  const light = new THREE.Vector3(num(ctx, 'lightX'), 1, num(ctx, 'lightZ')).normalize();
  const exactBrightness = (normal: V3) => Math.max(0, new THREE.Vector3(...normal).transformDirection(transform).dot(light)) ** 0.8;
  const fast = meshed !== undefined;
  let brightAt: Float64Array | undefined;
  const brightness = (sp: SurfacePoint) => {
    if (!fast || sp.a === undefined) return exactBrightness(sp.n);
    brightAt ??= perVertex(mesh, (_, normal) => exactBrightness(normal));
    return atPoint(brightAt, sp);
  };
  const TH = [-1, 0.18, 0.42];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[1];
  const headNy = (p: V3, normal: V3) => {
    const q = head.unplace(...p);
    const q2 = head.unplace(p[0] + normal[0] * 0.01, p[1] + normal[1] * 0.01, p[2] + normal[2] * 0.01);
    return (q2[1] - q[1]) / 0.01;
  };
  const facing = (sp: SurfacePoint) => sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  const isHairQ = (q: V3) => hair(...q) <= bare.parts.head(...q) + 0.002;
  const inLips = (q: V3) => q[2] > 0.3 && Math.hypot(q[0] / 0.118, (q[1] + 0.256) / 0.062) < 1.12;
  const inNoseQ = (q: V3) => Math.abs(q[0]) < 0.09 && q[2] > 0.325 && q[1] > -0.19 && q[1] < 0.06;
  /** A point just proud of the bare facial surface, so designed lip and visor contours turn and foreshorten with it. */
  const frontFacePoint = (x: number, y: number): THREE.Vector3 | undefined => {
    let inside = 0.02, outside = 0.78;
    if (bare.parts.head(x, y, inside) > 0 || bare.parts.head(x, y, outside) < 0) return undefined;
    for (let i = 0; i < 26; i++) {
      const mid = (inside + outside) / 2;
      if (bare.parts.head(x, y, mid) <= 0) inside = mid; else outside = mid;
    }
    return toW(head.place([x, y, outside + 0.006]));
  };

  type Zone = 'neck' | 'ear' | 'hair' | 'plate' | undefined;
  const zoneBy = (seam: number, p: V3): Zone => {
    if (seam > 0.004) return 'neck';
    const q = head.unplace(...p);
    if (isHairQ(q)) return 'hair';
    if (seam > -0.01) return undefined;
    return Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.12 ? 'ear' : 'plate';
  };
  const zoneOf = (p: V3): Zone => zoneBy(head.parts.head(...head.unplace(...p)) - head.parts.neck(...p), p);
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
  /** A designed curve in the head frame, split only where it leaves the face, then depth-tested with every other mark. */
  const faceCurve = (coords: readonly (readonly [number, number])[], pen: Pen, id: string, layer: Mark['layer'] = 'head') => {
    let run: THREE.Vector3[] = [];
    const flush = () => { if (run.length >= 2) marks.push({ points: run, pen, rank: 0, id, layer }); run = []; };
    for (const [x, y] of coords) {
      const p = frontFacePoint(x, y);
      if (p) run.push(p); else flush();
    }
    flush();
  };
  const keepRuns = (lines: IsoLine[], ok: (sp: SurfacePoint) => boolean, toned: boolean, pen: Pen, rank: number, id: string, step = 1, layer: Mark['layer'] = 'head') => {
    for (const line of lines) {
      const t = tier(Math.abs(Math.round(line.index / step)));
      let run: SurfacePoint[] = [];
      const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen, rank, id, layer }); run = []; };
      for (const sp of line.points) if (facing(sp) && ok(sp) && (!toned || brightness(sp) >= TH[t])) run.push(sp); else flush();
      flush();
    }
  };
  const hq = (fn: (q: V3) => number) => perVertex(mesh, p => fn(head.unplace(...p)));
  const headMm = num(ctx, 'headMm');
  const pitch = num(ctx, 'pitchMm') / headMm;

  // Bare skin only: hair and the lens around the lips never get plate hatch or gold plate seams.
  const rng = ctx.random('over-shoulder-plates');
  const seeds = scatterOn(mesh, num(ctx, 'plateMm') / headMm, rng, (p, v) => {
    const q = head.unplace(...p);
    return (seamAt ? zoneBy(seamAt[v], p) : zoneOf(p)) === 'plate' && !inLips(q);
  }, FEATURES.map(head.place), p => head.unplace(...p));
  const plates = platesOn(mesh, seeds, p => head.unplace(...p));
  const trisOf = new Map<string, number[]>();
  const borders = (v: number) => [plates.plate[v], plates.second[v]];
  const pairOf = (v: number) => { const a = plates.plate[v]; const b = plates.second[v]; return `${Math.min(a, b)}-${Math.max(a, b)}`; };
  for (let t = 0; t < mesh.tri.length; t += 3) {
    const [a, b, c] = [mesh.tri[t], mesh.tri[t + 1], mesh.tri[t + 2]];
    for (const key of new Set(borders(a))) if (borders(b).includes(key) && borders(c).includes(key)) {
      const list = trisOf.get(`p${key}`) ?? [];
      list.push(a, b, c);
      trisOf.set(`p${key}`, list);
    }
    if (pairOf(a) === pairOf(b) && pairOf(a) === pairOf(c)) {
      const list = trisOf.get(`s${pairOf(a)}`) ?? [];
      list.push(a, b, c);
      trisOf.set(`s${pairOf(a)}`, list);
    }
  }
  const only = (key: string): SculptMesh => ({ ...mesh, tri: Uint32Array.from(trisOf.get(key) ?? []) });
  seeds.forEach((seed, k) => {
    const feature = k < FEATURES.length;
    const outward = new THREE.Vector3(seed[0], seed[1] + 0.05, seed[2]).normalize();
    const base = seed[1] > CROWN || (seed[1] < JAW && seed[2] < 0.3) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const swing = (feature ? 0.3 : 1) * num(ctx, 'plateSwing') * (rng() * 2 - 1);
    const dirs = [base.clone().applyAxisAngle(outward, swing)];
    const style = rng();
    if (!feature && style < num(ctx, 'bareShare')) return;
    if (style > 1 - num(ctx, 'crossShare')) dirs.push(dirs[0].clone().applyAxisAngle(outward, 1.2 + 0.4 * rng()));
    for (const [j, direction] of dirs.entries()) {
      const value = new Float64Array(mesh.pos.length / 3).fill(NaN);
      for (let v = 0; v < value.length; v++) {
        if (plates.plate[v] !== k && plates.second[v] !== k) continue;
        const q = head.unplace(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
        value[v] = q[0] * direction.x + q[1] * direction.y + q[2] * direction.z;
      }
      const spacing = pitch * (j ? 1.7 : 1);
      keepRuns(isoLines(only(`p${k}`), value, spacing, rng() * spacing), sp => {
        const q = fast ? { plate: plates.plate[(sp.t ?? 0) < 0.5 ? sp.a! : sp.b!], gap: atPoint(plates.gap, sp) } : plates.at(sp.p);
        return q.plate === k && q.gap > SEAM && zoneAt(sp) === 'plate' && !inLips(head.unplace(...sp.p));
      }, true, 'silver', 2, 'plate');
    }
  });
  const pairs = new Set<number>();
  for (let v = 0; v < plates.plate.length; v++) if (plates.gap[v] < 0.03) {
    const a = plates.plate[v];
    const b = plates.second[v];
    pairs.add(Math.min(a, b) * 4096 + Math.max(a, b));
  }
  for (const key of pairs) {
    const a = Math.floor(key / 4096);
    const b = key % 4096;
    const sa = seeds[a];
    const sb = seeds[b];
    const value = new Float64Array(mesh.pos.length / 3).fill(NaN);
    for (let v = 0; v < value.length; v++) {
      const pa = plates.plate[v];
      const pb = plates.second[v];
      if (!((pa === a && pb === b) || (pa === b && pb === a))) continue;
      const q = head.unplace(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
      value[v] = Math.hypot(q[0] - sa[0], q[1] - sa[1], q[2] - sa[2]) - Math.hypot(q[0] - sb[0], q[1] - sb[1], q[2] - sb[2]);
    }
    keepRuns(isoLines(only(`s${a}-${b}`), value, 1, 0, [0]), sp => zoneAt(sp) === 'plate' && !inLips(head.unplace(...sp.p)), false, 'gold', 1, 'seam');
  }

  // The cap's flow is radial in the head frame, converging behind the crown instead of borrowing the skin's plates.
  const hairMesh = near((p, v) => (seamAt ? zoneBy(seamAt[v], p) : zoneOf(p)) === 'hair');
  const hairPhase = { values: hq(q => Math.atan2(q[0], q[1] - 0.07)), period: 2 * Math.PI };
  keepRuns(isoLines(hairMesh, new Float64Array(mesh.pos.length / 3), Math.PI / 45, 0, undefined, hairPhase), sp => zoneAt(sp) === 'hair', true, 'silver', 2, 'hair');
  const hairBoundary = hq(q => hair(...q) - bare.parts.head(...q));
  keepRuns(isoLines(mesh, hairBoundary, 1, 0, [0]), sp => {
    const q = head.unplace(...sp.p);
    return zoneAt(sp) === 'hair' && q[1] > -0.16;
  }, false, 'gold', 1, 'hairline');

  const earQ = head.unplace(...ear);
  const earTurn = pitch * 1.3;
  const earSpiral = { values: hq(q => Math.atan2(q[1] - earQ[1], q[2] - earQ[2])), period: 2 * Math.PI };
  keepRuns(isoLines(near(p => Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.14), hq(q => Math.hypot(q[1] - earQ[1], q[2] - earQ[2]) / earTurn * 2 * Math.PI), 2 * Math.PI, 0, undefined, earSpiral), sp => zoneAt(sp) === 'ear', false, 'silver', 2, 'ear');

  // Twisted long-neck meridians make the two turned ear-to-collar muscles read; only the central ridge is rose.
  const neckMesh = near((_, v) => seamAt![v] > -0.02);
  const neckPhase = { values: perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03) + 2.65 * (p[1] + 0.2)), period: 2 * Math.PI };
  const neckRise = perVertex(mesh, p => -0.43 * p[1]);
  keepRuns(isoLines(neckMesh, neckRise, pitch / 0.13, 0, undefined, neckPhase), sp => zoneAt(sp) === 'neck', true, 'silver', 2, 'neck');
  const neckLength = num(ctx, 'neckLength');
  for (let r = 0; r < num(ctx, 'neckRings'); r++) {
    const y = -0.22 - neckLength * (r + 1) / (num(ctx, 'neckRings') + 1);
    keepRuns(isoLines(neckMesh, perVertex(mesh, p => p[1]), 1, 0, [y]), sp => zoneAt(sp) === 'neck', false, 'gold', 1, 'ring');
  }
  // The only rose neck mark follows the visible sternomastoid itself: from the turned ear's back edge down toward the
  // collarbone, winding across the nape rather than describing a second symmetrical neck muscle.
  const neckMuscle = (side: number) => {
    const top = head.place([0.23 * side, -0.12, -0.08]);
    const bottom: V3 = [0.05 * side, -0.12 - neckLength, 0.13];
    const line: THREE.Vector3[] = [];
    for (let k = 0; k <= 32; k++) {
      const t = k / 32;
      const bow = side * 0.024 * Math.sin(Math.PI * t);
      const p: V3 = [
        top[0] * (1 - t) + bottom[0] * t + bow,
        top[1] * (1 - t) + bottom[1] * t,
        top[2] * (1 - t) + bottom[2] * t + 0.014 * Math.sin(Math.PI * t),
      ];
      const proud = new THREE.Vector3(...eyeM).sub(new THREE.Vector3(...p)).normalize().multiplyScalar(0.09);
      line.push(toW([p[0] + proud.x, p[1] + proud.y, p[2] + proud.z]));
    }
    marks.push({ points: line, pen: METALLIC, rank: 0, id: 'neck-twist', layer: 'head' });
  };
  neckMuscle(-1);

  for (const line of contourLines(mesh, eyeM)) marks.push({ points: toWorld(mesh, line.points), pen: 'gold', rank: 0, id: 'outline', layer: 'head' });
  const jawEdge = perVertex(mesh, (p, normal, v) => ((seamAt ? seamAt[v] <= 0 : isHead(p)) && head.unplace(...p)[1] < JAW ? headNy(p, normal) : 1));
  keepRuns(isoLines(mesh, jawEdge, 1, 0, [-0.35]), sp => zoneAt(sp) !== 'ear' && zoneAt(sp) !== 'hair', false, 'gold', 1, 'crease');
  keepRuns(isoLines(mesh, perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)), 1, 0, [0.004]), () => true, false, 'gold', 1, 'crease');

  const inNose = (sp: SurfacePoint) => inNoseQ(head.unplace(...sp.p));
  keepRuns(isoLines(mesh, hq(q => q[0]), 1, 0, [0]), inNose, false, 'gold', 0, 'nose');
  keepRuns(isoLines(mesh, perVertex(mesh, (p, normal) => headNy(p, normal)), 1, 0, [-0.55]), inNose, false, 'gold', 0, 'nose');
  for (const c of head.at.nostrils) keepRuns(isoLines(mesh, perVertex(mesh, p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 1, 0, [0.02]), () => true, false, 'gold', 1, 'nostril');

  // A true lip silhouette: cupid peaks and a fuller lower edge, with a shallow downturned parting. It stays a single
  // outline on the actual face rather than the old elliptical isoline that read as another eye in three-quarter view.
  faceCurve([
    [-0.082, -0.258], [-0.06, -0.247], [-0.036, -0.226], [-0.016, -0.229], [0, -0.251], [0.016, -0.229],
    [0.036, -0.226], [0.06, -0.247], [0.082, -0.258], [0.07, -0.279], [0.044, -0.299], [0, -0.307],
    [-0.044, -0.299], [-0.07, -0.279], [-0.082, -0.258],
  ], 'fluoro-pink', 'lips');
  faceCurve([
    [-0.079, -0.256], [-0.048, -0.258], [-0.016, -0.263], [0.02, -0.266], [0.052, -0.262], [0.079, -0.256],
  ], 'fluoro-pink', 'lip-parting');

  // The visor is made on the turned head's surface. Its 0.5 mm physical target is precompensated in the head frame
  // for the oblique fit; depth and a tight final mask leave the real projecting nose foremost without a blocky hole.
  const visorHalf = num(ctx, 'barMm') / (2 * headMm);
  const visorY = num(ctx, 'visorY');
  const visorLo = visorY - visorHalf;
  const visorHi = visorY + visorHalf;
  const onVisorArc = (sp: SurfacePoint) => {
    const q = head.unplace(...sp.p);
    return zoneAt(sp) !== 'neck' && q[2] > 0.06;
  };
  const inVisor = (sp: SurfacePoint) => {
    const q = head.unplace(...sp.p);
    return onVisorArc(sp) && q[1] >= visorLo && q[1] <= visorHi;
  };
  keepRuns(isoLines(mesh, hq(q => q[1]), VISOR_PITCH_MM * VISOR_FRAME_PITCH / headMm, 0), inVisor, false, 'fluoro-pink', 0, 'visor-row', 1, 'visor');
  // Draw both longitudinal rims from precisely the same visible arc as the fused rows. This avoids a page-flat
  // endpoint that can leave a loose wedge at the temple after the head turns.
  const visorRim = (level: number, pen: Pen, id: string) => keepRuns(
    isoLines(mesh, hq(q => q[1]), 1, 0, [level]), onVisorArc, false, pen, 0, id, 1, 'visor',
  );
  const visorTemple = (sp: SurfacePoint) => {
    const q = head.unplace(...sp.p);
    return zoneAt(sp) !== 'neck' && q[1] >= visorLo && q[1] <= visorHi;
  };
  visorRim(visorHi, 'fluoro-pink', 'visor-outline');
  visorRim(visorLo, METALLIC, 'visor-edge');
  // The front-arc cutoff gets its own 3-D temple seam, closing each row at precisely the same q.z contour instead of
  // leaving the fused fill with a sawtooth page-space end.
  keepRuns(isoLines(mesh, hq(q => q[2]), 1, 0, [0.06]), visorTemple, false, 'fluoro-pink', 0, 'visor-temple', 1, 'visor');

  const bias = hiddenBias(view, 0.012 * S, view.position.distanceTo(target));
  const seen: Seen[] = [];
  const visor: Seen[] = [];
  projectStrokes(marks, { view, depth, width: W, height: H, bias }, {
    begin: (mark: Mark) => (runs: ProjectedPoint[][]) => {
      const into = mark.layer === 'visor' ? visor : seen;
      for (const run of runs) for (const piece of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) if (pathLength(piece) >= 0.6) into.push({ pen: mark.pen, rank: mark.rank, id: mark.id, piece });
    },
  });
  geo.dispose();
  return { seen, visor, onHead, onNose, at, head };
}

/** The triangles all of whose vertices pass `keep`, used for the projecting nose mask. */
function subMesh(mesh: SculptMesh, keep: (p: V3) => boolean): THREE.BufferGeometry {
  const ok = new Uint8Array(mesh.pos.length / 3);
  for (let v = 0; v < ok.length; v++) ok[v] = keep([mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]]) ? 1 : 0;
  const tri: number[] = [];
  for (let t = 0; t < mesh.tri.length; t += 3) if (ok[mesh.tri[t]] && ok[mesh.tri[t + 1]] && ok[mesh.tri[t + 2]]) tri.push(mesh.tri[t], mesh.tri[t + 1], mesh.tri[t + 2]);
  return sculptGeometry({ ...mesh, tri: Uint32Array.from(tri) });
}

// ── The suit and distributed scan bars ───────────────────────────────

/**
 * The body from behind: an asymmetric shoulder and back yoke grow from the actual projected neck ring. A shallow,
 * wide stand collar rises at the nape, with a recessed rear vent and a centre-back seam that begins below it.
 */
function suitOf(left: Point, right: Point): { panels: Panel[]; lines: SuitLine[]; front: Point[][]; shirt: Point[][]; back: Point[][] } {
  const c = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const w = Math.max(14, right.x - left.x);
  const slope = (right.y - left.y) / Math.max(1, right.x - left.x);
  const P = (u: number, v: number): Point => ({ x: c.x + u * w, y: c.y + v * w + u * w * slope });
  const bottom = TRIM.y1 + 10;
  const L = TRIM.x0 - 10;
  const R = TRIM.x1 + 10;
  const down = (p: Point, x: number): Point => ({ x, y: p.y });
  const angleOf = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
  // This is one continuous standing collar, high behind the nape—not two pointed lapels. Its wide, shallow band
  // remains behind the neck, while the lower edge feeds directly into the yoke rather than becoming a plastron.
  const collar = [
    P(-0.72, 0.18), P(-0.62, -0.2), P(-0.25, -0.34), P(0.24, -0.31),
    P(0.62, -0.15), P(0.72, 0.22), P(0.25, 0.34), P(-0.35, 0.31),
  ];
  const collarVent = [P(-0.25, -0.08), P(0.28, -0.05), P(0.3, 0.08), P(-0.22, 0.12)];
  const yoke = [P(-0.98, 0.42), P(-0.58, 0.29), P(0.65, 0.3), P(1.55, 0.52), P(0.86, 0.82), P(-0.94, 0.78)];
  // Positive body yaw places the page-right plane nearest the viewer: it is intentionally broad and sloping.
  const nearShoulder = [P(0.65, 0.3), P(1.55, 0.52), down(P(4.2, 0.72), R), { x: R, y: bottom }, { x: P(0.74, 0).x, y: bottom }, P(0.86, 0.82)];
  const farShoulder = [P(-0.58, 0.29), P(-0.98, 0.42), down(P(-1.15, 1.45), L), { x: L, y: P(-0.96, 1.58).y }, { x: P(-0.75, 0).x, y: bottom }, P(-0.94, 0.78)];
  const lowerBack = [P(-0.94, 0.78), P(0.86, 0.82), { x: P(0.74, 0).x, y: bottom }, { x: P(-0.75, 0).x, y: bottom }];
  const seamBottom = { x: P(-0.08, 0).x, y: bottom };

  const panels: Panel[] = [
    { id: 'stand-collar', ring: collar, angle: 0.14, pitch: 0.88, pen: 'silver' },
    { id: 'back-yoke', ring: yoke, angle: 0.05, pitch: 0.92, pen: 'silver' },
    { id: 'near-shoulder', ring: nearShoulder, angle: angleOf(P(0.65, 0.3), seamBottom) + 0.24, pitch: 0.96, pen: 'silver' },
    { id: 'far-shoulder', ring: farShoulder, angle: angleOf(P(-0.58, 0.29), seamBottom) - 0.2, pitch: 1.08, pen: 'silver' },
    { id: 'lower-back', ring: lowerBack, angle: 0.16, pitch: 1.08, pen: 'silver' },
    { id: 'collar-vent', ring: collarVent, angle: 0.02, pitch: 1.18, pen: 'black', window: true },
  ];
  const lines: SuitLine[] = [
    { pen: 'gold', path: [P(-0.72, 0.18), P(-0.62, -0.2), P(-0.25, -0.34), P(0.24, -0.31), P(0.62, -0.15), P(0.72, 0.22)] },
    { pen: 'gold', path: [P(-0.94, 0.78), P(-0.22, 0.86), P(0.86, 0.82)] },
    { pen: 'gold', path: [P(-0.58, 0.29), P(-0.98, 0.42)] },
    { pen: 'gold', path: [P(0.65, 0.3), P(1.55, 0.52)] },
    { pen: 'gold', path: [P(0, 0.34), P(-0.015, 0.67), P(-0.05, 1.08), seamBottom] },
  ];
  return { panels, lines, front: [yoke, nearShoulder, farShoulder, lowerBack], shirt: [], back: [collarVent] };
}

const MAX_BANDS = 96;
const inBand = (b: ScanBand, p: Point) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/** Seeded vertical candidates: their kind is fixed per index while smooth noise moves their vertical endpoints and tear. */
function scanBands(ctx: SketchContext, headCentre: Point, collarTop: number): ScanBand[] {
  const phase = num(ctx, 'glitchPhase');
  const motion = num(ctx, 'glitchMotion');
  const scale = num(ctx, 'glitchScale');
  const noise = gradientNoise(ctx.random('over-shoulder-scan-noise'));
  const wave = (x: number, k: number) => 0.5 + 0.5 * noise(x / scale + 17.3 * k, phase * 0.35 + 5.1 * k);
  const mix = (seeded: number, x: number, k: number) => seeded + (wave(x, k) - seeded) * motion;
  const out: ScanBand[] = [];
  const requested = Math.round(num(ctx, 'bands'));
  const inside = (b: ScanBand, q: ScanBand) => !(b.x1 + 3 <= q.x0 || q.x1 + 3 <= b.x0 || b.y1 + 3 <= q.y0 || q.y1 + 3 <= b.y0);
  // A silver column has a physical 0.8 mm line pitch. Keep independently seeded columns farther apart than that
  // whenever their vertical spans meet, rather than allowing two nominally clean bars to fuse together.
  const touchesSilver = (b: ScanBand, q: ScanBand) => !(b.x1 + 0.8 <= q.x0 || q.x1 + 0.8 <= b.x0 || b.y1 <= q.y0 || q.y1 <= b.y0);
  for (let index = 0; index < MAX_BANDS; index++) {
    const rng = ctx.random(`over-shoulder-scan-${index}`);
    // Always consume this fixed tuple before any acceptance, kind or safety decision.
    const [xRoll, yRoll, widthRoll, lengthRoll, kindRoll, dvRoll, densityRoll, phaseRoll, shapeRoll, spareRoll] = Array.from({ length: 10 }, rng);
    // Six deliberately spaced tears make the scan displacement undeniable; four shorter, separately spaced cuts
    // replace the old single empty gold stripe. They are still seeded per index and retain phase-driven endpoints.
    const forcedShift = index < 6;
    const forcedCut = index >= 6 && index < 10;
    const lane = forcedShift ? index / 5 : (index - 6) / 3;
    const focusedX = forcedCut
      ? headCentre.x - 20 + (lane - 0.5) * 34
      : headCentre.x + (lane - 0.5) * 86 + (xRoll - 0.5) * 5;
    const x = forcedShift || forcedCut
      ? Math.max(TRIM.x0 + 6, Math.min(TRIM.x1 - 6, focusedX))
      : TRIM.x0 + 6 + xRoll * (TRIM.x1 - TRIM.x0 - 12);
    const dx = (x - headCentre.x) / 92;
    const dy = (TRIM.y0 + 155 - headCentre.y) / 155;
    const near = Math.exp(-(dx * dx + dy * dy));
    const kind: ScanBand['kind'] = forcedShift ? 'shift' : forcedCut ? 'cut' : kindRoll < 0.28 ? 'shift' : kindRoll < 0.84 ? 'silver' : 'pink';
    const density = kind === 'shift' ? 0.018 + 0.28 * near : kind === 'pink' ? 0.012 + 0.22 * near : kind === 'cut' ? 0.04 + 0.28 * near : 0.045 + 0.36 * near;
    const accepted = index < requested && (forcedShift || forcedCut || densityRoll < density);
    const narrow = 1.24 - 0.56 * near;
    const rawWidth = forcedShift ? (4.5 + 3 * widthRoll) * narrow : forcedCut ? 5.2 + 1.2 * widthRoll
      : kind === 'pink' ? (1.15 + 1.1 * widthRoll) * narrow : (0.8 + 2.7 * widthRoll) * narrow;
    const x0 = Math.max(TRIM.x0 + 6, x - rawWidth / 2);
    const x1 = Math.min(TRIM.x1 - 6, x + rawWidth / 2);
    const freeY0 = TRIM.y0 + 6 + 42 * mix(yRoll, x, 0) + 8 * (mix(phaseRoll, x, 3) - 0.5);
    // Keep the short rear-sheet cuts at the jaw/upper-neck transition: they show shifted hatch without obscuring the
    // pink mouth, and stop before they can merge with the rear collar vent.
    const y0 = forcedCut ? Math.max(TRIM.y0 + 6, headCentre.y + 48 + 16 * (mix(yRoll, x, 0) - 0.5)) : freeY0;
    // Most bars now survive past the collar into the back panels; the clipped cut variety still stops above it so the
    // knife windows cannot merge with the collar windows.
    const length = forcedShift ? 340 + 70 * mix(shapeRoll, x, 1) : forcedCut ? 34 + 26 * mix(shapeRoll, x, 1)
      : (125 + (135 + 190 * lengthRoll) * (0.46 + 0.54 * mix(shapeRoll, x, 1))) * (0.95 + 0.1 * spareRoll);
    let y1 = Math.min(TRIM.y1 - 6, y0 + length);
    if (kind === 'cut') y1 = Math.min(y1, collarTop - 5);
    const magnitude = 8 + 17 * near * (0.45 + 0.55 * mix(dvRoll, x, 2));
    // These four windows sit just below the mouth. Their otherwise seeded signs are chosen to pull dense jaw and
    // neck engraving into every rear-sheet opening, rather than leaving one as an empty yellow dash.
    const sign = forcedCut ? (index === 6 ? 1 : -1) : (dvRoll < 0.5 ? -1 : 1);
    const dv = sign * Math.round(magnitude * 2) / 2;
    const band: ScanBand = { x0, x1, y0, y1, dv, kind };
    const safeCut = kind !== 'cut' || (x1 - x0 >= 4.4 && y1 - y0 >= 8 && !out.filter(b => b.kind === 'cut').some(b => inside(band, b)));
    const safeSilver = kind !== 'silver' || !out.filter(b => b.kind === 'silver').some(b => touchesSilver(band, b));
    // Six deliberate tears need their own clear read across the face; incidental seeded shifts may not pile into them.
    const safeShift = kind !== 'shift' || forcedShift || !out.filter(b => b.kind === 'shift').some(b => inside(band, b));
    if (accepted && x1 - x0 >= 0.7 && y1 - y0 >= 8 && safeCut && safeSilver && safeShift) out.push(band);
  }
  return out;
}

/** Build the shared world: suit placement, wrapped visor, scan bands and the physical cut mask. */
export function erasure(ctx: SketchContext, stage?: HeadStage, options: { preview?: boolean } = {}): Erasure {
  const { seen, visor, onHead, onNose, at, head } = stage ?? headStage(ctx);
  const assembled = ctx.params.view !== 'head';
  const collarY = -num(ctx, 'collarAt');
  const ring: Point[] = [];
  for (let k = 0; k < 48; k++) {
    const a = 2 * Math.PI * k / 48;
    ring.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)]));
  }
  const left = ring.reduce((a, b) => (b.x < a.x ? b : a));
  const right = ring.reduce((a, b) => (b.x > a.x ? b : a));
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), neck: { left, right } };
  const headCentre = { x: (page.eyes[0].x + page.eyes[1].x + page.chin.x) / 3, y: (page.eyes[0].y + page.eyes[1].y + page.chin.y) / 3 };
  const collarTop = Math.min(...suit.back.flat().map(p => p.y), ...suit.shirt.flat().map(p => p.y));
  const scan = assembled ? scanBands(ctx, headCentre, collarTop) : [];
  const cutBands = scan.filter(b => b.kind === 'cut');
  const windowAt = (p: Point) => cutBands.some(b => inBand(b, p)) || suit.shirt.some(r => insideRing(r, p)) || suit.back.some(r => insideRing(r, p) && !onHead(p));
  // `traceMask` rounds the knife geometry at its 1.2 mm minimum radius; all scan cuts were already kept 6 mm inboard.
  const window = assembled ? traceMask(windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, options.preview ? 0.5 : 0.25, { simplify: options.preview ? 0.15 : 0.08, minRadius: 1.2, minArea: 6 }) : [];
  return { assembled, head: seen, visor, onHead, onNose, panels: suit.panels, suitLines: suit.lines, bySuit, shirt: suit.shirt, collarBack: suit.back, scan, window, page };
}

/** A panel's stripes (and optional cross-stripes), clipped to a grown panel and then the drawing rectangle. */
export function panelStripes(panel: Panel, grow = 0, clip: Rect = ART): Point[][] {
  const out = stripeFill(panel.ring, panel.angle, panel.pitch, grow);
  if (panel.cross !== undefined) out.push(...stripeFill(panel.ring, panel.cross, panel.pitch * 1.6, grow));
  return out.flatMap(path => clipToRect(path, clip)).flatMap(path => (grow ? [path] : keepAlong(path, q => insideRing(panel.ring, q), 0.2)));
}

/** Smooth seeded 2-D gradient noise, so moving glitchPhase moves rather than reseeds the scan field. */
function gradientNoise(rng: () => number): (x: number, y: number) => number {
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = [...perm, ...perm];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => {
    const a = (h & 7) * Math.PI / 4;
    return Math.cos(a) * x + Math.sin(a) * y;
  };
  return (x, y) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.4;
  };
}
