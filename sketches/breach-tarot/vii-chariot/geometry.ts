import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, strandPoint, strandStrokes, type HelixStroke, type Strand } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n, smooth } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * VII The Chariot: the road is still being built. No figure: disruption at speed, will steering two
 * opposed forces, building the road while driving it. A road of thin paving slabs comes out of a
 * vanishing point on the horizon at one side, toward the eye along the ground, then lifts off: a
 * ramp of paving with no supports, climbing and curving into the sky toward the viewer, banking as
 * it rises so its surface turns to face us. It ends high on the far side of the card, its front edge
 * hanging over nothing. Beyond that edge the road it is meant to become is drawn only as dashed
 * outlines of slabs not yet laid. Slabs fly in on dashed arcs from both sides to extend it, dark and
 * hatched from one side, pale and outlined from the other (the two sphinxes); a couple have just
 * landed, askew. The road keeps the two lanes, one dark, one pale. The helix is the chariot: a taut
 * streak racing up the ramp just over the paving, its head at the front edge, its body trailing back
 * down to the horizon. Below, the ramp's long shadow lies across the open ground in flat hatch.
 */
const W = 1118, H = 1728;
const PW = TABLOID_PAGE.width;
const MM_X = PW / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** Depth bands: each gets its own bias, so a hidden-line slack is the same distance in the world near and far. */
const BAND_EDGES = [0, 18, 24, 30, 37, 45, 55, 68, 85, 110, 160, 240, 400, Infinity];
/** Hidden-line slack in world units: slabs are under half a unit thick, the helix a ribbon about a unit across. */
const SLAB_SLACK = 0.05, HELIX_SLACK = 0.15;
/**
 * A road row on the ground lies almost flat to the eye, so its own depth changes fast from pixel to
 * pixel (as the square of its distance): its slack grows with distance (negative means that), up to a
 * share of it far off.
 */
const ROAD_SLACK = -0.05;
const groundSlack = (share: number, dd: number) => Math.max(SLAB_SLACK, Math.min(share * dd, 0.0002 * dd * dd));
/** The helix's strand-space scale: the kit's wiggles are fixed in world units, so a thin smooth helix is built `S` times the size and brought back. */
const S = 40;
/** How late the helix thins along its length (the kit's flare): it keeps its width up the ramp and thins along the ground. */
const HELIX_FLARE = 1.2;
/** Depth at which the laid road on the ground ends; beyond it the road is two rules to the vanishing point. */
const T_FAR = 330;
/** Gap between slabs, world units. */
const GAP = 0.14;

const focal = (view: THREE.PerspectiveCamera) => TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
/** The world point at page position `p`, at depth `t` in front of the eye. */
const worldAt = (view: THREE.PerspectiveCamera, p: Point, t: number) =>
  new THREE.Vector3((p.x - PW / 2) * t / focal(view), view.position.y + (HORIZON_Y - p.y) * t / focal(view), -t);

export function chariotCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const eye = n(ctx, 'eye', 6, 3, 12);
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, eye, 0], target: [0, eye, -100], near: 2, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

export interface Frame3 { T: THREE.Vector3; N: THREE.Vector3; B: THREE.Vector3 }

/** The road's centreline (the underside of its slabs), by arc length `s` from its far end on the ground. */
export interface RoadPath {
  length: number;
  /** Where it leaves the ground, and where the laid road ends (the front edge). */
  sLift: number;
  sEnd: number;
  at: (s: number) => THREE.Vector3;
  /** Tangent (toward the front), surface normal (banked toward the eye as it climbs), and across (B = N × T). */
  frame: (s: number) => Frame3;
  depth: (s: number) => number;
  /** The road's far course on the ground, x at depth t, for the rules to the vanishing point. */
  groundX: (t: number) => number;
  groundK: () => number;
}

const cubic = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, u: number) => {
  const v = 1 - u;
  return a.clone().multiplyScalar(v * v * v).addScaledVector(b, 3 * v * v * u).addScaledVector(c, 3 * v * u * u).addScaledVector(d, u * u * u);
};

/**
 * The road's course: on the ground from far off (it vanishes at `vanishX` on the horizon) toward the
 * eye, swinging round into its lean at the lift-off; then a ramp (a cubic) climbing to the front edge,
 * placed by its page position and depth and leaving along `endHeading`/`endClimb`; then the road not
 * yet built, a cubic curling on through the sky.
 */
