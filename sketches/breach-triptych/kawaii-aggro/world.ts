import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import {
  blend, capsule, contourLines, ellipsoid, isoLines, meshSdf, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry,
  toWorld, type IsoLine, type Sdf, type SculptMesh, type SurfacePoint, type V3,
} from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import type { GpuMesher } from '../../kit/sculpt-gpu.ts';
import { traceMask } from '../../kit/outline.ts';
import { stripeFill } from '../lodestone-cuts.ts';
import { ART, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Kawaii Aggro (after the Codex take A, with take C's wrapped visor): an elegant suit, not a clown. A restrained engraved portrait: a long-necked android head, cocked in three-quarter view, wears a
 * close cap swept into a single high side chignon. A fused magenta visor is its one field of colour. Horizontal
 * datamosh slices slide all marks and the gold-sheet windows along the bar, so the empty source positions are as much
 * a part of the drawing as the shifted ones.
 *
 * The front black ply carries silver, gold, fluoro-pink and very sparse metallic-rose gel. The gold-yellow rear
 * receives Micron black only through shifted shirt and collar openings. There are no props, icons, or slogans.
 */

const deg = THREE.MathUtils.degToRad;

export type Pen = 'silver' | 'gold' | 'fluoro-pink' | 'gel-rose' | 'black';
export interface Seen { pen: Pen; rank: number; id: string; piece: Point[] }
export interface SuitLine { pen: Pen; path: Point[]; behind?: boolean }
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }
/** A slice of the datamosh; a `cut` slice is also cut out of the black between u0 and u1, its drawing moved onto the gold. */
export interface Slice { v0: number; v1: number; du: number; active: boolean; smear: number; cut?: { u0: number; u1: number } }
export interface Erasure {
  assembled: boolean;
  head: Seen[];
  onHead: (p: Point) => boolean;
  onNose: (p: Point) => boolean;
  toPage: (u: number, v: number) => Point;
  toBar: (p: Point) => { u: number; v: number };
  barH: number;
  slices: Slice[];
  visorRows: Point[][];
  /** The pocket square (a ring) and its pink fill. */
  pocket: Point[];
  pocketFill: Point[][];
  /** The wrapped visor's marks (on the head's surface), and where it covers the sheet; empty for the flat bar. */
  visor: Seen[];
  onBand: (p: Point) => boolean;
  wrap: boolean;
  face: Rect;
  panels: Panel[];
  suitLines: SuitLine[];
  bySuit: (p: Point) => boolean;
  window: Point[][];
  page: { eyes: Point[]; noseTip: Point; chin: Point; neck: { left: Point; right: Point } };
}

interface Param {
  id: string; label: string; d: number; min: number; max: number; step: number; group: string; units?: string; head?: boolean
}
const P = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string, head?: boolean): Param =>
  ({ id, label, d, min, max, step, group, ...(units ? { units } : {}), ...(head ? { head } : {}) });
const HEAD = true;

export const PARAMS: Param[] = [
  P('tilt', 'Chin tipped down', -7, -20, 25, 1, 'Pose', '°', HEAD),
  P('turn', 'Head turned on the neck', 5, -35, 35, 1, 'Pose', '°', HEAD),
  P('cock', 'Head cocked on the neck', 15, -35, 35, 1, 'Pose', '°', HEAD),
  P('yaw', 'Figure turned toward the viewer', 24, -70, 70, 1, 'Pose', '°', HEAD),
  P('roll', 'Lean on the sheet', -3, -25, 25, 1, 'Pose', '°', HEAD),
  P('noseLength', 'Nose length', 1.05, 0.65, 1.5, 0.05, 'Face', undefined, HEAD),
  P('noseWidth', 'Nose width at the wings', 0.8, 0.55, 1.4, 0.05, 'Face', undefined, HEAD),
  P('bulb', 'Nose tip fullness', 0.8, 0.55, 1.25, 0.05, 'Face', undefined, HEAD),
  P('bridge', 'Nose bridge', 0.85, 0, 1.7, 0.05, 'Face', undefined, HEAD),
  P('chin', 'Chin forward', 0.65, 0.35, 1.7, 0.05, 'Face', undefined, HEAD),
  P('jaw', 'Jaw', 0.8, 0.55, 1.4, 0.05, 'Face', undefined, HEAD),
  P('lips', 'Lip fullness', 1.4, 0.7, 1.8, 0.05, 'Face', undefined, HEAD),
  P('brow', 'Brow softness', 0.7, 0.35, 1.5, 0.05, 'Face', undefined, HEAD),
  P('cheeks', 'Cheekbones', 1.25, 0.65, 1.7, 0.05, 'Face', undefined, HEAD),
  P('ears', 'Ears', 0.95, 0.6, 1.35, 0.05, 'Face', undefined, HEAD),
  P('cranium', 'Skull height', 1.02, 0.85, 1.2, 0.01, 'Face', undefined, HEAD),
  P('neckLength', 'Long neck', 2.0, 0.8, 2.5, 0.05, 'Face', undefined, HEAD),
  P('neckWidth', 'Neck thickness', 0.115, 0.09, 0.22, 0.005, 'Face', undefined, HEAD),
  P('hairTight', 'Hair cap proudness', 0.024, 0.01, 0.055, 0.002, 'Hair', undefined, HEAD),
  P('hairLength', 'Chignon fall', 0.75, 0.4, 1.3, 0.05, 'Hair', undefined, HEAD),
  P('ponyHeight', 'Chignon root height', 0.46, 0.28, 0.66, 0.01, 'Hair', undefined, HEAD),
  P('headMm', 'Head height on the sheet', 205, 130, 270, 1, 'Framing', 'mm', HEAD),
  P('crownY', 'Skull crown on the sheet', 67, 25, 180, 1, 'Framing', 'mm', HEAD),
  P('headX', 'Head across the sheet', 143, 45, 235, 1, 'Framing', 'mm', HEAD),
  P('lookUp', 'Camera looking up', 2, -8, 20, 1, 'Framing', '°', HEAD),
  P('collarAt', 'Collar on the neck', 0.72, 0.35, 1.45, 0.01, 'Framing'),
  P('pitchMm', 'Densest engraving pitch', 1.05, 0.8, 2.8, 0.05, 'Plates', 'mm', HEAD),
  P('plateMm', 'Plate size', 42, 14, 75, 1, 'Plates', 'mm', HEAD),
  P('bareShare', 'Plates left bare', 0.14, 0, 0.55, 0.01, 'Plates', undefined, HEAD),
  P('crossShare', 'Plates cross-hatched', 0.06, 0, 0.55, 0.01, 'Plates', undefined, HEAD),
  P('plateSwing', 'Plate line angle variation', 0.4, 0, 1.5, 0.05, 'Plates', undefined, HEAD),
  P('lightX', 'Light from the right', 0.1, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('lightZ', 'Light from the front', 0.95, -1, 1, 0.05, 'Plates', undefined, HEAD),
  P('neckRings', 'Neck segment rings', 2, 0, 5, 1, 'Plates', undefined, HEAD),
  P('step', 'Mesh detail (cell, head units; larger is faster)', 0.009, 0.006, 0.02, 0.001, 'Plates', undefined, HEAD),
  P('barMm', 'Visor height', 27, 16, 48, 0.5, 'Visor', 'mm'),
  P('barTilt', 'Visor tilt off eye line', -2, -20, 20, 0.5, 'Visor', '°'),
  P('eyeInBar', 'Visor lower on the eyes', 0.06, -0.35, 0.35, 0.01, 'Visor'),
  P('barPast', 'Visor past nose tip', 11, 0, 60, 1, 'Visor', 'mm'),
  P('fillMm', 'Pink fill spacing (open, not fused)', 1.8, 0.9, 4, 0.05, 'Visor', 'mm'),
  P('fillPeriodMm', 'Pink pattern period', 11, 2, 24, 0.5, 'Visor', 'mm'),
  P('noseFront', 'Nose in front of visor', 0.76, 0, 1, 0.01, 'Visor', undefined, HEAD),
  P('shiftMm', 'Largest sideways slice shift', 25, 0, 48, 0.5, 'Glitch', 'mm'),
  P('glitchReach', 'Glitch reach from visor', 130, 50, 190, 1, 'Glitch', 'mm'),
  P('sliceMinMm', 'Thinnest slice', 1.5, 1, 6, 0.1, 'Glitch', 'mm'),
  P('sliceMaxMm', 'Thickest slice', 14, 3, 24, 0.5, 'Glitch', 'mm'),
  P('sliceShare', 'Slices moved', 0.16, 0, 1, 0.01, 'Glitch'),
  P('smear', 'Visor smear in moved slices', 0, 0, 1, 0.01, 'Glitch'),
  P('cutShare', 'Slices cut through to the gold', 0.7, 0, 1, 0.01, 'Glitch'),
  P('glitchPhase', 'Glitch phase', 0, 0, 20, 0.01, 'Motion'),
  P('glitchMotion', 'Phase movement', 0.6, 0, 1, 0.01, 'Motion'),
  P('glitchScale', 'Noise wavelength along visor', 40, 5, 200, 1, 'Motion', 'mm'),
];
const BY_ID = new Map(PARAMS.map(p => [p.id, p]));
export function num(ctx: SketchContext, id: string): number {
  const p = BY_ID.get(id)!;
  return n(ctx, id, p.d, p.min, p.max);
}
/** The pink fills: open patterns, never fused (the gel pens wear down on fused fills). */
export const FILLS = ['chevron', 'diamond', 'contour', 'scan'] as const;
export const CONTROLS: Control[] = [
  ...PARAMS.map((p): Control => ({
    type: 'slider', id: p.id, label: p.label, default: p.d, min: p.min, max: p.max, step: p.step, group: p.group,
    ...(p.units ? { units: p.units } : {}), ...(p.head ? { expensive: true } : {}),
  })),
  {
    type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'],
    optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no visor or datamosh)' }, group: 'Glitch',
  },
  {
    type: 'select', id: 'visorStyle', label: 'Visor', default: 'wrap', options: ['wrap', 'bar'],
    optionLabels: { wrap: 'Wrapped round the head (on its surface)', bar: 'A flat bar off the sheet\'s edge' }, group: 'Visor', expensive: true,
  },
  {
    type: 'select', id: 'visorFill', label: 'Pink fill (the visor and the pocket square)', default: 'chevron', options: [...FILLS],
    optionLabels: { chevron: 'Zigzag rows', diamond: 'Diamonds (harlequin)', contour: 'Concentric, following the edge', scan: 'Open scanlines' }, group: 'Visor', expensive: true,
  },
];
export type Fill = typeof FILLS[number];
export const fillOf = (ctx: SketchContext): Fill => (FILLS.includes(ctx.params.visorFill as Fill) ? ctx.params.visorFill as Fill : 'chevron');

