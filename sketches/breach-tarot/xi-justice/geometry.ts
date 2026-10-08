import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, faceDarkness, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, strandPoint, strandStrokes, type HelixStroke } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * XI Justice: it all balances in the end. The set's one frontal card. A great balance stands on open
 * ground: a tall slab column, and on it a long level beam, the column well off the beam's middle so
 * one arm is long and one short. On the short arm's pan a heavy dark heap of blocks; on the long
 * arm's pan one small block. It is level because the pivot has been moved. The helix is the cord: a
 * double helix rising from the pivot toward the top of the card; at the beam it parts, one strand
 * running out along each arm and hanging, over the end, as that pan's chain. The sky is a light
 * ruling knocked out round all of it; the horizon runs open to both edges. The words are cut into
 * the blocks of the heap and the courses of the column.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
/** Hidden-line slack for slabs, in world units. */
const SLAB_SLACK = 0.3;
/** The helix is built this many times larger than it is drawn: the kit's wiggles are fixed in world units. */
const HELIX_SCALE = 4;
const GAP = 0.12;

export function justiceCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** Which side the short arm (and the heap) is on: -1 left of the column, +1 right. */
function shortSide(ctx: SketchContext): number {
  const p = ctx.params.side;
  if (p === 'left') return -1;
  if (p === 'right') return 1;
  return ctx.random('justice-side')() < 0.5 ? -1 : 1;
}

/** Everything the balance is placed by, in page millimetres, with the converters to world units. */
export interface Layout {
  D: number; U: number; f: number;
  /** +1 when mirrored from the default (short arm on the left). */
  mirror: number;
  /** Page x in mm of the pivot, the short chain, the long chain. */
  pivotX: number; shortX: number; longX: number;
  beamL: number; beamR: number; beamY: number; beamH: number;
  panTop: number; panThick: number;
  /** World x of a page x, world height of a page y at the balance's depth. */
  xOf: (mm: number) => number; hOf: (mm: number) => number;
}

export function layoutOf(ctx: SketchContext, view: THREE.PerspectiveCamera): Layout {
  const D = n(ctx, 'dist', 30, 24, 90);
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const U = D / f;
  const mirror = shortSide(ctx) < 0 ? 1 : -1;
  const flipX = (mm: number) => mirror > 0 ? mm : TABLOID_PAGE.width - mm;
  // The chains hang at spanL (the short arm's pan) and spanR (the long arm's); the pivot divides the span by `ratio`.
  const spanL = n(ctx, 'spanL', 64, 40, 100), spanR = n(ctx, 'spanR', 236, 200, 252);
  const ratio = n(ctx, 'ratio', 2.4, 1.6, 4);
  const pivot = spanL + (spanR - spanL) / (1 + ratio);
  const overhang = n(ctx, 'overhang', 10, 4, 20);
  const beamY = n(ctx, 'beamY', 124, 90, 170), beamH = n(ctx, 'beamH', 17, 8, 30);
  const drop = n(ctx, 'drop', 92, 50, 140);
  const panThick = n(ctx, 'panThick', 4.5, 2, 9);
  const xs = [spanL, pivot, spanR, spanL - overhang, spanR + overhang].map(flipX);
  return {
    D, U, f, mirror, pivotX: xs[1], shortX: xs[0], longX: xs[2],
    beamL: Math.min(xs[3], xs[4]), beamR: Math.max(xs[3], xs[4]), beamY, beamH,
    panTop: beamY + beamH / 2 + drop, panThick,
    xOf: mm => (mm - TABLOID_PAGE.width / 2) * U,
    hOf: mm => EYE - (mm - HORIZON_Y) * U,
  };
}

interface Piece { slab: Slab; group: 'column' | 'beam' | 'pile' | 'pans'; light: 'lit' | 'dark' }