export function makePath(ctx: SketchContext, view: THREE.PerspectiveCamera): RoadPath {
  const f = focal(view), eyeY = view.position.y, eye = view.position.clone();
  const rng = ctx.random('chariot-path');
  const jig = (a: number) => (rng() - 0.5) * 2 * a;
  const kFar = (n(ctx, 'vanishX', 60, 18, 130) - PW / 2) / f;
  const liftP = { x: n(ctx, 'liftX', 100, 40, 200) + jig(8), y: n(ctx, 'liftY', 312, 262, 330) };
  const tL = eyeY * f / (liftP.y - HORIZON_Y);
  const xL = (liftP.x - PW / 2) * tL / f;
  const kL = n(ctx, 'liftLean', -1.6, -4, 0.5);
  const L = new THREE.Vector3(xL, 0, -tL), TL = new THREE.Vector3(-kL, 0, 1).normalize();
  // Beyond the laid road it runs straight to the vanishing point; between there and the lift-off, a cubic
  // that leaves the far end heading straight at us and swings round into the lift-off over `liftEase`.
  const xF = (n(ctx, 'vanishX', 60, 18, 130) - PW / 2) * T_FAR / f;
  const groundX = (t: number) => xF + kFar * (t - T_FAR);
  const groundK = () => kFar;
  const endP = { x: n(ctx, 'endX', 170, 110, 245) + jig(10), y: n(ctx, 'endY', 160, 80, 210) + jig(8) };
  const E = worldAt(view, endP, n(ctx, 'endT', 38, 22, 90));
  const dir = (heading: number, climb: number) => {
    const h = THREE.MathUtils.degToRad(heading), c = THREE.MathUtils.degToRad(climb);
    return new THREE.Vector3(Math.sin(h) * Math.cos(c), Math.sin(c), Math.cos(h) * Math.cos(c));
  };
  const TE = dir(n(ctx, 'endHeading', 45, -80, 100) + jig(12), n(ctx, 'endClimb', 40, 0, 70));
  const span = L.distanceTo(E);
  const sweep = n(ctx, 'rampSweep', 0.5, 0.1, 0.9);
  const C = worldAt(view, { x: n(ctx, 'contX', 110, 30, 330) + jig(20), y: n(ctx, 'contY', 40, -120, 200) + jig(10) }, n(ctx, 'contT', 60, 10, 120));
  // The road not yet built arrives at C along `contHeading`/`contClimb`.
  const TC = dir(n(ctx, 'contHeading', -130, -270, 270) + jig(15), n(ctx, 'contClimb', 10, -60, 80));
  const cspan = E.distanceTo(C);
  const c1 = E.clone().addScaledVector(TE, 0.3 * cspan), c2 = C.clone().addScaledVector(TC, -0.45 * cspan);

  const pts: THREE.Vector3[] = [];
  const F = new THREE.Vector3(xF, 0, -T_FAR), TF = new THREE.Vector3(-kFar, 0, 1).normalize();
  const g1 = F.clone().addScaledVector(TF, 0.55 * (T_FAR - tL)), g2 = L.clone().addScaledVector(TL, -n(ctx, 'liftEase', 20, 3, 80));
  // Sampled densely near the lift-off, where the depth is small and the turn is.
  for (let i = 0; i <= 200; i++) pts.push(cubic(F, g1, g2, L, 1 - (1 - i / 200) ** 2.5));
  const iLift = pts.length - 1;
  const b1 = L.clone().addScaledVector(TL, sweep * span), b2 = E.clone().addScaledVector(TE, -sweep * span);
  for (let i = 1; i <= 240; i++) pts.push(cubic(L, b1, b2, E, i / 240));
  const iEnd = pts.length - 1;
  for (let i = 1; i <= 160; i++) pts.push(cubic(E, c1, c2, C, i / 160));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = cum[cum.length - 1], sLift = cum[iLift], sEnd = cum[iEnd];
  const raw = (s: number): THREE.Vector3 => {
    const q = Math.max(0, Math.min(length, s));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
    const w = cum[hi] > cum[lo] ? (q - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return pts[lo].clone().lerp(pts[hi], w);
  };
  const bank = n(ctx, 'bank', 0.8, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const halfW = n(ctx, 'laneW', 2.6, 1.2, 5) + GAP / 2;
  const tangent = (s: number) => raw(s + 0.5).sub(raw(s - 0.5)).normalize();
  /** The fully banked surface normal: between straight up and the line of sight, square to the road. */
  const banked = (s: number, T: THREE.Vector3): THREE.Vector3 => {
    const ref = up.clone().multiplyScalar(1 - bank).addScaledVector(eye.clone().sub(raw(s)).normalize(), bank);
    return ref.addScaledVector(T, -ref.dot(T)).normalize();
  };
  // The normal carried along the road without twisting (a rotation-minimising frame): through the knee
  // the paving only pitches up, it does not roll.
  const DS = 0.05, cells = Math.ceil(length / DS);
  const carried: THREE.Vector3[] = [], turn: number[] = [];
  const rollTo = (N: THREE.Vector3, target: THREE.Vector3, T: THREE.Vector3) => Math.atan2(T.dot(new THREE.Vector3().crossVectors(N, target)), N.dot(target));
  for (let i = 0; i <= cells; i++) {
    const T = tangent(i * DS);
    if (!i) carried.push(up.clone().addScaledVector(T, -up.dot(T)).normalize());
    else {
      const q = new THREE.Quaternion().setFromUnitVectors(tangent((i - 1) * DS), T);
      const N = carried[i - 1].clone().applyQuaternion(q);
      carried.push(N.addScaledVector(T, -N.dot(T)).normalize());
    }
    // The roll from the carried normal to the banked one, unwrapped so it never jumps a full turn.
    let phi = rollTo(carried[i], banked(i * DS, T), T);
    if (i) while (phi - turn[i - 1] > Math.PI) phi -= 2 * Math.PI;
    if (i) while (phi - turn[i - 1] < -Math.PI) phi += 2 * Math.PI;
    turn.push(phi);
  }
  const lead = n(ctx, 'bankLead', 0, 0, 20), over = n(ctx, 'bankOver', 0.5, 0.05, 1);
  /**
   * The road's frame. On the ground it lies flat; through the knee it pitches up without rolling, and the
   * roll toward the eye is laid on evenly over the first `bankOver` of the ramp, so the turn from ground
   * to ramp is one sweep. Past that the paving is fully banked toward the eye, so it never passes the
   * eye's height edge on. Where the bank would tip the low edge into the ground, the road is lifted so
   * that edge just touches it: it peels up off the ground.
   */
  const frame = (s: number): Frame3 => {
    const T = tangent(s);
    const target = banked(s, T);
    const k = Math.max(0, Math.min(cells, Math.round(s / DS)));
    const w = smooth(sLift - lead, sLift + over * (sEnd - sLift), s);
    let N: THREE.Vector3;
    if (w >= 1) N = target;
    else {
      const C = carried[k].clone().addScaledVector(T, -carried[k].dot(T)).normalize();
      let phi = rollTo(C, target, T);
      while (phi - turn[k] > Math.PI) phi -= 2 * Math.PI;
      while (phi - turn[k] < -Math.PI) phi += 2 * Math.PI;
      N = C.applyAxisAngle(T, w * phi);
    }
    const B = new THREE.Vector3().crossVectors(N, T).normalize();
    return { T, N, B };
  };
  const at = (s: number): THREE.Vector3 => {
    const P = raw(s);
    return P.setY(P.y + Math.max(0, halfW * Math.abs(frame(s).B.y) - P.y));
  };
  return { length, sLift, sEnd, at, frame, depth: s => -at(s).z, groundX, groundK };
}

export type Side = 'dark' | 'pale';
/** A slab in flight is on a parabola from `from` to `to`, `h` high at its middle, and has come a share `u` of the way. */
export interface Flight { from: THREE.Vector3; to: THREE.Vector3; h: number; u: number }
export interface Piece { slab: Slab; side: Side; kind: 'road' | 'landed' | 'flying'; row: number; ramp: boolean; flight?: Flight; /** A short slab laid at the knee: takes no word. */ sub?: boolean }
const arcAt = (f: Flight, u: number): THREE.Vector3 => f.from.clone().lerp(f.to, u).add(new THREE.Vector3(0, f.h * 4 * u * (1 - u), 0));

/** A slab laid on the road's frame: `lat` across from the centreline, sitting on it. */
function frameSlab(P: THREE.Vector3, fr: Frame3, lat: number, w: number, h: number, d: number, beat: number): Slab {
  const c = P.clone().addScaledVector(fr.N, h / 2).addScaledVector(fr.B, lat);
  const s = solid(c.x, c.y, c.z, w, h, d, beat, 'stack');
  setRotation(s, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fr.B, fr.N, fr.T)));
  return s;
}
function setRotation(s: Slab, q: THREE.Quaternion): void {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  s.rx = e.x; s.ry = e.y; s.rz = e.z;
}
const quatOf = (s: Slab) => new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ'));

// Oriented boxes, for keeping separate things apart.
interface Obb { c: THREE.Vector3; a: THREE.Vector3[]; h: [number, number, number]; r: number }
function obbOf(s: Slab, grow = 0): Obb {
  const q = quatOf(s);
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

const corners = (sl: Slab): THREE.Vector3[] => {
  const m = slabMatrix(sl), out: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(new THREE.Vector3(sx * sl.w / 2, sy * sl.h / 2, sz * sl.d / 2).applyMatrix4(m));
  return out;
};
function pageBox(view: THREE.Camera, sl: Slab): Rect {
  const r: Rect = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const c of corners(sl)) {
    const q = pageOf(view, c);
    r.x0 = Math.min(r.x0, q.x); r.x1 = Math.max(r.x1, q.x); r.y0 = Math.min(r.y0, q.y); r.y1 = Math.max(r.y1, q.y);
  }
  return r;
}
const apart = (a: Rect, b: Rect, gap: number) => a.x1 + gap < b.x0 || b.x1 + gap < a.x0 || a.y1 + gap < b.y0 || b.y1 + gap < a.y0;

export interface Dims { laneW: number; thick: number; row: number }
export function dims(ctx: SketchContext): Dims {
  return { laneW: n(ctx, 'laneW', 2.6, 1.2, 5), thick: n(ctx, 'thick', 0.4, 0.15, 0.8), row: n(ctx, 'row', 1.6, 0.8, 4) };
}
/** The dark lane: on the +B side, so at the front edge it lies toward the dark slabs' side of the card. */
const DARK_LANE: 0 | 1 = 1;
const sideOfLane = (lane: 0 | 1): Side => lane === DARK_LANE ? 'dark' : 'pale';
const laneLat = (d: Dims, lane: 0 | 1) => (lane === 0 ? -1 : 1) * (d.laneW + GAP) / 2;