/**
 * A pink fill pattern in a flat shape: rows `spacing` apart along `angle` (zigzagging with `period` for chevrons), two
 * crossing families for diamonds, or rings inset from the edge for a contour; each clipped to the ring.
 */
export function patternIn(ring: Point[], fill: Fill, spacing: number, period: number, angle = 0): Point[][] {
  const xs = ring.map(p => p.x), ys = ring.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const r = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + spacing;
  const clip = (paths: Point[][]) => paths.flatMap(path => keepAlong(path, q => insideRing(ring, q), 0.1)).filter(p => pathLength(p) > 0.4);
  if (fill === 'contour') {
    // Rings inset from the edge as evenly along the shape as across it: scaled toward the middle in the shape's own frame,
    // each axis by its own half-extent.
    const c = Math.cos(angle), sn = Math.sin(angle);
    const local = ring.map(p => ({ x: (p.x - cx) * c + (p.y - cy) * sn, y: -(p.x - cx) * sn + (p.y - cy) * c }));
    const hx = Math.max(...local.map(p => Math.abs(p.x))), hy = Math.max(...local.map(p => Math.abs(p.y)));
    const out: Point[][] = [];
    for (let k = 1; k < 80; k++) {
      const tx = 1 - k * spacing / hx, ty = 1 - k * spacing / hy;
      if (tx <= 0.05 || ty <= 0.05) break;
      const inset = local.map(p => ({ x: cx + p.x * tx * c - p.y * ty * sn, y: cy + p.x * tx * sn + p.y * ty * c }));
      out.push([...inset, inset[0]]);
    }
    return out;
  }
  const rows = (a: number, zig: boolean) => {
    const d = { x: Math.cos(a), y: Math.sin(a) }, nrm = { x: -d.y, y: d.x }, out: Point[][] = [];
    for (let o = -r; o <= r; o += spacing) {
      const path: Point[] = [];
      for (let t = -r; t <= r + 1e-9; t += zig ? period / 2 : 2 * r) {
        const lift = zig ? (Math.round(t / (period / 2)) % 2 ? period * 0.3 : 0) : 0;
        path.push({ x: cx + d.x * t + nrm.x * (o + lift), y: cy + d.y * t + nrm.y * (o + lift) });
      }
      out.push(path);
    }
    return out;
  };
  if (fill === 'diamond') return clip([...rows(angle + Math.PI / 4, false), ...rows(angle - Math.PI / 4, false)]);
  return clip(rows(angle, fill === 'chevron'));
}

const CROWN = 0.2, JAW = -0.3, SEAM = 0.007;
interface Mark { points: THREE.Vector3[]; pen: Pen; rank: number; id: string }
const FEATURES: V3[] = [
  [0, -0.11, 0.47], [0, 0.03, 0.4], [0, -0.24, 0.4], [0, -0.41, 0.33], [0, -0.47, 0.2],
  [0.18, -0.05, 0.25], [-0.18, -0.05, 0.25], [0.21, -0.3, 0.12], [-0.21, -0.3, 0.12],
  [0.12, 0.13, 0.33], [-0.12, 0.13, 0.33],
];
export interface HeadStage {
  seen: Seen[];
  onHead: (p: Point) => boolean;
  onNose: (p: Point) => boolean;
  at: (p: V3) => Point;
  face: Rect;
  head: ReturnType<typeof sculptHead>;
  visor: Seen[];
  onBand: (p: Point) => boolean;
}

let lastHead: { key: string; stage: HeadStage } | undefined;
const headKey = (ctx: SketchContext, mode: 'cpu' | 'gpu') =>
  JSON.stringify([mode, ctx.seed, wrapped(ctx), fillOf(ctx), num(ctx, 'barMm'), num(ctx, 'eyeInBar'), num(ctx, 'fillMm'), num(ctx, 'fillPeriodMm'), ...PARAMS.filter(p => p.head).map(p => num(ctx, p.id))]);
