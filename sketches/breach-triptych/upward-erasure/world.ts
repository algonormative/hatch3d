import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import {
  contourLines, isoLines, meshSdf, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry, toWorld, type IsoLine, type SculptMesh, type SurfacePoint, type V3,
} from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import { traceMask } from '../../kit/outline.ts';
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
}

// ── Controls ─────────────────────────────────────────────────────────

const slider = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string): Control =>
  ({ type: 'slider', id, label, default: d, min, max, step, group, ...(units ? { units } : {}) });

export const CONTROLS: Control[] = [
  slider('tilt', 'How far the head tips back on the neck', 18, 0, 70, 1, 'Pose', '°'),
  slider('turn', 'How far the head turns on the neck', 6, -40, 40, 1, 'Pose', '°'),
  slider('yaw', 'How far the figure turns from the camera (positive: its face toward the right of the sheet)', 40, -90, 90, 1, 'Pose', '°'),
  slider('roll', 'How far the head and neck lean toward the left of the sheet (the crown left, the chin right)', 8, -40, 40, 1, 'Pose', '°'),
  slider('noseBulb', 'Nose tip fullness (1: round)', 0.5, 0.3, 1.4, 0.05, 'Pose'),
  slider('noseLength', 'Nose length', 1.05, 0.6, 1.6, 0.05, 'Pose'),
  slider('lookUp', 'Camera look up', 8, 0, 60, 1, 'Camera', '°'),
  slider('headMm', 'Head height on the sheet (chin to crown)', 190, 60, 330, 1, 'Camera', 'mm'),
  slider('crownY', 'Crown height on the sheet', 120, 20, 250, 1, 'Camera', 'mm'),
  slider('headX', 'Head centre across the sheet', 150, 40, 240, 1, 'Camera', 'mm'),
  slider('collarAt', 'Where the collar meets the neck (head units below the ears)', 0.56, 0.4, 1.6, 0.01, 'Suit'),
  slider('pitchMm', 'Densest engraving pitch on the sheet', 0.95, 0.8, 3, 0.05, 'Lines', 'mm'),
  slider('plateMm', 'Plate size on the head (seed spacing)', 27, 10, 80, 1, 'Lines', 'mm'),
  slider('step', 'Mesh cell (head units)', 0.009, 0.004, 0.03, 0.001, 'Lines'),
  slider('barMm', 'Visor height', 30, 16, 60, 0.5, 'Visor', 'mm'),
  slider('barTilt', 'Visor tilt off the line of the eyes', 0, -25, 25, 0.5, 'Visor', '°'),
  slider('barPast', 'How far the visor runs past the nose\'s tip', 6, -20, 80, 1, 'Visor', 'mm'),
  slider('erosion', 'How much of the crown comes away', 0.85, 0, 1, 0.01, 'Glitch'),
  slider('riseMm', 'How high the visor\'s gold columns rise', 80, 10, 200, 1, 'Glitch', 'mm'),
  slider('spillMm', 'How far below the visor the face spills sideways', 26, 0, 80, 1, 'Glitch', 'mm'),
  { type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'],
    optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no bar, no erasure)' }, group: 'Crown' },
];

// ── The head ─────────────────────────────────────────────────────────

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