/** One cell of the road: the slab that sits (or will sit) between arc lengths s0 and s1 in a lane. */
function cellSlab(path: RoadPath, d: Dims, s0: number, s1: number, lane: 0 | 1, beat: number): Slab {
  const sm = (s0 + s1) / 2;
  return frameSlab(path.at(sm), path.frame(sm), laneLat(d, lane), d.laneW, d.thick, s1 - s0 - GAP, beat);
}

export interface Build {
  pieces: Piece[];
  /** The road not yet laid, as cells beyond the front edge. */
  cells: { s0: number; s1: number }[];
  /** The cells (and lanes) still empty: drawn as dashed outlines. */
  unbuilt: { ci: number; lane: 0 | 1 }[];
}

/** The laid road, from the front edge back to its far end on the ground, and the two slabs just landed beyond the edge. */
export function buildRoad(ctx: SketchContext, path: RoadPath, d: Dims): Build {
  const pieces: Piece[] = [];
  let beat = 0, row = 0;
  for (let s1 = path.sEnd; ; row++) {
    const len = s1 > path.sLift ? d.row : Math.max(d.row, 0.06 * path.depth(s1));
    const s0 = s1 - len;
    if (s0 < 0) break;
    const ramp = (s0 + s1) / 2 > path.sLift;
    // Where the road bends hard (the knee), a row is laid as several shorter slabs, so the bend is a sweep
    // and not one slab tipped up on its edge. Only the middle one of them takes a word.
    const a = path.frame(s0), b = path.frame(s1);
    const bend = Math.max(Math.acos(Math.min(1, a.T.dot(b.T))), Math.acos(Math.min(1, a.N.dot(b.N))));
    const parts = Math.max(1, Math.ceil(bend / THREE.MathUtils.degToRad(n(ctx, 'kneeTurn', 20, 5, 90))));
    for (let k = parts - 1; k >= 0; k--) {
      const t0 = s0 + (s1 - s0) * k / parts, t1 = s0 + (s1 - s0) * (k + 1) / parts;
      const sub = parts > 1 && k !== Math.floor(parts / 2);
      for (const lane of [0, 1] as const) pieces.push({ slab: cellSlab(path, d, t0, t1, lane, beat++), side: sideOfLane(lane), kind: 'road', row, ramp, sub });
    }
    s1 = s0;
  }
  const cells: { s0: number; s1: number }[] = [];
  const rows = Math.round(n(ctx, 'unbuiltRows', 6, 2, 12));
  for (let s0 = path.sEnd; s0 + d.row <= path.length && cells.length < rows; s0 += d.row) cells.push({ s0, s1: s0 + d.row });
  // Two just landed, a little askew, a cell or two past the edge, one from each side.
  const rng = ctx.random('chariot-landed');
  const askew = n(ctx, 'askew', 1, 0, 2);
  const first: 0 | 1 = rng() < 0.5 ? 0 : 1;
  const landed: [number, 0 | 1][] = [[0, first], [1, first === 0 ? 1 : 0]];
  const near = pieces.filter(p => p.row < 3).map(p => obbOf(p.slab, 0.05));
  for (const [ci, lane] of landed) {
    if (ci >= cells.length) continue;
    for (let attempt = 0; attempt < 40; attempt++) {
      const base = cellSlab(path, d, cells[ci].s0, cells[ci].s1, lane, beat);
      const fr = path.frame((cells[ci].s0 + cells[ci].s1) / 2);
      const grade = askew * (1 - attempt / 40);
      base.w *= 0.9; base.d *= 0.85;
      const yaw = (rng() < 0.5 ? -1 : 1) * (0.2 + 0.18 * rng()) * grade;
      const roll = (rng() - 0.5) * 0.3 * grade, pitch = (rng() - 0.5) * 0.25 * grade;
      setRotation(base, quatOf(base).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'XYZ'))));
      const shift = fr.N.clone().multiplyScalar((0.25 + 0.35 * rng()) * grade).addScaledVector(fr.T, (rng() - 0.3) * 0.4 * grade).addScaledVector(fr.B, (rng() - 0.5) * 0.4 * grade);
      base.x += shift.x; base.y += shift.y; base.z += shift.z;
      if (lane === DARK_LANE) base.tone = 1.5;
      const box = obbOf(base, 0.05);
      if (near.some(o => obbOverlap(box, o)) && attempt < 39) continue;
      near.push(box);
      pieces.push({ slab: base, side: sideOfLane(lane), kind: 'landed', row: -1 - ci, ramp: false });
      beat++;
      break;
    }
  }
  const unbuilt: { ci: number; lane: 0 | 1 }[] = [];
  for (let ci = 0; ci < cells.length; ci++) for (const lane of [0, 1] as const) {
    if (!landed.some(([lc, ll]) => lc === ci && ll === lane)) unbuilt.push({ ci, lane });
  }
  return { pieces, cells, unbuilt };
}

/**
 * In flight: dark slabs from the left, pale from the right, each on an arc from off the card's side
 * toward a cell a little past the edge. Each is tried at random and kept only where it lies in the
 * sky on the card, clear of the road, the helix and the others, with its arc showing behind it.
 */