/** Is the visor wrapped round the head (drawn on its surface) rather than a flat bar? */
export const wrapped = (ctx: SketchContext) => ctx.params.visorStyle !== 'bar';
function headStage(ctx: SketchContext): HeadStage {
  const key = headKey(ctx, 'cpu');
  if (lastHead?.key !== key) lastHead = { key, stage: buildHead(ctx) };
  return lastHead.stage;
}
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
export interface CpuMesher {
  mesh(sdf: Parameters<typeof meshSdf>[0], lo: V3, hi: V3, step: number, transform: THREE.Matrix4): Promise<SculptMesh>
}
export const cpuMesher: CpuMesher = { mesh: async (sdf, lo, hi, step, transform) => meshSdf(sdf, lo, hi, step, transform) };

interface HairPlan { sdf: Sdf; root: V3; bend: V3; tip: V3 }
function hairOf(ctx: SketchContext): HairPlan {
  const proud = num(ctx, 'hairTight');
  const root: V3 = [0.02, num(ctx, 'ponyHeight'), -0.36];
  const bend: V3 = [0.18, 0.43, -0.4];
  const tip: V3 = [0.37, 0.51 - num(ctx, 'hairLength') * 0.23, -0.36];
  // A rear-crown shell keeps forehead and ears clear; the short, high side sweep reads as a compact chignon when seen
  // in profile rather than as a second, oversized head mass.
  const cap = blend(
    ellipsoid([0, 0.28, -0.18], [0.3 + proud, 0.31 + proud, 0.3 + proud]),
    [ellipsoid([0, 0.08, 0.23], [0.34, 0.31, 0.34]), -0.035],
    [ellipsoid([0.33, -0.03, -0.04], [0.08, 0.15, 0.11]), -0.016],
    [ellipsoid([-0.33, -0.03, -0.04], [0.08, 0.15, 0.11]), -0.016],
  );
  return {
    // The rounded knot is intentionally a little proud of the shell, so the tied-up silhouette survives the fine
    // engraving rather than becoming another ridge in the cap.
    sdf: blend(cap, [capsule(root, bend, 0.07, 0.075), 0.035], [ellipsoid(tip, [0.12, 0.13, 0.12]), 0.035]),
    root, bend, tip,
  };
}
function headModel(ctx: SketchContext): {
  head: ReturnType<typeof sculptHead>; bare: ReturnType<typeof sculptHead>; hair: HairPlan; transform: THREE.Matrix4
} {
  const S = 100;
  const face = Object.fromEntries(([
    'noseWidth', 'bulb', 'bridge', 'chin', 'jaw', 'lips', 'brow', 'cheeks', 'ears', 'cranium',
  ] as const).map(id => [id, num(ctx, id)]));
  const options = {
    noseShape: 'planar' as const, nose: num(ctx, 'noseLength'), tilt: deg(num(ctx, 'tilt')), turn: deg(num(ctx, 'turn')),
    cock: deg(num(ctx, 'cock')), neck: num(ctx, 'neckLength'), neckR: num(ctx, 'neckWidth'), ...face,
  };
  const bare = sculptHead(options), hair = hairOf(ctx);
  const head = sculptHead({ ...options, extras: [[hair.sdf, 0.02]] });
  const transform = new THREE.Matrix4().makeRotationZ(deg(num(ctx, 'roll')))
    .multiply(new THREE.Matrix4().makeRotationY(deg(num(ctx, 'yaw'))))
    .multiply(new THREE.Matrix4().makeScale(S, S, S));
  return { head, bare, hair, transform };
}
function distanceToSegment(q: V3, a: V3, b: V3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy + (q[2] - a[2]) * dz) / l2));
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy, q[2] - a[2] - t * dz);
}

/** The forward facial plane stays fully engraved; only the skull's turned-away side may be left bare. */
function isFacePoint(q: V3): boolean {
  return q[2] > 0.1 && q[1] > -0.48 && q[1] < 0.23;
}