/** The column: a stepped plinth, then slab courses narrowing a little toward the top, under the beam. */
function buildColumn(ctx: SketchContext, L: Layout): Piece[] {
  const rng = ctx.random('justice-column');
  const { U, D } = L;
  const colW = n(ctx, 'colW', 31, 20, 50) * U;
  const out: Piece[] = [];
  const cx = L.xOf(L.pivotX);
  const plinths = [[1.55, 11, 4.8], [1.22, 8, 4.1]];
  let y = 0;
  for (const [wf, hm, d] of plinths) {
    const h = hm * U;
    const sl = solid(cx, y + h / 2, -D, colW * wf, h - GAP, d, out.length, 'stack');
    sl.tone = 0.7;
    out.push({ slab: sl, group: 'column', light: 'lit' });
    y += h;
  }
  const top = L.hOf(L.beamY + L.beamH / 2) - GAP;
  const courses = Math.round(n(ctx, 'courses', 4, 3, 9));
  const weights = Array.from({ length: courses }, () => 0.8 + 0.5 * rng());
  const total = weights.reduce((a, b) => a + b, 0);
  const span = top - y;
  for (let i = 0; i < courses; i++) {
    const h = span * weights[i] / total;
    const t = i / Math.max(1, courses - 1);
    const w = colW * (1 - 0.12 * t) * (0.96 + 0.08 * rng());
    const d = 3.5 - 0.4 * t;
    const slip = (rng() - 0.5) * 0.5 * U * 4;
    const sl = solid(cx + slip, y + h / 2, -D, w, h - GAP, d, out.length, 'stack');
    sl.tone = 0.65 + 0.3 * rng();
    out.push({ slab: sl, group: 'column', light: 'lit' });
    y += h;
  }
  return out;
}

/** The heap on the short arm's pan: rows of blocks narrowing upward, offset like bond, the top one turned a little. */
function buildPile(ctx: SketchContext, L: Layout, cx: number, base: number): Piece[] {
  const rng = ctx.random('justice-pile');
  const { U, D } = L;
  const rows = Math.round(n(ctx, 'pileRows', 5, 3, 9));
  const pileW = n(ctx, 'pileW', 50, 30, 70) * U, pileH = n(ctx, 'pileH', 72, 30, 100) * U;
  const weights = Array.from({ length: rows }, (_, i) => 1.15 - 0.3 * i / (rows - 1));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const out: Piece[] = [];
  let y = base + GAP;
  let prevW = pileW * 1.1, prevC = cx;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const rowW = Math.min(prevW, pileW * (1 - 0.6 * t ** 1.3) * (0.9 + 0.2 * rng()));
    const rowH = (pileH - rows * GAP) * weights[i] / wsum;
    const count = clamp(Math.round(rowW / (n(ctx, 'blockW', 18, 10, 30) * U)), 1, 4);
    const share = Array.from({ length: count }, () => 0.5 + 1.0 * rng());
    const ssum = share.reduce((a, b) => a + b, 0);
    const avail = rowW - (count - 1) * 0.15;
    // The row sits over the one below it, shifted by up to its slack and a little more.
    const slack = Math.max(0, (prevW - rowW) / 2) + 1.2 * U;
    const c = clamp(prevC + (rng() - 0.5) * 2 * slack, cx - pileW * 0.18, cx + pileW * 0.18);
    let x = c - rowW / 2;
    let tallest = 0;
    for (let j = 0; j < count; j++) {
      const w = avail * share[j] / ssum;
      const h = rowH * (0.88 + 0.12 * rng());
      const d = 2.2 + 1.4 * rng();
      const sl = solid(x + w / 2, y + h / 2, -D + (rng() - 0.5) * 0.7, w, h, d, out.length, 'stack');
      sl.tone = 1.5 + 0.2 * rng();
      if (i === rows - 1) sl.ry = (rng() - 0.5) * 0.3;
      out.push({ slab: sl, group: 'pile', light: 'dark' });
      x += w + 0.15;
      tallest = Math.max(tallest, h);
    }
    y += tallest + GAP;
    prevW = rowW; prevC = c;
  }
  return out;
}

/** Everything solid in the picture. */
export interface Balance { pieces: Piece[]; pile: Piece[]; column: Piece[]; beam: Slab; shortPan: Slab; longPan: Slab; block: Slab; chainBack: number; chainFront: number }