function addFlyers(ctx: SketchContext, view: THREE.PerspectiveCamera, path: RoadPath, d: Dims, build: Build, blocked: (p: Point) => boolean): void {
  const fr = ctx.random('chariot-flight');
  const count = Math.round(n(ctx, 'flyers', 4, 2, 6));
  const tumble = n(ctx, 'tumble', 0.9, 0, 3), arc = n(ctx, 'arc', 5, 0, 20);
  const eye = view.position.clone();
  const { pieces, cells } = build;
  const taken = new Set(pieces.filter(p => p.kind === 'landed').map(p => p.row));
  const fixed = pieces.filter(p => p.kind !== 'road' || p.row < 4).map(p => obbOf(p.slab, 0.2));
  const flying: { box: Obb; page: Rect; at: Point }[] = [];
  type Cand = { sl: Slab; flight: Flight; pg: Rect; box: Obb; at: Point };
  const LOOSEN = [{ margin: 5, seen: 0.7, lap: 0 }, { margin: 3, seen: 0.5, lap: 0.2 }, { margin: 2, seen: 0.35, lap: 0.35 }];
  const candidates = (side: Side, level: number): Cand[] => {
    const lim = LOOSEN[level];
    const out: Cand[] = [];
    const lane: 0 | 1 = side === 'dark' ? DARK_LANE : DARK_LANE === 1 ? 0 : 1;
    for (let attempt = 0; attempt < 4000 && out.length < 50; attempt++) {
      const ci = 1 + Math.floor(fr() * Math.min(6, cells.length - 1));
      if (ci >= cells.length || taken.has(-1 - ci)) continue;
      const land = cellSlab(path, d, cells[ci].s0, cells[ci].s1, lane, 0);
      const Lp = new THREE.Vector3(land.x, land.y, land.z);
      const tl = -Lp.z;
      const fromPage = { x: side === 'dark' ? CARD.x0 + 15 - 50 * fr() : CARD.x1 - 15 + 50 * fr(), y: CARD.y0 + 30 + (HORIZON_Y - CARD.y0 - 90) * fr() };
      const from = worldAt(view, fromPage, tl * (0.8 + 1.4 * fr()));
      const h = arc * (0.3 + 0.9 * fr());
      const u = 0.35 + 0.5 * fr();
      const flight: Flight = { from, to: Lp, h, u };
      const p = arcAt(flight, u);
      const amp = tumble * (0.3 + 0.7 * (1 - u));
      const sl = solid(p.x, p.y, p.z, land.w, land.h, land.d, 0, 'debris');
      const axis = new THREE.Vector3(fr() - 0.5, fr() - 0.5, fr() - 0.5).normalize();
      setRotation(sl, quatOf(land).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, amp * (0.5 + 0.5 * fr()))));
      if (side === 'dark') sl.tone = 1.5;
      const pg = pageBox(view, sl);
      // In the sky, on the card, or running a little off its own side as it comes in.
      const lap = lim.lap * (pg.x1 - pg.x0);
      const offLeft = side === 'dark' ? lap : -4, offRight = side === 'pale' ? lap : -4;
      if (pg.x0 < CARD.x0 - offLeft || pg.x1 > CARD.x1 + offRight || pg.y0 < CARD.y0 + 5 || pg.y1 > HORIZON_Y - 3) continue;
      // Clear of the road, the helix and the landed slabs, with room round it.
      let hit = false;
      for (let y = pg.y0 - lim.margin; y <= pg.y1 + lim.margin && !hit; y += 1.5) for (let x = pg.x0 - lim.margin; x <= pg.x1 + lim.margin; x += 1.5) if (blocked({ x, y })) { hit = true; break; }
      if (hit) continue;
      // Its arc must show on the card behind it, sweeping in from the side.
      let seen = 0, total = 0;
      for (let w = Math.max(0, u - 0.5); w <= u - 0.06; w += 0.02) {
        const q = pageOf(view, arcAt(flight, w));
        total++;
        if (q.x > CARD.x0 && q.x < CARD.x1 && q.y > CARD.y0 && q.y < HORIZON_Y) seen++;
      }
      if (total < 4 || seen < lim.seen * total) continue;
      const a0 = pageOf(view, arcAt(flight, Math.max(0, u - 0.5))), a1 = pageOf(view, arcAt(flight, u - 0.05));
      // It must sweep in from the side, not hang from a string.
      if (Math.hypot(a1.x - a0.x, a1.y - a0.y) < 25 || Math.abs(a1.x - a0.x) < 0.6 * Math.abs(a1.y - a0.y)) continue;
      // Not seen edge-on: a slab in flight shows a face.
      const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(quatOf(sl));
      if (Math.abs(upv.dot(eye.clone().sub(p).normalize())) < 0.35) continue;
      const box = obbOf(sl, 0.2);
      if (fixed.some(o => obbOverlap(box, o))) continue;
      out.push({ sl, flight, pg, box, at: { x: (pg.x0 + pg.x1) / 2, y: (pg.y0 + pg.y1) / 2 } });
    }
    return out;
  };
  for (let j = 0; j < count; j++) {
    const side: Side = j % 2 === 0 ? 'dark' : 'pale';
    for (let level = 0; level < LOOSEN.length; level++) {
      let best: Cand | null = null, bestScore = -Infinity;
      for (const cd of candidates(side, level)) {
        if (!flying.every(o => apart(cd.pg, o.page, 6)) || flying.some(o => obbOverlap(cd.box, o.box))) continue;
        const sc = Math.min(...flying.map(o => Math.hypot(o.at.x - cd.at.x, o.at.y - cd.at.y)), 120) * (0.75 + 0.5 * fr());
        if (sc > bestScore) { bestScore = sc; best = cd; }
      }
      if (!best) continue;
      flying.push({ box: best.box, page: best.pg, at: best.at });
      pieces.push({ slab: best.sl, side, kind: 'flying', row: -20 - j, ramp: false, flight: best.flight });
      break;
    }
  }
}

/** Lines the length of a road slab's top, `count` across its width, so they run on from row to row as stripes down the lane. */
function laneHatch(sl: Slab, count: number): THREE.Vector3[][] {
  const m = slabMatrix(sl), y = sl.h / 2 + 0.006, a = sl.w / 2 - 0.08, b = sl.d / 2;
  const out: THREE.Vector3[][] = [];
  for (let q = 1; q < count; q++) {
    const x = -a + 2 * a * q / count;
    out.push([new THREE.Vector3(x, y, -b), new THREE.Vector3(x, y, b)].map(p => p.applyMatrix4(m)));
  }
  return out;
}

/** How wide a road slab's top is on the sheet, square to its stripes (which run its length). */
function laneWidthOnPage(view: THREE.Camera, sl: Slab): number {
  const m = slabMatrix(sl), y = sl.h / 2;
  const at = (x: number, z: number) => pageOf(view, new THREE.Vector3(x, y, z).applyMatrix4(m));
  const a = at(-sl.w / 2, 0), b = at(sl.w / 2, 0), f = at(0, -sl.d / 2), g = at(0, sl.d / 2);
  const dx = g.x - f.x, dy = g.y - f.y, len = Math.hypot(dx, dy) || 1;
  return Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / len;
}

/** What the helix needs from the road: its course from a ghost point past the head back to the tail, where the head falls on it, the line of sight square to the road there, and the road's normal along it. */
export interface Track { curve: THREE.CatmullRomCurve3; sHead: number; headN: THREE.Vector3; ramp: THREE.Vector3[]; normals: THREE.Vector3[]; flats: number[]; head: number; hold: number; lift: number }

/**
 * The streak's width along its run past the head, at share x of the way to the tail: `taper ** (x ** flare)`,
 * swollen by `bulge` over the first `head` of the run, so the head is the fullest part.
 */
const widthOf = (taper: number, flare: number, x: number, bulge = 0, head = 0.05) =>
  taper ** (Math.max(0, x) ** flare) * (1 + bulge * Math.exp(-((Math.max(0, x) / head) ** 2)));

/**
 * Where the helix goes: over the middle of the road, from its head at the front edge back down the
 * ramp and along the ground toward the horizon, high enough off the paving that its ribbons clear it,
 * and lower as it thins. The curve starts at a ghost point straight on past the head: the kit pinches
 * a strand's ends, so the first stretch of its run is laid out beyond the edge and cut off.
 */