function buildHead(ctx: SketchContext, meshed?: SculptMesh): HeadStage {
  const S = 100, { head, bare, hair, transform } = headModel(ctx);
  const mesh = meshed ?? meshSdf(head.sdf, head.lo, head.hi, num(ctx, 'step'), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const own = (p: V3) => head.unplace(...p);
  const isHair = (p: V3) => {
    const q = own(p);
    // Smoothly blending the cap into the skull makes their zero sets almost coincide at the hairline. A small positive
    // band keeps plate seams out of that blend instead of making black polygon cracks through the flow engraving.
    const tail = Math.min(distanceToSegment(q, hair.root, hair.bend), distanceToSegment(q, hair.bend, hair.tip));
    return hair.sdf(...q) < 0.055 && (q[1] > 0.16 || q[2] < -0.12 || tail < 0.16);
  };
  const isBareHead = (p: V3) => {
    const q = own(p);
    return !isHair(p) && bare.parts.head(...q) <= bare.parts.neck(...p);
  };

  // Fit only the skull, not the tail: the latter can swing freely without shrinking the portrait.
  const target = toW(head.at.chinUnder).lerp(toW(head.at.neckBase), 0.4);
  const D = 8 * S, lookUp = deg(num(ctx, 'lookUp')), sample: THREE.Vector3[] = [];
  for (let v = 0; v < mesh.pos.length; v += 3 * 29) {
    const p: V3 = [mesh.pos[v], mesh.pos[v + 1], mesh.pos[v + 2]];
    if (isBareHead(p)) sample.push(toW(p));
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
  let fov = 20, ox = 0, oy = 0;
  for (let i = 0; i < 30; i++) {
    const ps = sample.map(p => pageOf(camera(fov, ox, oy), p, PAGE));
    const y0 = Math.min(...ps.map(p => p.y)), y1 = Math.max(...ps.map(p => p.y));
    const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(fov) / 2) * (y1 - y0) / want.h));
    ox += ((x0 + x1) / 2 - want.x) / MM_X * 0.7;
    oy += (y0 - want.top) / MM_Y * 0.7;
  }
  const view = camera(fov, ox, oy), at = (p: V3) => pageOf(view, toW(p), PAGE);
  const facePoints: Point[] = [];
  for (let i = 0; i < mesh.pos.length; i += 15) {
    const p: V3 = [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]];
    if (isBareHead(p) && isFacePoint(own(p))) facePoints.push(at(p));
  }
  const face = facePoints.length ? {
    x0: Math.min(...facePoints.map(p => p.x)) - 3, x1: Math.max(...facePoints.map(p => p.x)) + 3,
    y0: Math.min(...facePoints.map(p => p.y)) - 3, y1: Math.max(...facePoints.map(p => p.y)) + 3,
  } : { ...ART };
  const geo = sculptGeometry(mesh);
  fitDepthRange(view, [geo], 0.1, { exact: true });
  const depth = renderDepthBufferCPU([geo], view, W, H);
  const onHead = meshCoverage([geo], view, PAGE, 0);
  const noseGeo = subMesh(mesh, p => {
    const q = own(p);
    return Math.abs(q[0]) < 0.08 && q[2] > 0.35 && q[1] > -0.19 && q[1] < -0.12 + 0.18 * num(ctx, 'noseFront');
  });
  const onNose = meshCoverage([noseGeo], view, PAGE, 1.0);
  noseGeo.dispose();
  const eyeM = modelPoint(mesh, view.position);
  const light = new THREE.Vector3(num(ctx, 'lightX'), 1, num(ctx, 'lightZ')).normalize();
  const brightness = (sp: SurfacePoint) => Math.max(0, new THREE.Vector3(...sp.n).transformDirection(transform).dot(light)) ** 0.8;
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const thresholds = [-1, 0.16, 0.36], ear = head.at.ears[1];
  type Zone = 'hair' | 'neck' | 'ear' | 'plate' | undefined;
  const zoneOf = (p: V3): Zone => {
    if (isHair(p)) return 'hair';
    const seam = bare.parts.head(...own(p)) - bare.parts.neck(...p);
    if (seam > 0.004) return 'neck';
    if (seam > -0.01) return undefined;
    return Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.12 ? 'ear' : 'plate';
  };
  const facing = (sp: SurfacePoint) =>
    sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  const marks: Mark[] = [];
  const keepRuns = (
    lines: IsoLine[], okay: (sp: SurfacePoint) => boolean, toned: boolean, pen: Pen, rank: number, id: string, step = 1,
    toneFloor?: (sp: SurfacePoint, tier: number) => boolean, showBack = false,
  ) => {
    for (const line of lines) {
      const t = tier(Math.abs(Math.round(line.index / step)));
      let run: SurfacePoint[] = [];
      const flush = () => {
        if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen, rank, id });
        run = [];
      };
      for (const sp of line.points) {
        const lit = brightness(sp) >= thresholds[t] || toneFloor?.(sp, t);
        if ((showBack || facing(sp)) && okay(sp) && (!toned || lit)) run.push(sp);
        else flush();
      }
      flush();
    }
  };
  const headMm = num(ctx, 'headMm'), pitch = num(ctx, 'pitchMm') / headMm;
  const inLips = (q: V3) => {
    const a = Math.abs(q[0]) / 0.095;
    if (a >= 1 || q[2] < 0.31) return false;
    const upper = -0.26 + 0.035 * (1 - a ** 1.5) - 0.018 * Math.exp(-((a / 0.25) ** 2));
    const lower = -0.273 - 0.041 * (1 - a ** 1.8);
    return q[1] <= upper + 0.008 && q[1] >= lower - 0.008;
  };

  // Plate cells remain on the exposed skin only. The forward face gets every cell and a two-in-four-line tone floor,
  // so the portrait reads under the lowered chin while the back/side of the skull can still breathe.
  const rng = ctx.random('ka-codex-a-plates');
  const seeds = scatterOn(
    mesh, num(ctx, 'plateMm') / headMm, rng, p => zoneOf(p) === 'plate', FEATURES.map(head.place), p => own(p),
  );
  const plates = platesOn(mesh, seeds, p => own(p));
  const directions = seeds.map((seed, index) => {
    const outward = new THREE.Vector3(seed[0], seed[1] + 0.05, seed[2]).normalize();
    const base = seed[1] > CROWN || (seed[1] < JAW && seed[2] < 0.3) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    return base.applyAxisAngle(outward, (index < FEATURES.length ? 0.3 : 1) * num(ctx, 'plateSwing') * (rng() * 2 - 1));
  });
  const style = seeds.map((_, index) => index < FEATURES.length ? 1 : rng());
  const hatch = perVertex(mesh, (p, _normal, v) => {
    const q = own(p), d = directions[plates.plate[v]];
    return q[0] * d.x + q[1] * d.y + q[2] * d.z;
  });
  keepRuns(isoLines(mesh, hatch, pitch, rng() * pitch), sp => {
    const q = own(sp.p), plate = plates.plate[sp.a ?? 0];
    return zoneOf(sp.p) === 'plate' && plates.gap[sp.a ?? 0] > SEAM
      && (isFacePoint(q) || style[plate] >= num(ctx, 'bareShare')) && !inLips(q);
  }, true, 'silver', 2, 'plate', 1, (sp, t) => isFacePoint(own(sp.p)) && t < 2);
  const cross = perVertex(mesh, (p, _normal, v) => {
    const q = own(p), d = directions[plates.plate[v]].clone().applyAxisAngle(new THREE.Vector3(q[0], q[1] + 0.05, q[2]).normalize(), 1.3);
    return q[0] * d.x + q[1] * d.y + q[2] * d.z;
  });
  keepRuns(isoLines(mesh, cross, pitch * 1.7, rng() * pitch), sp => {
    const plate = plates.plate[sp.a ?? 0];
    return zoneOf(sp.p) === 'plate' && plates.gap[sp.a ?? 0] > SEAM && style[plate] > 1 - num(ctx, 'crossShare') && !inLips(own(sp.p));
  }, true, 'silver', 2, 'plate-cross', 1, (sp, t) => isFacePoint(own(sp.p)) && t < 2);
  keepRuns(isoLines(mesh, plates.gap, 1, 0, [0.002]), sp => zoneOf(sp.p) === 'plate' && !inLips(own(sp.p)), false, 'gold', 1, 'seam');

  const earQ = own(ear), earPhase = {
    values: perVertex(mesh, p => Math.atan2(own(p)[1] - earQ[1], own(p)[2] - earQ[2])),
    period: 2 * Math.PI,
  };
  const earValue = perVertex(mesh, p => Math.hypot(own(p)[1] - earQ[1], own(p)[2] - earQ[2]) / (pitch * 1.3) * 2 * Math.PI);
  keepRuns(isoLines(mesh, earValue, 2 * Math.PI, 0, undefined, earPhase), sp => zoneOf(sp.p) === 'ear', false, 'silver', 2, 'ear');
  const neckValue = perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03));
  keepRuns(isoLines(mesh, neckValue, pitch / 0.15), sp => zoneOf(sp.p) === 'neck', true, 'silver', 2, 'neck');
  for (let r = 0; r < num(ctx, 'neckRings'); r++) {
    keepRuns(isoLines(mesh, perVertex(mesh, p => p[1]), 1, 0, [-0.5 - 0.15 * r]), sp => zoneOf(sp.p) === 'neck', false, 'gold', 1, 'neck-ring');
  }

  // Wrapped angular fields make the cap rays converge at the root and the tail lines run lengthwise.
  const hairMesh = meshOf(mesh, p => zoneOf(p) === 'hair');
  const zero = new Float64Array(mesh.pos.length / 3);
  const capPhase = { values: perVertex(mesh, p => {
    const q = own(p);
    return Math.atan2(q[0] - hair.root[0], q[1] - hair.root[1]);
  }), period: 2 * Math.PI };
  const onTail = (q: V3) => Math.min(distanceToSegment(q, hair.root, hair.bend), distanceToSegment(q, hair.bend, hair.tip)) < 0.132;
  keepRuns(
    isoLines(hairMesh, zero, pitch / 0.33, 0, undefined, capPhase), sp => zoneOf(sp.p) === 'hair' && !onTail(own(sp.p)),
    true, 'silver', 2, 'hair-cap', 1, (_sp, t) => t < 2, true,
  );
  const axis = new THREE.Vector3(hair.tip[0] - hair.root[0], hair.tip[1] - hair.root[1], hair.tip[2] - hair.root[2]).normalize();
  const a = new THREE.Vector3(0, 0, 1).cross(axis).normalize(), b = axis.clone().cross(a).normalize();
  const tailPhase = { values: perVertex(mesh, p => {
    const q = own(p), r = new THREE.Vector3(q[0] - hair.bend[0], q[1] - hair.bend[1], q[2] - hair.bend[2]);
    return Math.atan2(r.dot(b), r.dot(a));
  }), period: 2 * Math.PI };
  keepRuns(
    isoLines(hairMesh, zero, pitch / 0.09, 0, undefined, tailPhase), sp => zoneOf(sp.p) === 'hair' && onTail(own(sp.p)),
    true, 'silver', 2, 'hair-tail', 1, (_sp, t) => t < 2, true,
  );

  // The silhouette stays gold, including the chignon. Its lip segment is suppressed so pink linework remains outline-only.
  for (const contour of contourLines(mesh, eyeM)) {
    let run: SurfacePoint[] = [];
    const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen: 'gold', rank: 0, id: 'outline' }); run = []; };
    for (const sp of contour.points) { if (inLips(own(sp.p))) flush(); else run.push(sp); }
    flush();
  }
  const headNy = (p: V3, normal: V3) => {
    const q = own(p), q2 = own([p[0] + normal[0] * 0.01, p[1] + normal[1] * 0.01, p[2] + normal[2] * 0.01]);
    return (q2[1] - q[1]) / 0.01;
  };
  const jaw = perVertex(mesh, (p, normal) => isBareHead(p) && own(p)[1] < JAW ? headNy(p, normal) : 1);
  keepRuns(isoLines(mesh, jaw, 1, 0, [-0.35, -0.12]), sp => zoneOf(sp.p) !== 'ear' && zoneOf(sp.p) !== 'hair', false, 'gold', 1, 'jaw');
  const inNose = (sp: SurfacePoint) => {
    const q = own(sp.p);
    return Math.abs(q[0]) < 0.07 && q[2] > 0.33 && q[1] > -0.18 && q[1] < 0.04;
  };
  keepRuns(isoLines(mesh, perVertex(mesh, p => own(p)[0]), 1, 0, [0]), inNose, false, 'gold', 0, 'nose');
  keepRuns(isoLines(mesh, perVertex(mesh, (p, normal) => headNy(p, normal)), 1, 0, [-0.55]), inNose, false, 'gold', 0, 'nose');

  // Curves are walked onto the actual face surface and then depth-projected as marks, never drawn flat on the page.
  const facePoint = (x: number, y: number): THREE.Vector3 | undefined => {
    let outside = 0.74, outsideValue = head.parts.head(x, y, outside);
    for (let z = 0.73; z >= 0.16; z -= 0.008) {
      const value = head.parts.head(x, y, z);
      if (value <= 0 && outsideValue > 0) {
        let hi = outside, lo = z;
        for (let i = 0; i < 9; i++) {
          const mid = (hi + lo) / 2;
          if (head.parts.head(x, y, mid) > 0) hi = mid;
          else lo = mid;
        }
        return toW(head.place([x, y, hi + 0.005]));
      }
      outside = z;
      outsideValue = value;
    }
    return undefined;
  };
  const faceRuns = (ring: { x: number; y: number }[]) => {
    const runs: THREE.Vector3[][] = [], run: THREE.Vector3[] = [];
    for (const p of ring) {
      const point = facePoint(p.x, p.y);
      if (point) run.push(point);
      else if (run.length) { runs.push([...run]); run.length = 0; }
    }
    if (run.length) runs.push(run);
    return runs;
  };
  const addFaceMark = (ring: { x: number; y: number }[], pen: Pen, id: string) => {
    for (const points of faceRuns(ring)) if (points.length >= 2) marks.push({ points, pen, rank: 0, id });
  };

  // The nose and facial planes get a few deliberate gold articulations in addition to the engraved cells. These are
  // surface-walked like the lips, so their ridge, underside, nostrils, cheekbones and jaw stay attached to the form.
  const ridge: { x: number; y: number }[] = [], under: { x: number; y: number }[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20, u = -1 + 2 * t;
    ridge.push({ x: 0, y: 0.048 - 0.195 * t });
    under.push({ x: 0.066 * u, y: -0.168 - 0.014 * (1 - u * u) });
  }
  addFaceMark(ridge, 'gold', 'nose-ridge');
  addFaceMark(under, 'gold', 'nose-under');
  for (const side of [-1, 1]) {
    const nostril: { x: number; y: number }[] = [], cheek: { x: number; y: number }[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = 2 * Math.PI * i / 16, t = i / 16;
      nostril.push({ x: side * 0.043 + 0.019 * Math.cos(a), y: -0.15 + 0.011 * Math.sin(a) });
      cheek.push({ x: side * (0.075 + 0.065 * t), y: 0.045 - 0.085 * t });
    }
    addFaceMark(nostril, 'gold', 'nostril');
    addFaceMark(cheek, 'gold', 'cheekbone');
  }
  const upper: { x: number; y: number }[] = [], lower: { x: number; y: number }[] = [], parting: { x: number; y: number }[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = -1 + 2 * i / 28, q = Math.abs(t);
    upper.push({ x: 0.086 * t, y: -0.26 + 0.035 * (1 - q ** 1.5) - 0.018 * Math.exp(-((t / 0.25) ** 2)) });
    parting.push({ x: 0.084 * t, y: -0.268 + 0.003 * (1 - t * t) });
  }
  for (let i = 28; i >= 0; i--) {
    const t = -1 + 2 * i / 28, q = Math.abs(t);
    upper.push({ x: 0.086 * t, y: -0.271 + 0.006 * (1 - q ** 1.8) });
  }
  for (let i = 0; i <= 28; i++) {
    const t = -1 + 2 * i / 28, q = Math.abs(t);
    lower.push({ x: 0.089 * t, y: -0.273 + 0.003 * (1 - q ** 1.8) });
  }
  for (let i = 28; i >= 0; i--) {
    const t = -1 + 2 * i / 28, q = Math.abs(t);
    lower.push({ x: 0.089 * t, y: -0.273 - 0.041 * (1 - q ** 1.8) });
  }
  for (const curve of [upper, lower, parting]) for (const points of faceRuns(curve)) {
    if (points.length >= 2) marks.push({ points, pen: 'fluoro-pink', rank: 0, id: 'lips' });
  }
  const hairline = Array.from({ length: 31 }, (_, i) => {
    const t = -1 + 2 * i / 30;
    return { x: 0.265 * t, y: 0.17 + 0.13 * (1 - t * t) };
  });
  for (const points of faceRuns(hairline)) if (points.length >= 2) marks.push({ points, pen: 'gold', rank: 0, id: 'hairline' });

  // One fine metallic line joins lower lip, chin and throat; a small tie ring is the only other rose accent.
  const lip = toW(head.at.lipLower);
  const midline = perVertex(mesh, p => {
    const q = own(p), blendNeck = Math.max(0, Math.min(1, (bare.parts.neck(...p) - bare.parts.head(...q)) / 0.05 + 0.5));
    return blendNeck * q[0] + (1 - blendNeck) * p[0];
  });
  for (const line of isoLines(mesh, midline, 1, 0, [0.004])) {
    const points = toWorld(mesh, line.points);
    let closest = 0, distance = Infinity;
    points.forEach((p, i) => { const d = p.distanceTo(lip); if (d < distance) { distance = d; closest = i; } });
    if (distance > 0.05 * S) continue;
    const down = points[Math.min(closest + 3, points.length - 1)].y < points[closest].y ? 1 : -1;
    const run: THREE.Vector3[] = [];
    for (let i = closest; i >= 0 && i < points.length; i += down) run.push(points[i]);
    if (run.length >= 2) marks.push({ points: run, pen: 'gel-rose', rank: 0, id: 'throat-thread' });
  }
  const tangent = new THREE.Vector3(hair.tip[0] - hair.root[0], hair.tip[1] - hair.root[1], hair.tip[2] - hair.root[2]).normalize();
  const tieA = new THREE.Vector3(0, 0, 1).cross(tangent).normalize(), tieB = tangent.clone().cross(tieA).normalize();
  const tie: THREE.Vector3[] = [];
  for (let i = 0; i <= 20; i++) {
    const angle = 2 * Math.PI * i / 20;
    tie.push(toW(head.place([
      hair.bend[0] + 0.115 * (tieA.x * Math.cos(angle) + tieB.x * Math.sin(angle)),
      hair.bend[1] + 0.115 * (tieA.y * Math.cos(angle) + tieB.y * Math.sin(angle)),
      hair.bend[2] + 0.115 * (tieA.z * Math.cos(angle) + tieB.z * Math.sin(angle)),
    ])));
  }
  marks.push({ points: tie, pen: 'gel-rose', rank: 0, id: 'hair-tie' });

  // The wrapped visor (take C's): a band of the head's own surface across the eyes, its rows level in the head's frame
  // (close enough to fuse on the sheet once foreshortened), a fluoro-pink upper rim, a metallic-pink lower edge, and the
  // band closed at each temple. What it covers on the sheet is the band's own triangles' coverage.
  const wrap = wrapped(ctx);
  const bandMid = head.at.eyes[0] ? own(head.at.eyes[0])[1] - num(ctx, 'eyeInBar') * num(ctx, 'barMm') / headMm : 0.05;
  const bandHalf = num(ctx, 'barMm') / (2 * headMm), bandLo = bandMid - bandHalf, bandHi = bandMid + bandHalf;
  const onHeadNotNeck = (p: V3) => bare.parts.head(...own(p)) <= bare.parts.neck(...p) || isHair(p);
  const inBand = (p: V3) => { const q = own(p); return q[2] > 0.0 && q[1] >= bandLo && q[1] <= bandHi && onHeadNotNeck(p); };
  let onBand: (p: Point) => boolean = () => false;
  if (wrap) {
    const bandGeo = subMesh(mesh, inBand);
    onBand = meshCoverage([bandGeo], view, PAGE, 0.3);
    bandGeo.dispose();
    const level = perVertex(mesh, p => own(p)[1]), front = perVertex(mesh, p => own(p)[2]);
    const arc = (sp: SurfacePoint) => own(sp.p)[2] > 0.0 && onHeadNotNeck(sp.p);
    // The fill, in the band's own surface frame: y up the head, s round it (arc length, head units).
    const sp = num(ctx, 'fillMm') / headMm, per = num(ctx, 'fillPeriodMm') / headMm, fill = fillOf(ctx);
    const inside = (spt: SurfacePoint) => arc(spt) && own(spt.p)[1] >= bandLo && own(spt.p)[1] <= bandHi;
    const sOf = (q: V3) => Math.atan2(q[0], q[2]) * 0.32;
    const tri = (x: number) => 2 * Math.abs(x - Math.floor(x + 0.5));
    const fields: [(q: V3) => number, number][] = fill === 'chevron' ? [[q => q[1] + per * 0.3 * tri(sOf(q) / per), sp]]
      : fill === 'diamond' ? [[q => q[1] + sOf(q), sp * 1.6], [q => q[1] - sOf(q), sp * 1.6]]
        : fill === 'contour' ? [[q => Math.min(q[1] - bandLo, bandHi - q[1], q[2] * 0.6), sp]]
          : [[q => q[1], sp]];
    for (const [field, spacing] of fields) keepRuns(isoLines(mesh, perVertex(mesh, p => field(own(p))), spacing, fill === 'contour' ? 0 : bandLo), inside, false, 'fluoro-pink', 0, 'visor-row');
    keepRuns(isoLines(mesh, level, 1, 0, [bandHi]), arc, false, 'fluoro-pink', 0, 'visor-rim');
    keepRuns(isoLines(mesh, level, 1, 0, [bandLo]), arc, false, 'gel-rose', 0, 'visor-edge');
    keepRuns(isoLines(mesh, front, 1, 0, [0.0]), sp => { const y = own(sp.p)[1]; return y >= bandLo && y <= bandHi && onHeadNotNeck(sp.p); }, false, 'fluoro-pink', 0, 'visor-temple');
  }
  const bias = hiddenBias(view, 0.012 * S, view.position.distanceTo(target)), seen: Seen[] = [], visor: Seen[] = [];
  projectStrokes(marks, { view, depth, width: W, height: H, bias }, {
    begin: (mark: Mark) => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const piece of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
        if (pathLength(piece) >= 0.6) (mark.id.startsWith('visor') ? visor : seen).push({ pen: mark.pen, rank: mark.rank, id: mark.id, piece });
      }
    },
  });
  geo.dispose();
  return { seen, onHead, onNose, at, face, head, visor, onBand };
}