export function buildBalance(ctx: SketchContext, L: Layout): Balance {
  const { U, D } = L;
  const column = buildColumn(ctx, L);
  const pieces: Piece[] = [...column];
  const beamD = 1.8;
  const beam = solid(L.xOf((L.beamL + L.beamR) / 2), L.hOf(L.beamY), -D, (L.beamR - L.beamL) * U, L.beamH * U, beamD, pieces.length, 'stack');
  beam.tone = 0.9;
  pieces.push({ slab: beam, group: 'beam', light: 'lit' });
  // The pans: broad thin plates under each load.
  const panY = L.hOf(L.panTop);
  const shortW = n(ctx, 'pileW', 50, 30, 70) + 4, longW = n(ctx, 'blockSize', 13, 8, 24) + 14;
  const mk = (xmm: number, wmm: number, d: number) => {
    const sl = solid(L.xOf(xmm), panY - L.panThick * U / 2, -D, wmm * U, L.panThick * U - GAP, d, pieces.length, 'stack');
    sl.tone = 1.2;
    return { slab: sl, group: 'pans' as const, light: 'dark' as const };
  };
  const shortPan = mk(L.shortX, shortW, 5.2), longPan = mk(L.longX, longW, 3.6);
  pieces.push(shortPan, longPan);
  const pile = buildPile(ctx, L, L.xOf(L.shortX), panY + GAP);
  pieces.push(...pile);
  // The single block: small, dark, turned a little so it shows a corner.
  const bs = n(ctx, 'blockSize', 13, 8, 24) * U;
  const blockSlab = solid(L.xOf(L.longX), panY + GAP + bs * 0.45, -D, bs, bs * 0.9, 2.6, pieces.length, 'stack');
  blockSlab.ry = 0.32; blockSlab.tone = 1.7;
  pieces.push({ slab: blockSlab, group: 'pile', light: 'dark' });
  const backs = pieces.filter(p => p.group !== 'column').map(p => p.slab.z - Math.max(p.slab.d, p.slab.w) / 2);
  return {
    pieces, pile, column, beam, shortPan: shortPan.slab, longPan: longPan.slab, block: blockSlab,
    chainFront: -D + beamD / 2 + n(ctx, 'cordStand', 0.8, 0.5, 1.6),
    chainBack: Math.min(...backs) - 0.9,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The cord                                                                                   */
/* ------------------------------------------------------------------------------------------ */

interface CordOptions {
  radius: number; pitch: number; flare: number; length: number;
}

/**
 * One strand of the kit's twin helix laid along its own curve, built `HELIX_SCALE` times the size and
 * brought back. `scaleAt` widens the strand's offset and ribbon with arc length (the double helix
 * opens as it rises); the shared part of the two strands' curves is the same line, so there the
 * strands interleave as the full double helix.
 */
function strandAlong(ctx: SketchContext, view: THREE.PerspectiveCamera, pts: THREE.Vector3[], index: 0 | 1, o: CordOptions, scaleAt: (s: number) => number) {
  const S = HELIX_SCALE;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const curve = new THREE.CatmullRomCurve3(pts.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const start = curve.getPointAt(0);
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const r = o.radius * S;
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.35 } });
  const st = {
    ...template[index], x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: r + r * 0.3 * index, depth: 1,
    width: r * 0.95 - r * 0.12 * index, swell: 0, centre: -1e3, turns: length / (o.pitch * S),
  };
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - start.y) / length, 0, 1);
    const k = Math.min(400, Math.round(u * 400));
    const sc = scaleAt(u * length / S);
    return curve.getPointAt(u).addScaledVector(frames.normals[k], (p.x - start.x) * sc).addScaledVector(frames.binormals[k], (p.z - start.z - 0.25) * sc);
  };
  const strokes: HelixStroke[] = strandStrokes(st, 0.5, 0.3, ctx, sv).map(h => ({ ...h, points: h.points.map(q => bend(q).multiplyScalar(1 / S)) }));
  const mesh = buildSurfaceMesh((u, v) => bend(strandPoint(st, u, 2 * v - 1)), {}, 320, 8).scale(1 / S, 1 / S, 1 / S);
  return { strokes, mesh, length: length / S };
}