export function helixTrack(ctx: SketchContext, path: RoadPath, d: Dims, eye: THREE.Vector3): Track {
  const radius = n(ctx, 'helixRadius', 1.1, 0.3, 3), taper = n(ctx, 'helixTaper', 0.12, 0.01, 1);
  const clear = n(ctx, 'helixLift', 0.3, 0.05, 2), reach = n(ctx, 'helixReach', 100, 80, 330);
  let sTail = path.sEnd;
  while (sTail > 0 && path.depth(sTail) < reach) sTail -= 0.5;
  const sHead = path.sEnd - 0.1 * d.row;
  const flat = n(ctx, 'helixFlat', 0.45, 0.15, 1), bulge = n(ctx, 'helixHead', 0.65, 0, 2);
  // The head's swelling runs over its first `helixHeadLength` world units.
  let lm = 0;
  for (let s = sHead; s > sTail; s -= 0.5) lm += path.at(s).distanceTo(path.at(s - 0.5));
  const head = n(ctx, 'helixHeadLength', 10, 2, 40) / lm, hold = n(ctx, 'helixHoldLength', 3, 1, 40) / lm;
  // Sampled every half unit, then eased (the head held fixed) so the streak takes the knee as one
  // smooth sweep instead of folding into the road's sharp bend and twist.
  const STEP = 0.5, steps = Math.max(2, Math.floor((sHead - sTail) / STEP));
  const raw: THREE.Vector3[] = [], rawN: THREE.Vector3[] = [], rawF: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const u = k / steps, s = sHead - (sHead - sTail) * u;
    const fr = path.frame(s), base = path.at(s);
    // Along the ground it is pressed flatter still, so it lies on the road instead of hovering over it.
    const f = flat * (1 - 0.6 * (1 - smooth(0, 2, base.y)));
    raw.push(base.addScaledVector(fr.N, d.thick + clear + 1.45 * f * radius * widthOf(taper, HELIX_FLARE, u, bulge, head)));
    rawN.push(fr.N);
    rawF.push(f);
  }
  const ease = (v: THREE.Vector3[]) => {
    const reachK = Math.round(n(ctx, 'helixEase', 8, 0, 15) / STEP);
    if (!reachK) return v;
    return v.map((p, k) => {
      const hold = smooth(0, 12, k * STEP);
      const acc = new THREE.Vector3();
      let wsum = 0;
      for (let j = -reachK; j <= reachK; j++) {
        const q = v[Math.max(0, Math.min(v.length - 1, k + j))], w = Math.exp(-((j / reachK) ** 2) * 2);
        acc.addScaledVector(q, w); wsum += w;
      }
      return p.clone().lerp(acc.multiplyScalar(1 / wsum), hold);
    });
  };
  const eased = ease(raw), easedN = ease(rawN).map(v => v.normalize());
  const main: THREE.Vector3[] = [], normals: THREE.Vector3[] = [], flats: number[] = [];
  for (let k = 0; k <= steps; k += 2) { main.push(eased[k]); normals.push(easedN[k]); flats.push(rawF[k]); }
  if (steps % 2) { main.push(eased[steps]); normals.push(easedN[steps]); flats.push(rawF[steps]); }
  lm = 0;
  for (let i = 1; i < main.length; i++) lm += main[i].distanceTo(main[i - 1]);
  // Turns past the head, as a share of the turns the same length would hold at the head's pitch.
  const lift = (sHead - path.sLift) / (sHead - sTail);
  const pitchAt = pitchOf(ctx, taper, bulge, head, hold, lift);
  let share = 0;
  for (let i = 0; i < 200; i++) share += 1 / (pitchAt((i + 0.5) / 200) * 200);
  const ghost = HEAD_CUT / (1 - HEAD_CUT) * lm * share * pitchAt(0);
  const out = main[0].clone().sub(main[1]).normalize();
  const lead = Array.from({ length: 6 }, (_, k) => main[0].clone().addScaledVector(out, ghost * (6 - k) / 6));
  const fr = path.frame(sHead);
  // At the head the strands are set round the line of sight (square to the road), so they stack into one full head.
  const look = eye.clone().sub(main[0]).normalize();
  const headDir = look.addScaledVector(fr.T, -look.dot(fr.T)).normalize();
  return { curve: new THREE.CatmullRomCurve3([...lead, ...main], false, 'centripetal'), sHead: ghost / (ghost + lm), headN: headDir, ramp: main, normals: [...lead.map(() => fr.N), ...normals], flats: [...lead.map(() => flats[0]), ...flats], head, hold, lift };
}
/**
 * The share of the strands' run laid out past the head and cut off (the kit pinches a strand's ends, and
 * lays its laminations in 16 bars, every third an open rest: the head starts on a full bar), and how the
 * pitch grows with the width.
 */
const HEAD_CUT = 6 / 16 + 0.004, HELIX_PITCH_GROWTH = 0.25;
/**
 * The pitch along the run, as a multiple of `helixPitch`, at share x of the way from the head to the
 * tail: it grows a little with the width, and is held long (`helixHold` times longer) over the first
 * `helixHoldLength` units below the head, so the head stays one full pair before the strands twist.
 * Past the lift-off (share `lift`) it stretches out again (up to `helixTailStretch` times longer), so the
 * tail along the ground trails off as two smooth strands, not a coil.
 */
const pitchOf = (ctx: SketchContext, taper: number, bulge: number, head: number, hold: number, lift: number) => (x: number) => {
  const xc = Math.max(0, x);
  return widthOf(taper, HELIX_FLARE, xc, bulge, head) ** HELIX_PITCH_GROWTH * (1 + n(ctx, 'helixHold', 3.5, 0, 6) * Math.exp(-((xc / hold) ** 2)))
    * (1 + n(ctx, 'helixTailStretch', 6, 0, 20) * smooth(lift, lift + 0.25 * (1 - lift), xc));
};

/**
 * The helix, built `S` times the size and brought back, so the kit's fixed wiggles do not bend a thin
 * smooth streak. Laid along the track as the kit's `helixAlong` lays it, but the strands are turned so
 * that at the head they stand off the paving at `helixStart` from its normal, and everything before
 * the head is cut away; over the last few millimetres to the head the ribbons round off.
 */