function meshOf(mesh: SculptMesh, keep: (p: V3) => boolean): SculptMesh {
  const tri: number[] = [];
  for (let t = 0; t < mesh.tri.length; t += 3) {
    const a = mesh.tri[t], b = mesh.tri[t + 1], c = mesh.tri[t + 2];
    const point = (v: number): V3 => [mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]];
    if (keep(point(a)) || keep(point(b)) || keep(point(c))) tri.push(a, b, c);
  }
  return { ...mesh, tri: Uint32Array.from(tri) };
}

function subMesh(mesh: SculptMesh, keep: (p: V3) => boolean): THREE.BufferGeometry {
  const ok = new Uint8Array(mesh.pos.length / 3);
  for (let v = 0; v < ok.length; v++) ok[v] = keep([mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]]) ? 1 : 0;
  const tri: number[] = [];
  for (let t = 0; t < mesh.tri.length; t += 3) if (ok[mesh.tri[t]] && ok[mesh.tri[t + 1]] && ok[mesh.tri[t + 2]]) {
    tri.push(mesh.tri[t], mesh.tri[t + 1], mesh.tri[t + 2]);
  }
  return sculptGeometry({ ...mesh, tri: Uint32Array.from(tri) });
}

export function erasure(ctx: SketchContext, stage?: HeadStage, options: { preview?: boolean } = {}): Erasure {
  const { seen, onHead, onNose, at, face, head, visor, onBand } = stage ?? headStage(ctx);
  const wrap = wrapped(ctx);
  const collarY = -num(ctx, 'collarAt'), collar: Point[] = [];
  for (let k = 0; k < 48; k++) {
    const a = 2 * Math.PI * k / 48;
    collar.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)]));
  }
  const left = collar.reduce((a, b) => b.x < a.x ? b : a), right = collar.reduce((a, b) => b.x > a.x ? b : a);
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(ring => insideRing(ring, p));
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), neck: { left, right } };

  // This frame is shared by the bar, its horizontal slices, and every inverse-shifted knife test.
  const assembled = ctx.params.view !== 'head', barH = num(ctx, 'barMm'), eyes = page.eyes;
  const eyeLine = Math.atan2(eyes[1].y - eyes[0].y, eyes[1].x - eyes[0].x);
  const tilt = (Math.abs(eyeLine) > Math.PI / 2 ? eyeLine - Math.sign(eyeLine) * Math.PI : eyeLine) + deg(num(ctx, 'barTilt'));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, normal = { x: -dir.y, y: dir.x };
  const eyeMid = { x: (eyes[0].x + eyes[1].x) / 2, y: (eyes[0].y + eyes[1].y) / 2 };
  const centre = {
    x: eyeMid.x + normal.x * num(ctx, 'eyeInBar') * barH,
    y: eyeMid.y + normal.y * num(ctx, 'eyeInBar') * barH,
  };
  const toPage = (u: number, v: number): Point => ({
    x: centre.x + dir.x * u - normal.x * (barH / 2 + v),
    y: centre.y + dir.y * u - normal.y * (barH / 2 + v),
  });
  const toBar = (p: Point) => ({
    u: (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y,
    v: -((p.x - centre.x) * normal.x + (p.y - centre.y) * normal.y) - barH / 2,
  });
  const faceDir = Math.sign(toBar(page.noseTip).u - toBar(eyeMid).u) || 1;
  let uBack = 0;
  while (uBack * -faceDir < 600) {
    const a = toPage(uBack, 0), b = toPage(uBack, -barH);
    if ([a, b].every(p => p.x < TRIM.x0 - 4 || p.x > TRIM.x1 + 4 || p.y < TRIM.y0 - 4 || p.y > TRIM.y1 + 4)) break;
    uBack -= faceDir;
  }
  // Shift runout keeps the bar solid at a page edge after a displaced slice arrives there.
  uBack -= faceDir * (num(ctx, 'shiftMm') + 18);
  const uFace = toBar(page.noseTip).u + faceDir * num(ctx, 'barPast');
  const visorRows: Point[][] = [];
  if (assembled && !wrap) {
    const bar = [toPage(uBack, 0), toPage(uFace, 0), toPage(uFace, -barH), toPage(uBack, -barH)];
    visorRows.push(...patternIn(bar, fillOf(ctx), num(ctx, 'fillMm'), num(ctx, 'fillPeriodMm'), Math.atan2(dir.y, dir.x)), [...bar, bar[0]]);
  }

  // The topology has fixed seeded draws per band; only mix reads phase, so phase moves offsets rather than reseeding.
  const phase = num(ctx, 'glitchPhase'), motion = num(ctx, 'glitchMotion'), scale = num(ctx, 'glitchScale');
  const noise = gradientNoise(ctx.random('ka-codex-a-noise'));
  const wave = (u: number, field: number) => 0.5 + 0.5 * noise(u / scale + 17.3 * field, phase * 0.35 + 5.1 * field);
  const mix = (seeded: number, u: number, field: number) => seeded + (wave(u, field) - seeded) * motion;
  const corners = [
    { x: ART.x0, y: ART.y0 }, { x: ART.x1, y: ART.y0 }, { x: ART.x1, y: ART.y1 }, { x: ART.x0, y: ART.y1 },
  ].map(toBar);
  const faceVs = [
    { x: face.x0, y: face.y0 }, { x: face.x1, y: face.y0 }, { x: face.x1, y: face.y1 }, { x: face.x0, y: face.y1 },
  ].map(toBar).map(p => p.v);
  const faceV0 = Math.min(...faceVs), faceV1 = Math.max(...faceVs);
  const vMin = Math.min(...corners.map(p => p.v)) - 2, vMax = Math.max(...corners.map(p => p.v)) + 2;
  const minH = num(ctx, 'sliceMinMm'), maxH = Math.max(minH, num(ctx, 'sliceMaxMm'));
  const reach = num(ctx, 'glitchReach'), shiftMm = num(ctx, 'shiftMm'), sliceRng = ctx.random('ka-codex-a-slices');
  const slices: Slice[] = [];
  for (let v = vMin, index = 0; v < vMax - 1e-6; index++) {
    // Fixed seeded draws preserve the slice topology across phase changes. The Cauchy-like tail keeps a sparse few
    // narrow shifts alive at both sheet edges instead of confining the datamosh to a wound around the visor.
    const thicknessRoll = sliceRng(), activeRoll = sliceRng(), shiftRoll = sliceRng(), smearRoll = sliceRng(), fullRoll = sliceRng();
    const probe = Math.abs(v + minH / 2 + barH / 2), probeFalloff = 1 / (1 + (probe / reach) ** 2);
    const thickness = minH + (maxH - minH) * thicknessRoll * (0.22 + 0.78 * probeFalloff);
    const v1 = Math.min(vMax, v + thickness), middle = (v + v1) / 2;
    const d = Math.abs(middle + barH / 2), falloff = 1 / (1 + (d / reach) ** 2);
    const faceSlice = v < faceV1 && v1 > faceV0;
    const signed = mix(shiftRoll, middle, 17) * 2 - 1;
    const rawDu = signed * (0.65 + 0.35 * Math.abs(signed)) * shiftMm * (0.45 + 0.55 * falloff);
    const rareFull = !faceSlice && v1 - v < 4 && fullRoll < 0.16;
    const du = faceSlice ? Math.max(-7, Math.min(7, rawDu)) : rareFull ? rawDu : Math.max(-shiftMm * 0.7, Math.min(shiftMm * 0.7, rawDu));
    const active = assembled && activeRoll < num(ctx, 'sliceShare') * (0.25 + 0.75 * falloff);
    slices.push({ v0: v, v1, du: active ? du : 0, active, smear: active ? 2 * Math.abs(du) * smearRoll * num(ctx, 'smear') : 0 });
    v = v1;
  }
  // Where a moved slice slid away from, it leaves a gap at the figure's trailing edge: that gap is cut out of the black,
  // and the gold behind shows the drawing still where it was, in black ink (a ghost). Each slice draws its cut's
  // roll up front (one draw), cut slices keep 3 mm of paper between them and stay 6 mm inside the trim.
  if (assembled) {
    const crng = ctx.random('ka-riff-cuts');
    const inTrim = (p: Point) => p.x > TRIM.x0 + 6 && p.x < TRIM.x1 - 6 && p.y > TRIM.y0 + 6 && p.y < TRIM.y1 - 6;
    const inFigure = (p: Point) => onHead(p) || bySuit(p);
    let lastCut = -Infinity;
    for (const sl of slices) {
      const roll = crng();
      const h = sl.v1 - sl.v0, mid = (sl.v0 + sl.v1) / 2, d = Math.abs(mid + barH / 2), falloff = 1 / (1 + (d / reach) ** 2);
      if (!sl.active || h < 3 || Math.abs(sl.du) < 3 || sl.v0 - lastCut < 3 || roll > num(ctx, 'cutShare') * falloff) continue;
      // The figure's extent across the slice, where it was.
      let fa = Infinity, fb = -Infinity;
      for (let u = -300; u <= 300; u += 0.5) if (inFigure(toPage(u, mid))) { fa = Math.min(fa, u); fb = Math.max(fb, u); }
      if (!Number.isFinite(fa)) continue;
      // The gap is the slide, widened (its ghost reads only past a few millimetres).
      const gap = Math.max(8, Math.abs(sl.du) * 1.8);
      let [u0, u1] = sl.du > 0 ? [fa, fa + gap] : [fb - gap, fb];
      while (u1 - u0 > 4 && !(inTrim(toPage(u0, sl.v0)) && inTrim(toPage(u0, sl.v1)))) u0 += 0.5;
      while (u1 - u0 > 4 && !(inTrim(toPage(u1, sl.v0)) && inTrim(toPage(u1, sl.v1)))) u1 -= 0.5;
      if (u1 - u0 < 5) continue;
      sl.cut = { u0, u1 };
      lastCut = sl.v1;
    }
  }
  const sliceAt = (v: number): Slice => {
    let lo = 0, hi = slices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slices[mid].v0 <= v) lo = mid;
      else hi = mid - 1;
    }
    return slices[lo];
  };

  // The base openings remain cheap because a coarse page grid rejects almost every ring test before it happens.
  type Opening = { group: 1 | 2; holds: (p: Point) => boolean; ring: Point[] };
  const openings: Opening[] = [
    ...suit.shirt.map(ring => ({ group: 1 as const, ring, holds: (p: Point) => insideRing(ring, p) })),
    { group: 2, ring: suit.back, holds: (p: Point) => insideRing(suit.back, p) },
  ];
  const coarseSize = 4, gx = Math.ceil(PAGE.width / coarseSize) + 1, gy = Math.ceil(PAGE.height / coarseSize) + 1;
  const coarse: Opening[][] = Array.from({ length: gx * gy }, () => []);
  const clampG = (value: number, count: number) => Math.max(0, Math.min(count - 1, Math.floor(value / coarseSize)));
  for (const opening of openings) {
    const xs = opening.ring.map(p => p.x), ys = opening.ring.map(p => p.y);
    for (let y = clampG(Math.min(...ys), gy); y <= clampG(Math.max(...ys), gy); y++) {
      for (let x = clampG(Math.min(...xs), gx); x <= clampG(Math.max(...xs), gx); x++) coarse[y * gx + x].push(opening);
    }
  }
  const baseWindowAt = (p: Point) => {
    const here = coarse[clampG(p.y, gy) * gx + clampG(p.x, gx)];
    const inGroup = (group: number) => here.some(opening => opening.group === group && opening.holds(p));
    // (The blouse is not kept off the neck: the neck's column runs on down behind the suit.)
    return inGroup(1) || (inGroup(2) && !onHead(p));
  };
  // Output p gets read backward through its slice: this makes knife and black Micron hatching move as one object.
  const windowAt = (p: Point) => {
    const q = toBar(p), slice = sliceAt(q.v);
    if (slice.cut && q.u >= slice.cut.u0 && q.u <= slice.cut.u1 && !onNose(p)) return true;
    return baseWindowAt(toPage(q.u - slice.du, q.v));
  };
  const window = assembled ? traceMask(
    windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 },
    options.preview ? 0.5 : 0.25, { simplify: options.preview ? 0.15 : 0.08, minRadius: 1.2, minArea: 6 },
  ) : [];
  return {
    assembled, head: seen, onHead, onNose, toPage, toBar, barH, slices, visorRows, pocket: suit.pocket,
    pocketFill: assembled ? patternIn(suit.pocket, fillOf(ctx), num(ctx, 'fillMm'), num(ctx, 'fillPeriodMm'), Math.atan2(suit.pocket[6].y - suit.pocket[0].y, suit.pocket[6].x - suit.pocket[0].x)) : [], visor: wrap && assembled ? visor : [], onBand: wrap && assembled ? onBand : () => false, wrap, face,
    panels: suit.panels, suitLines: suit.lines, bySuit, window, page,
  };
}