/**
 * The two cords' routes, in world units. Both come down the same line from above the card to the
 * pivot, then part: each turns along the beam's face to its end, turns down again, and hangs as its
 * pan's chain, drifting back behind the load so it is hidden by it.
 */
function cordRoutes(ctx: SketchContext, L: Layout, bal: Balance): { routes: { pts: THREE.Vector3[]; chainFrom: number }[]; rise: number } {
  const by = L.beamY;
  const lean = n(ctx, 'lean', 0, -60, 60) * -L.mirror;
  const R = n(ctx, 'corner', 11, 5, 20);
  const top = -30;
  // A page position at depth z: the world point that lands there (the chain drifts back behind the
  // load, so it must be placed by where it shows, not by where it is).
  const P = (xmm: number, ymm: number, z: number) => {
    const k = -z / L.f;
    return new THREE.Vector3((xmm - TABLOID_PAGE.width / 2) * k, EYE - (ymm - HORIZON_Y) * k, z);
  };
  const zf = bal.chainFront, zb = bal.chainBack;
  const px = L.pivotX;
  // The shared rise: down from above the page, leaning toward the middle of the card by `lean` at the top.
  const rise: THREE.Vector3[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const y = top + (by - R * 1.6 - top) * i / steps;
    const t = 1 - i / steps;
    rise.push(P(px + lean * t * t, y, zf));
  }
  rise.push(P(px, by - R, zf));
  const route = (target: number) => {
    const d = Math.sign(target - px);
    const pts = [...rise];
    for (const phi of [30, 60, 90]) {
      const a = phi * Math.PI / 180;
      pts.push(P(px + d * R - d * R * Math.cos(a), by - R + R * Math.sin(a), zf));
    }
    const a0 = px + d * R, a1 = target - d * R;
    for (let i = 1; i <= 3; i++) pts.push(P(a0 + (a1 - a0) * i / 4, by, zf));
    for (const phi of [30, 60, 90]) {
      const a = phi * Math.PI / 180;
      pts.push(P(a1 + d * R * Math.sin(a), by + R - R * Math.cos(a), zf));
    }
    const chainFrom = pts.length - 1;
    // Down the chain, drifting back behind the load.
    const bottom = L.panTop - 4;
    const run = bottom - (by + R);
    // The drift back is done in the first third, so the rest hangs on one straight line.
    for (let i = 1; i <= 10; i++) {
      const t = i / 10, u = clamp(t / 0.3, 0, 1), s = u * u * (3 - 2 * u);
      pts.push(P(target, by + R + run * t, zf + (zb - zf) * s));
    }
    return { pts, chainFrom };
  };
  return { routes: [route(L.shortX), route(L.longX)], rise: by - R - top };
}

/* ------------------------------------------------------------------------------------------ */
/* Calm hatch                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Clip the line o + s·dir to |u| ≤ a, |v| ≤ b in face coordinates. */
function clipRect(ox: number, oy: number, dx: number, dy: number, a: number, b: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [o, d, h] of [[ox, dx, a], [oy, dy, b]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(o) > h) return null; continue; }
    const t0 = (-h - o) / d, t1 = (h - o) / d;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

interface HatchSpec {
  /** Closest two hatch lines may sit on the sheet, mm. */
  minMM: number;
  /** Line angle in the face, radians. */
  angle: number;
  /** How much the light moves the density across a face (0 = even). */
  gradient: number;
  /** Added to the face's darkness before the density is chosen. */
  bias: number;
  /** A crossing family on the darkest ground. */
  cross: boolean;
}

/**
 * Plain, light-driven hatch for the faces of a slab that see the eye: parallel lines at the finest
 * pitch, of which a nested power-of-two share is kept where the face is lighter, so the density
 * follows the light across the face with no rings and no steps. Returns world-space polylines.
 */