export function erasure(ctx: SketchContext): Erasure {
  const S = 100;
  const head = sculptHead({ bulb: n(ctx, 'noseBulb', 0.5, 0.3, 1.4), nose: n(ctx, 'noseLength', 1.05, 0.6, 1.6), tilt: deg(n(ctx, 'tilt', 18, 0, 70)), turn: deg(n(ctx, 'turn', 6, -40, 40)), neck: 1.6 });
  // Turned (`yaw`), then leaned about the line of sight (`roll`, toward the left of the sheet).
  const transform = new THREE.Matrix4().makeRotationZ(deg(n(ctx, 'roll', 8, -40, 40))).multiply(new THREE.Matrix4().makeRotationY(deg(n(ctx, 'yaw', 40, -90, 90))))
    .multiply(new THREE.Matrix4().makeScale(S, S, S));
  const mesh = meshSdf(head.sdf, head.lo, head.hi, n(ctx, 'step', 0.009, 0.004, 0.03), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const isHead = (p: V3) => head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p);

  // The camera below the chin, looking up; its field of view and offset fitted so the head (chin to crown) is `headMm`
  // tall on the sheet, its crown at `crownY` and its middle at `headX`.
  const target = toW(head.at.chinUnder).lerp(toW(head.at.neckBase), 0.4);
  const D = 8 * S, lookUp = deg(n(ctx, 'lookUp', 8, 0, 60));
  const sample: THREE.Vector3[] = [];
  for (let v = 0; v < mesh.pos.length; v += 3 * 29) { const p: V3 = [mesh.pos[v], mesh.pos[v + 1], mesh.pos[v + 2]]; if (isHead(p)) sample.push(toW(p)); }
  const headMm = n(ctx, 'headMm', 190, 60, 330);
  const want = { h: headMm, top: n(ctx, 'crownY', 120, 20, 250), x: n(ctx, 'headX', 150, 40, 240) };
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
  const noseGeo = subMesh(mesh, p => { const q = head.unplace(...p); return Math.abs(q[0]) < 0.08 && q[2] > 0.36 && q[1] > -0.19 && q[1] < -0.02; });
  const onNose = meshCoverage([noseGeo], view, PAGE, 1.0);
  noseGeo.dispose();
  const eyeM = modelPoint(mesh, view.position);

  // On black the silver is the light: lit surfaces carry the most lines. Light from above and a little ahead of the
  // face, so the face turned up into it is dense and the jaw's underside sparse. Every fourth line of a family is
  // drawn everywhere (no plate goes bare by the light alone), every second from `TH[1]`, all from `TH[2]`.
  const light = new THREE.Vector3(0.35, 1, 0.55).normalize();
  const brightness = (sp: SurfacePoint) => Math.max(0, new THREE.Vector3(...sp.n).transformDirection(transform).dot(light)) ** 0.8;
  const TH = [-1, 0.18, 0.42];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[1];
  const headNy = (p: V3, nv: V3) => { const q = head.unplace(...p), q2 = head.unplace(p[0] + nv[0] * 0.01, p[1] + nv[1] * 0.01, p[2] + nv[2] * 0.01); return (q2[1] - q[1]) / 0.01; };
  const facing = (sp: SurfacePoint) => sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  /** Neck, the ear's whorl, the head's plates; lines stop a little short of the crease where the jaw meets the neck. */
  const zoneOf = (p: V3): 'neck' | 'ear' | 'plate' | undefined => {
    const seam = head.parts.head(...head.unplace(...p)) - head.parts.neck(...p);
    if (seam > 0.004) return 'neck';
    if (seam > -0.01) return undefined;
    return Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]) < 0.12 ? 'ear' : 'plate';
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
  const pitch = n(ctx, 'pitchMm', 0.95, 0.8, 3) / headMm;

  // The plates: seeds on the features and scattered over the rest of the head, in the head's own frame.
  const rng = ctx.random('erasure-plates');
  const seeds = scatterOn(mesh, n(ctx, 'plateMm', 27, 10, 80) / headMm, rng, p => zoneOf(p) === 'plate', FEATURES.map(head.place), p => head.unplace(...p));
  const plates = platesOn(mesh, seeds, p => head.unplace(...p));
  seeds.forEach((s, k) => {
    // Each plate's lines: level planes of the head turned to their own angle. Down the face the planes run along it (they
    // draw the profile again), under the jaw and on the crown they lie level; each is then turned by a seeded angle about
    // the seed's own outward direction (the features hardly). A fifth are cross-hatched, a few left bare.
    const feature = k < FEATURES.length;
    const outward = new THREE.Vector3(s[0], s[1] + 0.05, s[2]).normalize();
    const base = s[1] > CROWN || (s[1] < JAW && s[2] < 0.3) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const swing = (feature ? 0.25 : 0.8) * (rng() * 2 - 1);
    const dirs = [base.clone().applyAxisAngle(outward, swing)];
    const style = rng();
    if (!feature && style < 0.12) return;
    if (style > 0.8) dirs.push(dirs[0].clone().applyAxisAngle(outward, 1.2 + 0.4 * rng()));
    for (const [j, d] of dirs.entries()) {
      const value = new Float64Array(mesh.pos.length / 3).fill(NaN);
      const pts = mesh.pos;
      for (let v = 0; v < value.length; v++) {
        if (plates.plate[v] !== k && plates.second[v] !== k) continue;
        const q = head.unplace(pts[3 * v], pts[3 * v + 1], pts[3 * v + 2]);
        value[v] = q[0] * d.x + q[1] * d.y + q[2] * d.z;
      }
      const spacing = pitch * (j ? 1.7 : 1);
      keepRuns(isoLines(mesh, value, spacing, rng() * spacing), sp => plates.at(sp.p).plate === k && plates.at(sp.p).gap > SEAM && zoneOf(sp.p) === 'plate', true, 'silver', 2, 'plate');
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
    keepRuns(isoLines(mesh, value, 1, 0, [0]), sp => zoneOf(sp.p) === 'plate', false, 'gold', 1, 'seam');
  }
  // The ear, one silver whorl.
  const earQ = head.unplace(...ear), turn = pitch * 1.3;
  const spiral = { values: hq(q => Math.atan2(q[1] - earQ[1], q[2] - earQ[2])), period: 2 * Math.PI };
  keepRuns(isoLines(mesh, hq(q => Math.hypot(q[1] - earQ[1], q[2] - earQ[2]) / turn * 2 * Math.PI), 2 * Math.PI, 0, undefined, spiral), sp => zoneOf(sp.p) === 'ear', false, 'silver', 2, 'ear');
  // The neck: lines along it, and three gold rings that make it segments.
  keepRuns(isoLines(mesh, perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03)), pitch / 0.15), sp => zoneOf(sp.p) === 'neck', true, 'silver', 2, 'neck');
  for (const y of [-0.5, -0.62, -0.74]) keepRuns(isoLines(mesh, perVertex(mesh, p => p[1]), 1, 0, [y]), sp => zoneOf(sp.p) === 'neck', false, 'gold', 1, 'ring');
  // The silhouette, and the creases: the jaw's edge (where the face turns under) and the line the jaw meets the neck.
  for (const l of contourLines(mesh, eyeM)) marks.push({ points: toWorld(mesh, l.points), pen: 'gold', rank: 0, id: 'outline' });
  const jawEdge = perVertex(mesh, (p, nv) => (isHead(p) && head.unplace(...p)[1] < JAW ? headNy(p, nv) : 1));
  keepRuns(isoLines(mesh, jawEdge, 1, 0, [-0.35]), sp => zoneOf(sp.p) !== 'ear', false, 'gold', 1, 'crease');
  keepRuns(isoLines(mesh, perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p)), 1, 0, [0.004]), () => true, false, 'gold', 1, 'crease');
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

  // ── The suit ──────────────────────────────────────────────────────
  const collarY = -n(ctx, 'collarAt', 0.56, 0.4, 1.6);
  const ring: Point[] = [];
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; ring.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)])); }
  const left = ring.reduce((a, b) => (b.x < a.x ? b : a)), right = ring.reduce((a, b) => (b.x > a.x ? b : a));
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));
  const page = { eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), neck: { left, right } };

  // ── The visor, and the glitch it bleeds into ──────────────────────
  // The visor lies on the face like glasses: along the line of the eyes, over them, resting on the bridge of the nose
  // (the nose's tip and wings stand in front of it), from off the edge behind the head to a little past the tip. In its
  // own frame (u along it, v up from its top edge, both mm) the glitch grows out of it: its top edge breaks into stepped
  // gold columns rising into the crown, the head above is taken apart into slices lifted up the sheet, fragments break
  // off higher, and a few bands of the face spill sideways below it.
  const assembled = ctx.params.view !== 'head';
  const barH = n(ctx, 'barMm', 30, 16, 60);
  const eyesAt = page.eyes;
  const eyeLine = Math.atan2(eyesAt[1].y - eyesAt[0].y, eyesAt[1].x - eyesAt[0].x);
  const tilt = (Math.abs(eyeLine) > Math.PI / 2 ? eyeLine - Math.sign(eyeLine) * Math.PI : eyeLine) + deg(n(ctx, 'barTilt', 0, -25, 25));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  const eyeMid = { x: (eyesAt[0].x + eyesAt[1].x) / 2, y: (eyesAt[0].y + eyesAt[1].y) / 2 };
  const centre = { x: eyeMid.x + nrm.x * 0.08 * barH, y: eyeMid.y + nrm.y * 0.08 * barH };
  /** A point of the visor's frame on the page, and back. */
  const toPage = (u: number, v: number): Point => ({ x: centre.x + dir.x * u - nrm.x * (barH / 2 + v), y: centre.y + dir.y * u - nrm.y * (barH / 2 + v) });
  const toBar = (p: Point) => ({ u: (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y, v: -((p.x - centre.x) * nrm.x + (p.y - centre.y) * nrm.y) - barH / 2 });
  const quad = (u0: number, u1: number, v0: number, v1: number): Point[] => [toPage(u0, v1), toPage(u1, v1), toPage(u1, v0), toPage(u0, v0)];
  const faceDir = Math.sign(toBar(page.noseTip).u - toBar(eyeMid).u) || 1;
  // Off the sheet behind the head: far enough along the visor that its whole height is past the trim.
  let uBack = 0;
  while (uBack * -faceDir < 600) { const a = toPage(uBack, 0), b = toPage(uBack, -barH); if ([a, b].every(q => q.x < TRIM.x0 - 4 || q.x > TRIM.x1 + 4 || q.y < TRIM.y0 - 4 || q.y > TRIM.y1 + 4)) break; uBack -= faceDir; }
  const uFace = toBar(page.noseTip).u + faceDir * n(ctx, 'barPast', 6, -20, 80);
  const [u0, u1] = [Math.min(uBack, uFace), Math.max(uBack, uFace)];
  const bar = clipToTrim(quad(u0, u1, -barH, 0));

  const crng = ctx.random('erasure-glitch');
  const erosion = n(ctx, 'erosion', 0.85, 0, 1), reach = n(ctx, 'riseMm', 80, 10, 200);
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
  // Where the crown is taken apart: over the head, above the visor.
  let h0 = Infinity, h1 = -Infinity;
  for (let u = u0; u <= u1; u += 0.5) if (onHead(toPage(u, 2))) { h0 = Math.min(h0, u); h1 = Math.max(h1, u); }
  const glitch = { u0: u0, u1: u1 };
  if (assembled) {
    let u = u0;
    while (u < u1 - 3) {
      const w = Math.min(u1 - u, 3 + 10 * crng() ** 1.3);
      if (w < 3) break;
      const a = u, b = u + w, mid = (a + b) / 2;
      u = b;
      // Nearer the head the glitch is stronger: the columns taller and more of them lifted.
      const near = h0 < h1 ? Math.max(0, 1 - Math.max(0, h0 - mid, mid - h1) / 90) : 0;
      const rise = headRise(a, b);
      const over = Number.isFinite(rise) && rise > 3;
      const roll = crng();
      let top = 0;
      if (roll < 0.35 + 0.15 * near) {
        // A gold column out of the visor's top edge: smeared upward.
        top = snap(reach * (0.08 + 0.92 * crng() ** 1.6) * (0.4 + 0.6 * near));
        while (top > 3 && !fits(a, b, 0, top)) top -= 1.5;
        if (top > 3) cells.push({ u0: a, u1: b, v0: -2, v1: top, dv: snap(2 + 6 * crng()), kind: 'rise' });
        else top = 0;
      } else if (over && crng() > erosion * 0.5) {
        // The head kept, from the visor up to a seeded height of its rise.
        top = snap(rise * (0.3 + 0.7 * crng()));
        cells.push({ u0: a, u1: b, v0: -2, v1: top, dv: 0, kind: 'base' });
      }
      // Lifted pieces above: taken from the head (the crown, or the brow under the visor), on the black or the gold.
      if (over && crng() < erosion) {
        let ceiling = top;
        const pieces = 2 + Math.floor(4 * crng() * (0.5 + near));
        for (let k = 0; k < pieces; k++) {
          const h = 3 + 10 * crng();
          const v0 = -barH + 3 + (rise - h + barH - 3) * crng();
          const dest = ceiling + 4 + 28 * crng() * (k + 1) ** 0.6;
          if (!fits(a, b, dest, dest + h)) break;
          cells.push({ u0: a, u1: b, v0: snap(v0), v1: snap(v0) + snap(h), dv: snap(dest - v0), kind: crng() < 0.45 ? 'gold' : 'black' });
          ceiling = dest + h;
        }
        top = ceiling;
      } else if (crng() < 0.3 + 0.3 * near) {
        const h = 3 + 9 * crng(), v0 = top + 5 + 40 * crng() * (0.5 + near);
        if (fits(a + 0.6, b - 0.6, v0, v0 + h)) { fragments.push(quad(a + 0.6, b - 0.6, snap(v0), snap(v0 + h))); top = v0 + h; }
      }
      // A drip below the visor now and then.
      if (crng() < 0.12 + 0.12 * near) {
        const h = 2 + 7 * crng();
        const drip = quad(a, b, -barH - h, -barH + 2);
        if (drip.every(inTrim)) drips.push(drip);
      }
      // Ribbons: from the top edge down along the visor's upward direction, stopping above the column.
      const count = Math.floor(w / 3) + (crng() < 0.5 ? 1 : 0);
      for (let k = 0; k < count; k++) {
        if (crng() < 0.55) continue;
        const pen: Pen = crng() < 0.2 ? 'gold' : 'silver';
        const ur = a + 1.2 + (w - 2.4) * (count === 1 ? 0.5 : k / Math.max(1, count - 1));
        const end = top + 6 + 30 * crng();
        let vTop = end;
        while (vTop < 600 && toPage(ur, vTop).y > TRIM.y0 - 2) vTop += 2;
        if (vTop - end < 10) continue;
        const kind = crng();
        if (kind < 0.3) ribbons.push({ pen, path: [toPage(ur - 0.6, vTop), toPage(ur - 0.6, end), toPage(ur + 0.6, end), toPage(ur + 0.6, vTop)] });
        else {
          ribbons.push({ pen, path: [toPage(ur, vTop), toPage(ur, end)] });
          if (crng() < 0.35) ribbons.push({ pen, path: [toPage(ur - 0.9, end - 2), toPage(ur + 0.9, end - 2), toPage(ur + 0.9, end - 6), toPage(ur - 0.9, end - 6), toPage(ur - 0.9, end - 2)] });
        }
      }
    }
    // The gold columns smeared: streaks up each, at a seeded spacing, from inside the visor to a seeded height.
    for (const c of cells) if (c.kind === 'rise') {
      for (let us = c.u0 + 0.9; us < c.u1 - 0.6; us += 1.0 + 1.4 * crng()) {
        if (crng() < 0.3) continue;
        streaks.push([toPage(us, -barH + 2), toPage(us, Math.min(c.v1 - 1, (c.v1 + 2) * (0.3 + 0.75 * crng())))]);
      }
    }
  }
  // Bands of the visor and just below it, each drawn shifted along the visor: the eyes behind it on the gold, the face
  // spilling below on the black.
  const bands = (from: number, to: number, chance: number, shift: number) => {
    const out: { v0: number; v1: number; du: number }[] = [];
    for (let v = from; v < to;) { const h = 1.5 + 4.5 * crng(); if (crng() < chance) out.push({ v0: v, v1: Math.min(to, v + h), du: (crng() * 2 - 1) * shift }); v += h; }
    return out;
  };
  const visorBands = assembled ? bands(-barH, 0, 1, 7) : [];
  const spill = assembled ? bands(-barH - n(ctx, 'spillMm', 26, 0, 80), -barH, 0.4, 9) : [];

  // Where a cell shows: a lifted piece `dv` up from where it was taken; a column or a base where it stands.
  const inCell = (p: Point, kinds: Cell['kind'][]) => {
    const b = toBar(p);
    return cells.some(c => { const dv = c.kind === 'rise' || c.kind === 'base' ? 0 : c.dv; return kinds.includes(c.kind) && b.u >= c.u0 && b.u <= c.u1 && b.v >= c.v0 + dv && b.v <= c.v1 + dv; });
  };
  /** Where the head is taken apart: above the visor's top edge, all along it. */
  const erased = (p: Point) => { if (!assembled) return false; const b = toBar(p); return b.v > -2 && b.u >= glitch.u0 && b.u <= glitch.u1 && !inCell(p, ['base']); };

  // ── The black's windows ───────────────────────────────────────────
  // The visor (less the lower nose, which stands over it), the gold columns, pieces, fragments and drips, the shirt
  // and collar.
  const shirtRings = suit.shirt;
  const windowAt = (p: Point) => ((assembled && insideRing(bar, p)) || inCell(p, ['rise', 'gold']) || fragments.some(f => insideRing(f, p)) || drips.some(d => insideRing(d, p))) && !onNose(p)
    || (shirtRings.some(r => insideRing(r, p)) && !suit.tie.some(r => insideRing(r, p))) || (insideRing(suit.back, p) && !onHead(p));
  const window = traceMask(windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, 0.25, { simplify: 0.08, minRadius: 0.5, minArea: 6 });

  return {
    head: seen, onHead, onNose, bar, toPage, toBar, barH, cells, erased, fragments, drips, streaks, visorBands, spill,
    panels: suit.panels, suitLines: suit.lines, bySuit, shirt: shirtRings, collarBack: suit.back, window, ribbons, page,
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