/**
 * The suit, tailored: a sharp-shouldered jacket with peak lapels, single-breasted, buttoned low; a deep V shows the
 * blouse (a window onto the gold, Micron black on it); one breast pocket with a pink square in it, the visor's pattern.
 * Silver stripes on the black, gold piping; the lapels' stripes closer, as satin.
 */
function suitOf(left: Point, right: Point): {
  panels: Panel[]; lines: SuitLine[]; front: Point[][]; shirt: Point[][]; back: Point[]; pocket: Point[]
} {
  const centre = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, width = right.x - left.x;
  const slope = (right.y - left.y) / (right.x - left.x);
  const P = (u: number, v: number): Point => ({ x: centre.x + u * width, y: centre.y + v * width + u * width * slope });
  const bottom = TRIM.y1 + 10;
  const at = (u: number): Point => ({ x: P(u, 0).x, y: bottom });
  const button = P(0.02, 2.3);
  // Each side: the lapel (collar to peak to the button) and the jacket outside it.
  const side = (k: 1 | -1) => {
    const Q = (u: number, v: number) => P(k * u, v);
    const lapel = [Q(0.5, 0.0), Q(0.74, -0.06), Q(0.96, 0.42), Q(1.34, 0.28), Q(1.14, 0.64), Q(1.06, 1.02), button];
    const jacket = [Q(0.74, -0.06), Q(2.3, 0.36), Q(2.7, 0.62), at(k * 2.9), at(0), button, Q(1.06, 1.02), Q(1.14, 0.64), Q(1.34, 0.28), Q(0.96, 0.42)];
    return { lapel, jacket };
  };
  const L = side(-1), R = side(1);
  const blouse = [P(-0.52, -0.05), P(0.52, -0.07), button];
  const back = [P(-0.56, -0.08), P(-0.5, -0.3), P(0.5, -0.36), P(0.56, -0.12)];
  // The breast pocket on her left (the sheet's right): its welt, the square's points above it.
  const welt = [P(1.3, 1.42), P(2.0, 1.32)];
  const pocket = [welt[0], P(1.38, 1.12), P(1.52, 1.3), P(1.66, 1.02), P(1.8, 1.24), P(1.92, 1.06), welt[1]];
  const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
  const panels: Panel[] = [
    { id: 'jacket-l', ring: L.jacket, angle: angle(P(-2.7, 0.62), at(-2.9)), pitch: 2.4, pen: 'silver' },
    { id: 'jacket-r', ring: R.jacket, angle: angle(P(2.7, 0.62), at(2.9)), pitch: 2.4, pen: 'silver' },
    { id: 'lapel-l', ring: L.lapel, angle: angle(P(-1.06, 1.02), button), pitch: 1.4, pen: 'silver' },
    { id: 'lapel-r', ring: R.lapel, angle: angle(P(1.06, 1.02), button), pitch: 1.4, pen: 'silver' },
    { id: 'blouse', ring: blouse, angle: angle(P(0, 0), button), pitch: 2.0, pen: 'black', window: true },
    { id: 'collar-back', ring: back, angle: angle(P(-0.5, -0.3), P(0.5, -0.36)), pitch: 1.8, pen: 'black', window: true },
  ];
  const close = (ring: Point[]) => [...ring, ring[0]];
  const ring = (c: Point, r: number) => Array.from({ length: 17 }, (_, i) => ({ x: c.x + r * Math.cos(i * Math.PI / 8), y: c.y + r * Math.sin(i * Math.PI / 8) }));
  const lines: SuitLine[] = [
    ...[L.lapel, R.lapel, L.jacket, R.jacket].map(r => ({ pen: 'gold' as const, path: close(r) })),
    { pen: 'gold', path: welt }, { pen: 'gold', path: ring(button, width * 0.05) },
    { pen: 'gel-rose', path: close(pocket) },
  ];
  return { panels, lines, front: [blouse, L.lapel, R.lapel, L.jacket, R.jacket], shirt: [blouse], back, pocket };
}

export function panelStripes(panel: Panel, grow = 0, clip: Rect = ART): Point[][] {
  const paths = stripeFill(panel.ring, panel.angle, panel.pitch, grow);
  if (panel.cross !== undefined) paths.push(...stripeFill(panel.ring, panel.cross, panel.pitch * 1.6, grow));
  return paths.flatMap(path => clipToRect(path, clip))
    .flatMap(path => grow ? [path] : keepAlong(path, p => insideRing(panel.ring, p), 0.2));
}

function gradientNoise(rng: () => number): (x: number, y: number) => number {
  const permutation = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const p = [...permutation, ...permutation];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (hash: number, x: number, y: number) => {
    const a = (hash & 7) * Math.PI / 4;
    return Math.cos(a) * x + Math.sin(a) * y;
  };
  return (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255, xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = p[p[xi] + yi], ab = p[p[xi] + yi + 1], ba = p[p[xi + 1] + yi], bb = p[p[xi + 1] + yi + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.4;
  };
}