function faceHatch(sl: Slab, light: THREE.Vector3, eye: THREE.Vector3, mm: number, o: HatchSpec): THREE.Vector3[][] {
  const out: THREE.Vector3[][] = [];
  const m = slabMatrix(sl);
  const rot = new THREE.Matrix4().extractRotation(m);
  const hx = sl.w / 2, hy = sl.h / 2, hz = sl.d / 2;
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0, 0, hz), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, 0, hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz)],
    [new THREE.Vector3(0, -hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, hz)],
  ];
  for (const [c0, U0, V0] of faces) {
    const normal = c0.clone().normalize().applyMatrix4(rot);
    const centre = c0.clone().applyMatrix4(m).addScaledVector(normal, 0.006);
    if (eye.clone().sub(centre).dot(normal) <= 0) continue;
    const a = U0.length(), b = V0.length();
    const margin = 0.16;
    const ia = a - margin, ib = b - margin;
    if (ia < 0.05 || ib < 0.05) continue;
    const U = U0.clone().normalize().applyMatrix4(rot), V = V0.clone().normalize().applyMatrix4(rot);
    const d = faceDarkness(normal, light, sl.tone);
    const lu = light.dot(U), lv = light.dot(V), ll = Math.hypot(lu, lv) || 1;
    const at = (u: number, v: number) => centre.clone().addScaledVector(U, u).addScaledVector(V, v);
    const families: [number, number, boolean][] = [[o.angle, o.minMM, false]];
    if (o.cross) families.push([o.angle - 1.55, o.minMM * 1.5, true]);
    for (const [angle, pitch, crossing] of families) {
      const step = pitch / mm;
      const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
      const reach = Math.hypot(ia, ib);
      for (let k = -Math.ceil(reach / step); k * step < reach; k++) {
        const off = k * step;
        const span = clipRect(nx * off, ny * off, dx, dy, ia, ib);
        if (!span) continue;
        const len = span[1] - span[0];
        const segs = Math.max(1, Math.ceil(len * mm / 2));
        let run: THREE.Vector3[] = [];
        const flush = () => { if (run.length > 1) out.push(run); run = []; };
        for (let q = 0; q < segs; q++) {
          const t0 = span[0] + len * q / segs, t1 = span[0] + len * (q + 1) / segs;
          const tm = (t0 + t1) / 2;
          const u = nx * off + dx * tm, v = ny * off + dy * tm;
          const shade = -(lu * u / a + lv * v / b) / ll;
          const dl = clamp(d + o.gradient * shade * 0.5 + o.bias, 0, 1);
          const share = dl > 0.82 ? 1 : dl > 0.62 ? 2 : dl > 0.45 ? 4 : dl > 0.3 ? 8 : 0;
          const keep = share > 0 && (!crossing || dl > 0.88) && ((k % share) + share) % share === 0;
          if (keep) {
            if (!run.length) run.push(at(nx * off + dx * t0, ny * off + dy * t0));
            run.push(at(nx * off + dx * t1, ny * off + dy * t1));
          } else flush();
        }
        flush();
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* The shadow                                                                                 */
/* ------------------------------------------------------------------------------------------ */

type P2 = { x: number; z: number };

/** The same view with the near and far planes opened out, for marks that must not be clipped by the fitted range. */
function wideOf(view: THREE.PerspectiveCamera): THREE.PerspectiveCamera {
  const wide = view.clone();
  wide.near = 1; wide.far = 2000;
  wide.updateProjectionMatrix(); wide.updateMatrixWorld(true);
  return wide;
}

/** Convex hull of ground points (Andrew's monotone chain). */
function hull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: P2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: P2[] = [];
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The ground shadows, as flat polygons (x, z) on y = 0. */
interface Shadow { polygons: P2[][] }

/**
 * The shadow of the balance on the ground, light from high behind it so the shadow falls toward the
 * eye, and then not the truth: the beam's shadow is tipped about its pivot by `tilt` degrees on the
 * sheet, the short arm's end (the heap) down, and the pans and their loads hang from its ends.
 */
function castShadow(ctx: SketchContext, view: THREE.PerspectiveCamera, L: Layout, bal: Balance): Shadow {
  const lz = n(ctx, 'reach', 0.4, 0.1, 0.8);
  const hBeam = L.hOf(L.beamY);
  const kS = (L.D - lz * hBeam) / L.f;
  const wide = wideOf(view);
  const onPage = (v: P2) => pageOf(wide, new THREE.Vector3(v.x, 0, v.z));
  const target = n(ctx, 'tilt', 11, 0, 25) * Math.PI / 180;
  const userShift = n(ctx, 'shadowShift', 0, -40, 40);
  const cast = (sl: Slab, flat: (v: THREE.Vector3) => P2): P2[] => {
    const m = slabMatrix(sl);
    const pts: P2[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(flat(new THREE.Vector3(sx * sl.w / 2, sy * sl.h / 2, sz * sl.d / 2).applyMatrix4(m)));
    return hull(pts);
  };
  /** The shadow for a sideways lean of the light that moves it `shift` mm along the sheet. */
  const build = (shift: number): Shadow => {
    const lx = (shift * kS - L.xOf((L.beamL + L.beamR) / 2)) / hBeam;
    const flat = (v: THREE.Vector3): P2 => ({ x: v.x + lx * v.y, z: v.z + lz * v.y });
    const p0 = flat(new THREE.Vector3(L.xOf(L.pivotX), hBeam, -L.D));
    const endOf = (xmm: number) => flat(new THREE.Vector3(L.xOf(xmm), hBeam, -L.D));
    const eS = endOf(L.shortX), eL = endOf(L.longX);
    // Angle about the pivot that tips the short end down by `tilt` degrees on the sheet.
    const sign = -Math.sign(eS.x - p0.x || 1);
    const turn = (v: P2, phi: number): P2 => {
      const dx = v.x - p0.x, dz = v.z - p0.z;
      return { x: p0.x + dx * Math.cos(phi) + dz * Math.sin(phi), z: p0.z - dx * Math.sin(phi) + dz * Math.cos(phi) };
    };
    const tiltAt = (phi0: number) => {
      const a = onPage(turn(eS, sign * phi0)), b = onPage(turn(eL, sign * phi0));
      return Math.atan2(a.y - b.y, Math.abs(b.x - a.x));
    };
    let lo = 0, hi = 1.4;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (tiltAt(mid) < target) lo = mid; else hi = mid; }
    const phi = sign * (lo + hi) / 2;
    const move = (poly: P2[], from: P2): P2[] => {
      const to = turn(from, phi);
      return poly.map(v => ({ x: v.x + to.x - from.x, z: v.z + to.z - from.z }));
    };
    const polygons: P2[][] = [];
    // The column and its plinth stand true; the beam turns about the pivot; the pans and their loads
    // hang plumb from the ends of the turned beam.
    polygons.push(hull(bal.column.flatMap(pc => cast(pc.slab, flat))));
    polygons.push(cast(bal.beam, flat).map(v => turn(v, phi)));
    for (const sl of [bal.shortPan, ...bal.pile.map(pc => pc.slab)]) polygons.push(move(cast(sl, flat), eS));
    for (const sl of [bal.longPan, bal.block]) polygons.push(move(cast(sl, flat), eL));
    return { polygons };
  };
  // Centre the shadow's spread on the card, then add the control's shift.
  let shift = 0;
  for (let i = 0; i < 4; i++) {
    const xs = build(shift).polygons.flatMap(poly => poly.map(v => onPage(v).x));
    shift += (CARD.x0 + CARD.x1) / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  return build(shift + userShift);
}

export function drawJustice(ctx: SketchContext): Part[] {
  const view = justiceCamera(ctx);
  const eye = view.position.clone();
  const L = layoutOf(ctx, view);
  const mmPerUnit = (p: THREE.Vector3) => L.f / Math.max(1, eye.z - p.z);
  const bal = buildBalance(ctx, L);
  const light = new THREE.Vector3(0.5, 0.5, 0.55).normalize();
  const backlight = new THREE.Vector3(-0.25, 0.55, -0.8).normalize();

  const strokes: Stroke[] = [];
  const pitch = n(ctx, 'hatch', 0.7, 0.5, 2);
  for (const pc of bal.pieces) {
    const sl = pc.slab, at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const mm = mmPerUnit(at);
    const lamp = pc.light === 'dark' ? backlight : light;
    for (const st of facetStrokes(sl, lamp, eye, true)) strokes.push({ ink: 'carbon', group: pc.group, family: st.family, points: st.points });
    const spec: HatchSpec = pc.light === 'dark'
      ? { minMM: pitch, angle: 0.62, gradient: 0.2, bias: 0, cross: pc.group === 'pile' }
      : { minMM: pitch, angle: 0.62, gradient: n(ctx, 'gradient', 1.1, 0, 2), bias: 0.12, cross: false };
    for (const pts of faceHatch(sl, lamp, eye, mm, spec)) strokes.push({ ink: 'carbon', group: pc.group, family: 'hatch', points: pts });
  }

  // The cord: the shared rise is one curve, the strands part at the beam.
  const { routes, rise } = cordRoutes(ctx, L, bal);
  const flare = n(ctx, 'flare', 3, 1, 4);
  const opts: CordOptions = { radius: n(ctx, 'cord', 0.28, 0.1, 0.5), pitch: n(ctx, 'cordPitch', 3.2, 1.5, 8), flare, length: rise };
  const riseLen = rise * L.U;
  const chainScale = n(ctx, 'chainScale', 0.06, 0.03, 1.2);
  const cords = routes.map(({ pts, chainFrom }, i) => {
    // Arc length to where the chain starts, to narrow the strand there.
    let upTo = 0;
    for (let k = 1; k <= chainFrom; k++) upTo += pts[k].distanceTo(pts[k - 1]);
    const scaleAt = (s: number) => {
      const wide = 1 + (flare - 1) * (1 - Math.min(1, s / Math.max(1e-6, riseLen))) ** 1.6;
      return wide * (1 + (chainScale - 1) * clamp((s - upTo + 0.6) / 1.4, 0, 1));
    };
    return strandAlong(ctx, view, pts, i as 0 | 1, opts, scaleAt);
  });
  for (const c of cords) for (const h of c.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const slabGeos = bal.pieces.map(p => slabGeometry(p.slab));
  const geometries = [...slabGeos, ...cords.map(c => c.mesh)];
  try {
    fitDepthRange(view, geometries);
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    const nearP = view.near, farP = view.far;
    const bias = Math.max(3e-5, SLAB_SLACK * nearP * farP / ((farP - nearP) * L.D * L.D));
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));
    const cordClear = meshCoverage(cords.map(c => c.mesh), view, TABLOID_PAGE, n(ctx, 'cordHalo', 3, 1, 8));

    // The phrase: each word cut into the front of a block of the heap or a course of the column.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('justice-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H, bias }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    // The heap and the column take the words in reading order, whichever stands further left; down
    // each structure the words step lower, each in its own zone of height and never beside another.
    const heapLeft = L.shortX < L.pivotX;
    const nHeap = Math.ceil(words.length / 2);
    const inHeapAt = (i: number) => heapLeft ? i < nHeap : i >= words.length - nHeap;
    const spots = (list: Piece[]) => list.filter(p => p.slab.w * mmPerUnit(new THREE.Vector3(p.slab.x, p.slab.y, p.slab.z)) > 5);
    const heap = spots(bal.pile.filter(p => p.slab.d > 2));
    const colm = spots(bal.column.slice(2));
    const used = new Set<Slab>();
    const placed: Point[] = [];
    const counts = new Map<boolean, number>();
    const widest = words.map((w, i) => ({ w, i })).sort((a, b) => measureStrokeText(b.w, style) - measureStrokeText(a.w, style));
    widest.forEach(({ w: word, i }) => {
      const inHeap = inHeapAt(i);
      if (!counts.has(inHeap)) counts.set(inHeap, words.filter((_, j) => inHeapAt(j) === inHeap).length);
      const k = words.slice(0, i).filter((_, j) => inHeapAt(j) === inHeap).length, c = counts.get(inHeap)!;
      const list = inHeap ? heap : colm;
      const ys = list.map(p => p.slab.y);
      const lo = Math.min(...ys), hi = Math.max(...ys);
      const target = hi - (hi - lo) * (k + 0.5) / c;
      const wmm = measureStrokeText(word, style);
      const options = list.filter(p => !used.has(p.slab)).map(p => ({ p, key: Math.abs(p.slab.y - target) + 0.3 * wrng() }))
        .sort((a, b) => a.key - b.key).map(x => x.p);
      for (const { slab: sl } of options) {
        const m = slabMatrix(sl), at = new THREE.Vector3(sl.x, sl.y, sl.z);
        const mm = mmPerUnit(at), unit = 1 / mm;
        const ww = wmm * unit, hh = style.height * unit;
        if (ww > sl.w - 3.4 * unit || hh > sl.h * 0.7) continue;
        const here = pageOf(view, at);
        if (placed.some(q => Math.hypot(q.x - here.x, q.y - here.y) < 18)) continue;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 3.4 * unit) * 0.8, y0 = hh / 2 + (wrng() - 0.5) * (sl.h - hh) * 0.4;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3)) continue;
        textStrokes.push(...word3);
        used.add(sl);
        placed.push(here);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.8);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15)) buckets.add(key, piece);
    };
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H, bias }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });

    // The shadow: flat hatch on the ground, no outline, kept to the shadow's own shape and clear of what stands.
    const shadow = castShadow(ctx, view, L, bal);
    const wide = wideOf(view);
    const shadowGeos = shadow.polygons.map(poly => {
      const pos: number[] = [];
      for (let i = 1; i < poly.length - 1; i++) for (const q of [poly[0], poly[i], poly[i + 1]]) pos.push(q.x, 0, q.z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      return g;
    });
    try {
      const inShadow = meshCoverage(shadowGeos, wide, TABLOID_PAGE, 0, 4);
      const pageBox = { x0: CARD.x0, x1: CARD.x1, y0: HORIZON_Y + 2, y1: CARD.y1 };
      const ang = n(ctx, 'shadowAngle', 0, -60, 60) * Math.PI / 180, step = n(ctx, 'shadowPitch', 0.95, 0.5, 2);
      const cx = (pageBox.x0 + pageBox.x1) / 2, cy = (pageBox.y0 + pageBox.y1) / 2, reach = 400;
      const ux = Math.cos(ang), uy = Math.sin(ang);
      for (let o = -reach; o <= reach; o += step) {
        const mx = cx - uy * o, my = cy + ux * o;
        for (const run of clipToRect([{ x: mx - ux * reach, y: my - uy * reach }, { x: mx + ux * reach, y: my + uy * reach }], pageBox)) {
          add('shadow-carbon', run, p => inShadow(p) && !solids(p));
        }
      }
    } finally {
      for (const g of shadowGeos) g.dispose();
    }

    // The sky: a light ruling that thins and breaks as it comes down to the horizon, knocked out
    // round what stands in it and well clear of the cord.
    const reachSky = n(ctx, 'sky', 0.45, 0, 1);
    const pitch = n(ctx, 'skyPitch', 1.4, 0.8, 5);
    const pattern = barPattern(ctx.random('justice-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    if (reachSky > 0) for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += pitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
      const limit = [1, 0.72, 0.5, 0.28][tier];
      if (t > limit * reachSky) continue;
      const broken = t > 0.3 * limit * reachSky;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => {
        const step = Math.floor((p.x - CARD.x0) / 3.2 + i);
        return !solids(p) && !cordClear(p) && (!broken || pattern[step % 64]);
      });
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'shadow', 'column', 'beam', 'pans', 'pile', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('XI', 'JUSTICE'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