function chariotHelix(ctx: SketchContext, view: THREE.PerspectiveCamera, track: Track) {
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const curve = new THREE.CatmullRomCurve3(track.curve.points.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const r = n(ctx, 'helixRadius', 1.1, 0.3, 3) * S;
  const taper = n(ctx, 'helixTaper', 0.12, 0.01, 1);
  const pitch = n(ctx, 'helixPitch', 12, 8, 200) * S;
  const start = curve.getPointAt(0);
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: n(ctx, 'helixTwist', 0.2, 0, 1) } });
  const STEPS = 400;
  const sHead = track.sHead;
  const bulge = n(ctx, 'helixHead', 0.65, 0, 2);
  const widthAt = (s: number) => widthOf(taper, HELIX_FLARE, (s - sHead) / (1 - sHead), bulge, track.head);
  const turnsTo: number[] = [0];
  const pitchAt = pitchOf(ctx, taper, bulge, track.head, track.hold, track.lift);
  for (let i = 1; i <= STEPS; i++) turnsTo.push(turnsTo[i - 1] + 1 / (STEPS * pitchAt(((i - 0.5) / STEPS - sHead) / (1 - sHead))));
  const curveAt = (u: number): number => {
    const want = u * turnsTo[STEPS];
    let lo = 0, hi = STEPS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (turnsTo[mid] < want) lo = mid; else hi = mid; }
    const span = turnsTo[hi] - turnsTo[lo];
    return (lo + (span > 0 ? (want - turnsTo[lo]) / span : 0)) / STEPS;
  };
  const turns = length / pitch * turnsTo[STEPS];
  const kH = Math.round(sHead * STEPS);
  const uHead = (turnsTo[kH] + (turnsTo[Math.min(STEPS, kH + 1)] - turnsTo[kH]) * (sHead * STEPS - kH)) / turnsTo[STEPS];
  // The angle round the curve's frame at the head where the line of sight lies, plus the chosen offset.
  const sight = Math.atan2(track.headN.dot(frames.binormals[kH]), track.headN.dot(frames.normals[kH]));
  const phi = sight + THREE.MathUtils.degToRad(n(ctx, 'helixStart', 20, -180, 180));
  const firstRest = [0, 1, 2].map(k => Math.ceil(HEAD_CUT * 16) + k).find(b => b % 3 === 1)!;
  const strands: Strand[] = template.map((st, i) => ({
    ...st, hand: 1, theta0: phi - 2 * Math.PI * turns * uHead + i * Math.PI,
    x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: r + r * 0.3 * i, depth: 1, width: r * n(ctx, 'helixWidth', 0.65, 0.2, 2) * (1 - 0.12 * i),
    // The kit opens every third bar of laminations (a rest) except near its breach centre: the centre is set
    // on the first rest below the head, so the climb up the ramp stays solid; the rests lower down remain.
    swell: 0, centre: (firstRest + 0.5) / 16 * length, turns,
  }));
  // The road's normal along the curve (from the track point nearest each step), so the streak can be pressed flat toward the paving.
  const nearest = Array.from({ length: STEPS + 1 }, (_, k) => {
    const q = curve.getPointAt(k / STEPS);
    let best = 0, bd = Infinity;
    curve.points.forEach((cp, i) => { const dd = cp.distanceToSquared(q); if (dd < bd) { bd = dd; best = i; } });
    return best;
  });
  const roadN = nearest.map(i => track.normals[i]), flats = nearest.map(i => track.flats[i]);
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = Math.max(0, Math.min(1, (p.y - start.y) / length));
    const s = curveAt(u), scale = widthAt(s);
    const k = Math.min(STEPS, Math.round(s * STEPS));
    const off = frames.normals[k].clone().multiplyScalar((p.x - start.x) * scale).addScaledVector(frames.binormals[k], (p.z - start.z - 0.25) * scale);
    return curve.getPointAt(s).add(off.addScaledVector(roadN[k], -(1 - flats[k]) * off.dot(roadN[k])));
  };
  // The head rounds off over its last `tip` millimetres on the sheet.
  const tip = 3;
  const arcs = strands.map(st => {
    const acc = [0];
    let prev = pageOf(sv, bend(strandPoint(st, 0, 0)));
    for (let k = 1; k <= STEPS; k++) {
      const q = pageOf(sv, bend(strandPoint(st, k / STEPS, 0)));
      acc.push(acc[k - 1] + Math.hypot(q.x - prev.x, q.y - prev.y));
      prev = q;
    }
    return acc;
  });
  const lenAt = (i: number, t: number) => { const fk = Math.max(0, Math.min(1, t)) * STEPS, k = Math.min(STEPS - 1, Math.floor(fk)); return arcs[i][k] + (arcs[i][k + 1] - arcs[i][k]) * (fk - k); };
  const round = (i: number, t: number) => 0.7 + 0.3 * Math.max(0, Math.min(1, (lenAt(i, t) - lenAt(i, uHead)) / tip)) ** 0.5;
  // The kit spaces the laminations by how the upright, unbent strand looks to the camera it is given.
  // Bent along the road that measure means nothing, so it is given a stand-in: a camera looking at the
  // upright strand from the side the eye sees it from at the head, at the scale of the middle of the ramp.
  const spacingView = new THREE.PerspectiveCamera(view.fov, view.aspect, 1, 1e8);
  const mid = start.clone().setY(start.y + length / 2);
  spacingView.position.copy(mid).add(new THREE.Vector3(Math.cos(sight), 0, Math.sin(sight)).multiplyScalar(S * n(ctx, 'helixLamination', 52, 20, 200)));
  spacingView.lookAt(mid);
  spacingView.updateProjectionMatrix(); spacingView.updateMatrixWorld(true);
  const strokes: HelixStroke[] = [];
  const meshes: THREE.BufferGeometry[] = [];
  strands.forEach((st, i) => {
    const thin = (p: THREE.Vector3): THREE.Vector3 => {
      const t = Math.max(0, Math.min(1, (p.y - start.y) / length));
      const c = strandPoint(st, t, 0);
      return c.addScaledVector(p.clone().sub(c), round(i, t));
    };
    for (const h of strandStrokes(st, 1, 0, ctx, spacingView)) {
      const kept: THREE.Vector3[] = [];
      for (let k = 0; k < h.points.length; k++) {
        const p = h.points[k], t = (p.y - start.y) / length;
        if (t < uHead) continue;
        const prev = h.points[k - 1];
        if (!kept.length && prev) {
          const tp = (prev.y - start.y) / length;
          kept.push(thin(prev.clone().lerp(p, (uHead - tp) / (t - tp))));
        }
        kept.push(thin(p));
      }
      if (kept.length > 1) strokes.push({ ...h, points: kept.map(q => bend(q).multiplyScalar(1 / S)) });
    }
    const mesh = buildSurfaceMesh((u, v) => {
      const t = uHead + (1 - uHead) * u;
      const c = strandPoint(st, t, 0);
      return bend(c.lerp(strandPoint(st, t, 2 * v - 1), round(i, t)));
    }, {}, 320, 8);
    mesh.scale(1 / S, 1 / S, 1 / S);
    mesh.computeBoundingSphere();
    meshes.push(mesh);
  });
  return { strokes, meshes };
}

/** A face of a slab where a word could be cut: its centre, a baseline and an up direction, and its half extents along each. */
interface TextFrame { c: THREE.Vector3; ub: THREE.Vector3; vb: THREE.Vector3; a: number; b: number; score: number }

/** The faces of a slab that look at the eye and could take a word upright; `axes` limits which local face normals are tried. */
function textFrames(sl: Slab, view: THREE.PerspectiveCamera, eye: THREE.Vector3, axes = [0, 1, 2]): TextFrame[] {
  const rot = new THREE.Matrix4().extractRotation(slabMatrix(sl));
  const half = [sl.w / 2, sl.h / 2, sl.d / 2];
  const pos = new THREE.Vector3(sl.x, sl.y, sl.z);
  const axis = (k: number) => new THREE.Vector3().setComponent(k, 1).applyMatrix4(rot);
  const out: TextFrame[] = [];
  for (const k of axes) for (const sign of [-1, 1]) {
    const normal = axis(k).multiplyScalar(sign);
    const c = pos.clone().addScaledVector(normal, half[k] + 0.02);
    const facing = normal.dot(eye.clone().sub(c).normalize());
    if (facing < 0.4) continue;
    const [i, j] = [0, 1, 2].filter(x => x !== k);
    const cp = pageOf(view, c);
    for (const [bi, bj] of [[i, j], [j, i]]) for (const sb of [-1, 1]) for (const su of [-1, 1]) {
      const ub = axis(bi).multiplyScalar(sb), vb = axis(bj).multiplyScalar(su);
      const pb = pageOf(view, c.clone().add(ub)), pu = pageOf(view, c.clone().add(vb));
      const bx = pb.x - cp.x, by = pb.y - cp.y, ux = pu.x - cp.x, uy = pu.y - cp.y;
      // Not mirrored (baseline right, up up), the baseline within 45 degrees of level, up within 55 of vertical.
      if (bx * uy - by * ux >= 0) continue;
      const hor = bx / Math.hypot(bx, by), upr = -uy / Math.hypot(ux, uy);
      if (hor < 0.7 || upr < 0.57) continue;
      out.push({ c, ub, vb, a: half[bi], b: half[bj], score: facing * hor });
    }
  }
  return out;
}

/** Convex hull of page points (monotone chain), counter-clockwise. */
function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A page bitmap of where any of some convex page polygons (counter-clockwise) lie. */
function polyCoverage(polys: Point[][], res = 3): (p: Point) => boolean {
  const gw = Math.ceil(TABLOID_PAGE.width * res), gh = Math.ceil(TABLOID_PAGE.height * res);
  const grid = new Uint8Array(gw * gh);
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const xs = poly.map(q => q.x * res), ys = poly.map(q => q.y * res);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(gw - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(gh - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / res, py = (y + 0.5) / res;
      let inside = true;
      for (let i = 0; i < poly.length && inside; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) < 0) inside = false;
      }
      if (inside) grid[y * gw + x] = 1;
    }
  }
  return p => {
    const x = Math.floor(p.x * res), y = Math.floor(p.y * res);
    return x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x] === 1;
  };
}

/** A page polyline cut into dashes `on` long with `off` between, kept where `keep` allows. */
function dashed(run: Point[], on: number, off: number, keep: (p: Point) => boolean): Point[][] {
  return keepAlong(run, (p, at) => at % (on + off) < on && keep(p), 0.1);
}

export function drawChariot(ctx: SketchContext): Part[] {
  const view = chariotCamera(ctx);
  const eye = view.position.clone();
  const f = focal(view);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const d = dims(ctx);
  const path = makePath(ctx, view);
  const build = buildRoad(ctx, path, d);
  const track = helixTrack(ctx, path, d, view.position);
  const helix = chariotHelix(ctx, view, track);
  const hatch = n(ctx, 'hatch', 1, 0.6, 3);
  // The light: low and from behind the scene, a little to one side, so the ramp's shadow comes toward us across the ground.
  const az = THREE.MathUtils.degToRad(n(ctx, 'lightAzimuth', -5, -70, 70)), el = THREE.MathUtils.degToRad(n(ctx, 'lightElevation', 28, 10, 70));
  const light = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

  // Cells beyond the edge, as boxes: the flyers keep off them and the sky clears round them.
  const cellBoxes = build.unbuilt.map(({ ci, lane }) => slabGeometry(cellSlab(path, d, build.cells[ci].s0, build.cells[ci].s1, lane, 0)));
  const preGeos = build.pieces.map(p => slabGeometry(p.slab));
  const blocked = meshCoverage([...preGeos, ...helix.meshes, ...cellBoxes], view, TABLOID_PAGE, 0);
  for (const g of preGeos) g.dispose();
  addFlyers(ctx, view, path, d, build, blocked);
  const { pieces } = build;

  const bandOf = (p: THREE.Vector3) => { const dd = eye.z - p.z; return BAND_EDGES.findIndex((e, i) => dd >= e && dd < BAND_EDGES[i + 1]); };
  type Banded = Stroke & { band: number; slack: number };
  const strokes: Banded[] = [];
  for (const pc of pieces) {
    const sl = pc.slab, at = new THREE.Vector3(sl.x, sl.y, sl.z), mm = mmPerUnit(at), band = bandOf(at);
    if (pc.kind === 'road') {
      // The road: every slab in outline; the dark lane's rows hatched in stripes while they are big enough on the sheet, the pale lane open paper.
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quatOf(sl));
      const open = up.dot(eye.clone().sub(at).normalize());
      // A row seen at a grazing angle changes depth fast from pixel to pixel: it takes the proportional slack.
      const slack = pc.ramp && open > 0.3 ? SLAB_SLACK : ROAD_SLACK;
      for (const st of facetStrokes(sl, light, eye, true)) strokes.push({ ink: 'carbon', group: 'road', family: st.family, points: st.points, band, slack });
      const pg = pageBox(view, sl);
      // Only while its top is seen fairly open: edge on, the stripes only scribble.
      if (pc.side === 'dark' && open > 0.12 && Math.min(pg.x1 - pg.x0, pg.y1 - pg.y0) > 1.7 && sl.w * mm > 5) {
        // Where the lane is seen nearly edge on (on the ground, at the knee) its stripes are kept at least 0.55 mm apart on the sheet, or they pile up into a solid bar.
        const count = Math.round(sl.w * mm / (hatch * 0.85));
        for (const points of laneHatch(sl, Math.max(1, Math.min(count, Math.round(laneWidthOnPage(view, sl) / 0.55))))) strokes.push({ ink: 'carbon', group: 'road', family: 'hatch', points, band, slack });
      }
      continue;
    }
    // Landed and flying slabs: the pale ones in outline only, the dark ones hatched by the light face by
    // face, opened up (a lighter tone, a wider pitch) so they stay the dark force without outweighing the helix.
    const group = pc.side;
    const dark = pc.side === 'dark';
    const facets = facetStrokes(dark ? { ...sl, tone: n(ctx, 'darkTone', 0.9, 0.2, 1.5) } : sl, light, eye, !dark, hatch * n(ctx, 'darkPitch', 12, 6, 30) / mm);
    for (const st of facets) strokes.push({ ink: st.ink, group, family: st.family, points: st.points, band, slack: SLAB_SLACK });
  }
  // The road's far end: two edge rules running out to the horizon at the vanishing point.
  const rails: Banded[] = [];
  const half = d.laneW + GAP / 2;
  for (const lat of [-1, 1]) {
    const pts = [T_FAR, T_FAR * 2, T_FAR * 4, T_FAR * 8, 4000].map(t => {
      const k = path.groundK(), nrm = Math.hypot(1, k);
      return new THREE.Vector3(path.groundX(t) + lat * half / nrm, 0, -t + lat * half * k / nrm);
    });
    rails.push({ ink: 'carbon', group: 'road', family: 'edge', points: pts, band: 0, slack: 0 });
  }
  const helixStrokes: Banded[] = [];
  for (const h of helix.strokes) {
    // Long strokes are cut short so each takes the hidden-line slack of its own distance.
    const pts = h.points;
    for (let i = 0; i < pts.length - 1; i += 14) {
      const part = pts.slice(i, Math.min(pts.length, i + 15));
      helixStrokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: part, band: bandOf(part[Math.floor(part.length / 2)]), slack: HELIX_SLACK });
    }
  }

  const slabGeos = pieces.map(p => slabGeometry(p.slab));
  const geometries = [...slabGeos, ...helix.meshes];
  // The camera before its depth range is fitted: the unbuilt cells and the shadow reach nearer than anything in the depth pass.
  const wide = view.clone();
  try {
    fitDepthRange(view, geometries);
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The helix is tested only against the slabs, not its own ribbons, which only broke it up.
    const slabDepth = renderDepthBufferCPU(slabGeos, view, W, H);
    const nearP = view.near, farP = view.far;
    const biasOf = (band: number, slack: number) => {
      const lo = BAND_EDGES[band], hi = Number.isFinite(BAND_EDGES[band + 1]) ? BAND_EDGES[band + 1] : lo * 1.4;
      const dd = Math.sqrt(Math.max(lo, 8) * hi);
      return Math.max(3e-5, (slack < 0 ? groundSlack(-slack, dd) : slack) * nearP * farP / ((farP - nearP) * dd * dd));
    };
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1, 0.3, 3));
    const cellsNear = meshCoverage(cellBoxes, wide, TABLOID_PAGE, 0.8);
    // What stands over the road is cut out of it on the sheet (the ground rows are let through the depth test loosely).
    const standing = pieces.filter(p => p.kind !== 'road').map(p => slabGeometry(p.slab));
    const overRoad = meshCoverage([...standing, ...helix.meshes], view, TABLOID_PAGE, 0.6);
    for (const g of standing) g.dispose();

    // The phrase: one word to a slab, cut into a face that looks at the eye: the flying ones, the landed
    // ones, and the sides of the ramp, so the eye has to hunt for them.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('chariot-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], band: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H, bias: biasOf(band, SLAB_SLACK * 1.5) }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    type Want = 'flying' | 'landed' | 'side';
    const wants: Want[] = ['flying', 'side', 'landed', 'flying', 'side', 'landed', 'flying'];
    const kindOf = (pc: Piece): Want | null => pc.kind === 'road' ? (pc.ramp && !pc.sub ? 'side' : null) : pc.kind;
    const used = new Set<Piece>();
    const placed: Point[] = [];
    words.forEach((word, i) => {
      const want = wants[i % wants.length];
      const wmm = measureStrokeText(word, style);
      const options = pieces.filter(p => !used.has(p) && kindOf(p)).map(pc => {
        const sl = pc.slab, at = new THREE.Vector3(sl.x, sl.y, sl.z);
        const unit = 1 / mmPerUnit(at);
        const page = pageOf(view, at);
        const ok = page.x > CARD.x0 + 6 && page.x < CARD.x1 - 6 && page.y > CARD.y0 + 8 && page.y < CARD.y1 - 8
          && !placed.some(q => Math.hypot(q.x - page.x, q.y - page.y) < 30);
        const frames = ok ? textFrames(sl, view, eye, pc.kind === 'road' ? [0, 2] : [0, 1, 2]) : [];
        const fits = frames.filter(fr => wmm * unit <= 2 * fr.a * 0.9 && style.height * unit <= 2 * fr.b * 0.85).sort((a, b) => b.score - a.score)[0];
        return { pc, fr: fits, k: (kindOf(pc) === want ? 0 : 0.8) + 0.6 * wrng() - (fits ? fits.score * 0.3 : 0) };
      }).filter(o => o.fr).sort((a, b) => a.k - b.k);
      for (const { pc, fr } of options) {
        const unit = 1 / mmPerUnit(fr!.c);
        const ww = wmm * unit, hh = style.height * unit;
        const x0 = -ww / 2 + (wrng() - 0.5) * (2 * fr!.a - ww) * 0.7, y0 = -hh / 2 + (wrng() - 0.5) * (2 * fr!.b - hh) * 0.5;
        const word3 = strokeText(word, 0, 0, style).map(p2 => p2.map(q => fr!.c.clone().addScaledVector(fr!.ub, x0 + q.x * unit).addScaledVector(fr!.vb, y0 + hh - q.y * unit)));
        const onCard = word3.every(l => l.every(q => { const pq = pageOf(view, q); return pq.x > CARD.x0 + 2 && pq.x < CARD.x1 - 2 && pq.y > CARD.y0 + 2 && pq.y < CARD.y1 - 2; }));
        if (!onCard || !visible(word3, bandOf(fr!.c))) continue;
        textStrokes.push(...word3);
        used.add(pc);
        placed.push(pageOf(view, new THREE.Vector3(pc.slab.x, pc.slab.y, pc.slab.z)));
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    // The arcs the flying slabs have come along: a dashed trail behind each, and a clear lane through the ruled sky.
    const trailPaths: Point[][] = [];
    for (const pc of pieces) if (pc.flight) {
      const f0 = pc.flight, line: Point[] = [];
      for (let u = Math.max(0, f0.u - 0.6); u <= f0.u - 0.04; u += 0.005) line.push(pageOf(view, arcAt(f0, u)));
      if (line.length < 2) continue;
      for (const inside of clipWindow(line)) trailPaths.push(...dashed(inside, 2.4, 1.8, () => true));
    }
    const onTrail = glyphMask(trailPaths, 1.4);
    const onGlyph = glyphMask(glyphPaths, 0.9);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    const nearHelix = meshCoverage(helix.meshes, view, TABLOID_PAGE, 2);
    const batches = new Map<string, Banded[]>();
    for (const st of strokes) {
      const key = `${st.band}:${st.slack}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(st);
    }
    for (const mine of batches.values()) {
      projectStrokes(mine, { view, depth: depthBuffer, width: W, height: H, bias: biasOf(mine[0].band, mine[0].slack) }, {
        begin: st => runs => {
          for (const run of runs) {
            if (st.group !== 'road') { add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), undefined, 0.6); continue; }
            // Road lines are cut where the helix or a slab stands over them; a short scrap left right beside the
            // helix (between its strands) is dropped, or it reads as a stray tick.
            for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y))) for (const piece of keepAlong(inside, p => !onGlyph(p) && !overRoad(p), 0.15)) {
              const scrap = pathLength(piece) < 2.5 && piece.every(nearHelix);
              if (!scrap) buckets.add(`${st.group}-${st.ink}`, piece, false, 0.6);
            }
          }
        },
      });
    }
    const helixBatches = new Map<number, Banded[]>();
    for (const st of helixStrokes) { if (!helixBatches.has(st.band)) helixBatches.set(st.band, []); helixBatches.get(st.band)!.push(st); }
    for (const mine of helixBatches.values()) {
      projectStrokes(mine, { view, depth: slabDepth, width: W, height: H, bias: biasOf(mine[0].band, SLAB_SLACK) }, {
        begin: st => runs => { for (const run of runs) add(`helix-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
      });
    }
    projectStrokes(rails, { view, depth: depthBuffer, width: W, height: H }, {
      hidden: () => false,
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // Slabs not yet laid: the outlines of their tops, dashed, on through the sky.
    const unbuiltLines: THREE.Vector3[][] = [];
    for (const { ci, lane } of build.unbuilt) {
      const c = build.cells[ci];
      const edge = (s: number, side: number) => { const fr = path.frame(s); return path.at(s).addScaledVector(fr.N, d.thick).addScaledVector(fr.B, laneLat(d, lane) + side * d.laneW / 2); };
      const sA = c.s0 + GAP / 2, sB = c.s1 - GAP / 2;
      const along = (side: number) => Array.from({ length: 7 }, (_, k) => edge(sA + (sB - sA) * k / 6, side));
      const left = along(-1), right = along(1);
      unbuiltLines.push([...left, ...right.reverse(), left[0]]);
    }
    projectStrokes(unbuiltLines.map(points => ({ points })), { view: wide, depth: depthBuffer, width: W, height: H }, {
      hidden: () => false,
      begin: () => runs => {
        for (const run of runs) for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y))) {
          for (const piece of dashed(inside, 1.8, 1.4, p => !onGlyph(p) && !solids(p))) buckets.add('unbuilt-carbon', piece);
        }
      },
    });

    // The ramp's shadow on the ground: each slab off the ground cast along the light, as a flat hatch.
    const toGround = (p: THREE.Vector3): Point => {
      const q = p.clone().addScaledVector(light, -p.y / light.y);
      if (-q.z < 4) {
        const r = p.clone().addScaledVector(light, (-4 - p.z) / light.z);
        return { x: PW / 2 + f * r.x / 4, y: HORIZON_Y + eye.y * f / 4 };
      }
      return pageOf(view, q.setY(0));
    };
    // One hull to a row and one to each pair of rows, so the shadow is one band, not a tiling with seams.
    const shadowPolys: Point[][] = [];
    const byRow = new Map<number, THREE.Vector3[]>();
    for (const pc of pieces) if (pc.kind === 'road' && pc.ramp) {
      if (!byRow.has(pc.row)) byRow.set(pc.row, []);
      byRow.get(pc.row)!.push(...corners(pc.slab));
    }
    for (const [row, pts] of byRow) shadowPolys.push(hull([...pts, ...(byRow.get(row + 1) ?? [])].map(toGround)));
    const inShadow = polyCoverage(shadowPolys);
    const pitch = n(ctx, 'shadowPitch', 0.7, 0.5, 3);
    for (let y = HORIZON_Y + 1.5; y < CARD.y1; y += pitch) {
      add('shadow-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => inShadow(p) && !solids(p));
    }

    // The sky: a light ruling, full lines only near the top, thinning and breaking as it comes down to the
    // horizon, knocked out round what stands in it. Near the streak the lines that are left break into
    // short dashes, as if blown past.
    const reachSky = n(ctx, 'sky', 0.5, 0, 1);
    const pattern = barPattern(ctx.random('chariot-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    const streak = track.ramp.map(q => pageOf(view, q));
    const nearStreak = (p: Point) => streak.some(q => Math.hypot(q.x - p.x, (q.y - p.y) * 0.8) < 24);
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
        if (solids(p) || onTrail(p) || cellsNear(p)) return false;
        if (broken && !pattern[step % 64]) return false;
        if (thinner && !pattern[(step * 3 + 17) % 64]) return false;
        return !(nearStreak(p) && Math.floor(p.x / 1.8) % 2 === 1);
      });
    }
    for (const path2 of trailPaths) for (const piece of keepAlong(path2, p => !solids(p) && !onGlyph(p), 0.3)) buckets.add('trail-carbon', piece, true);
    for (const p2 of glyphPaths) buckets.add('slogan-lettering', p2, true);
    const parts = buckets.toParts(['sky', 'shadow', 'trail', 'road', 'unbuilt', 'pale', 'dark', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('VII', 'THE CHARIOT'));
    return parts;
  } finally {
    for (const geo of [...geometries, ...cellBoxes]) geo.dispose();
  }
}
