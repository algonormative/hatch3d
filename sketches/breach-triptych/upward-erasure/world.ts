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
import { clipToTrim, rect, stripeFill } from '../lodestone-cuts.ts';
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

/**
 * A window of a crown slice: where it was on the head (`y0`..`y1`) and how far up it is drawn (`dy`). A `base` stays
 * where it was; a `black` piece is drawn again higher on the black, framed in gold; a `gold` piece is cut out of the
 * black and drawn again in black ink on the gold beneath.
 */
export interface SliceWindow { y0: number; y1: number; dy: number; kind: 'base' | 'black' | 'gold' }
export interface Slice { x0: number; x1: number; windows: SliceWindow[] }

/** A line of the suit; `behind` the neck (the collar's back), hidden where the neck is. */
export interface SuitLine { pen: Pen; path: Point[]; behind?: boolean }

/** A panel of the suit, striped at `angle`, `pitch` apart, in `pen` (on the gold for a `window`). */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: Pen; cross?: number; window?: boolean }

export interface Erasure {
  head: Seen[];
  onHead: (p: Point) => boolean;
  /** Where the nose covers the bar (grown by a little black round it). */
  onNose: (p: Point) => boolean;
  bar: Point[];
  barTop: (x: number) => number;
  slices: Slice[];
  /** Gold-yellow fragments above the bar: plain windows. */
  fragments: Point[][];
  panels: Panel[];
  suitLines: SuitLine[];
  /** Covered by the suit or the shirt's collar (in front of the neck). */
  bySuit: (p: Point) => boolean;
  /** The shirt's and collar's rings (windows onto the gold), the collar's back less the neck. */
  shirt: Point[][];
  collarBack: Point[];
  /** The black's windows. */
  window: Point[][];
  ribbons: { pen: Pen; path: Point[] }[];
  page: { eyes: Point[]; noseTip: Point; chin: Point; neck: { left: Point; right: Point } };
}

// ── Controls ─────────────────────────────────────────────────────────

const slider = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string): Control =>
  ({ type: 'slider', id, label, default: d, min, max, step, group, ...(units ? { units } : {}) });

export const CONTROLS: Control[] = [
  slider('tilt', 'How far the head tips back on the neck', 26, 0, 70, 1, 'Pose', '°'),
  slider('turn', 'How far the head turns on the neck (to its right)', -8, -40, 40, 1, 'Pose', '°'),
  slider('yaw', 'How far the figure turns from the camera (negative: its face toward the left of the sheet)', -46, -90, 90, 1, 'Pose', '°'),
  slider('lookUp', 'Camera look up', 8, 0, 60, 1, 'Camera', '°'),
  slider('headMm', 'Head height on the sheet (chin to crown)', 190, 60, 330, 1, 'Camera', 'mm'),
  slider('crownY', 'Crown height on the sheet', 120, 20, 250, 1, 'Camera', 'mm'),
  slider('headX', 'Head centre across the sheet', 150, 40, 240, 1, 'Camera', 'mm'),
  slider('collarAt', 'Where the collar meets the neck (head units below the ears)', 0.56, 0.4, 1.6, 0.01, 'Suit'),
  slider('pitchMm', 'Densest engraving pitch on the sheet', 0.95, 0.8, 3, 0.05, 'Lines', 'mm'),
  slider('plateMm', 'Plate size on the head (seed spacing)', 27, 10, 80, 1, 'Lines', 'mm'),
  slider('step', 'Mesh cell (head units)', 0.009, 0.004, 0.03, 0.001, 'Lines'),
  slider('barMm', 'Bar height', 32, 16, 60, 0.5, 'Bar', 'mm'),
  slider('barTilt', 'Bar tilt (negative: down to the left)', -9, -25, 25, 0.5, 'Bar', '°'),
  slider('barPast', 'How far the bar runs past the nose\'s tip', 30, 0, 120, 1, 'Bar', 'mm'),
  slider('erosion', 'How much of the crown comes away', 0.85, 0, 1, 0.01, 'Crown'),
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
  const head = sculptHead({ tilt: deg(n(ctx, 'tilt', 26, 0, 70)), turn: deg(n(ctx, 'turn', -8, -40, 40)), neck: 1.6 });
  const transform = new THREE.Matrix4().makeRotationY(deg(n(ctx, 'yaw', -46, -90, 90))).multiply(new THREE.Matrix4().makeScale(S, S, S));
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
  const noseGeo = subMesh(mesh, p => { const q = head.unplace(...p); return Math.abs(q[0]) < 0.08 && q[2] > 0.34 && q[1] > -0.19 && q[1] < 0.05; });
  const onNose = meshCoverage([noseGeo], view, PAGE, 1.0);
  noseGeo.dispose();
  const eyeM = modelPoint(mesh, view.position);

  // On black the silver is the light: lit surfaces carry the most lines. Light from above and a little ahead of the
  // face, so the face turned up into it is dense and the jaw's underside sparse. Every fourth line of a family is
  // drawn everywhere (no plate goes bare by the light alone), every second from `TH[1]`, all from `TH[2]`.
  const light = new THREE.Vector3(-0.35, 1, 0.55).normalize();
  const brightness = (sp: SurfacePoint) => Math.max(0, new THREE.Vector3(...sp.n).transformDirection(transform).dot(light)) ** 0.8;
  const TH = [-1, 0.3, 0.55];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[0];
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

  // ── The bar, and the crown above it ───────────────────────────────
  const assembled = ctx.params.view !== 'head';
  const barH = n(ctx, 'barMm', 32, 16, 60), tilt = deg(n(ctx, 'barTilt', -9, -25, 25));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  // Over the nearer eye (in the bar's upper part, so the brow and the crown show above), from off the edge behind the
  // head to `barPast` beyond the nose's tip: the nose stands over it.
  const nearer = head.at.eyes.map(toW).map(p => p.distanceTo(view.position));
  const eyeAt = page.eyes[nearer[0] < nearer[1] ? 0 : 1];
  const eyeMid = { x: eyeAt.x, y: eyeAt.y + 0.22 * barH };
  const along = (p: Point) => (p.x - eyeMid.x) * dir.x + (p.y - eyeMid.y) * dir.y;
  const faceLeft = page.noseTip.x < eyeAt.x;
  const sBack = along({ x: faceLeft ? TRIM.x1 + 8 : TRIM.x0 - 8, y: eyeMid.y });
  const sFace = along(page.noseTip) + (faceLeft ? -1 : 1) * n(ctx, 'barPast', 30, 0, 120);
  const [s0, s1] = [Math.min(sBack, sFace), Math.max(sBack, sFace)];
  const corner = (s: number, o: number): Point => ({ x: eyeMid.x + dir.x * s + nrm.x * o, y: eyeMid.y + dir.y * s + nrm.y * o });
  const bar = clipToTrim([corner(s0, -barH / 2), corner(s1, -barH / 2), corner(s1, barH / 2), corner(s0, barH / 2)]);
  const barTop = (x: number) => eyeMid.y + (x - eyeMid.x) * Math.tan(tilt) - barH / 2 / Math.cos(tilt);
  const barBottom = (x: number) => barTop(x) + barH / Math.cos(tilt);

  // The crown's slices: across the head where it rises above the bar, seeded widths of 4 to 13 mm. Each keeps a base
  // that steps down the skull's curve and loses the rest: lifted off and drawn higher up the sheet in two to four pieces
  // (taken from anywhere on the head above the bar's lower edge, the forehead under the bar too), each further from the
  // last, on the black or cut out onto the gold; or (a few) a gold-yellow fragment in its place.
  const crng = ctx.random('erasure-crown');
  const erosion = n(ctx, 'erosion', 0.85, 0, 1);
  const tops = new Map<number, number>();
  const headTop = (x: number) => {
    const k = Math.round(x * 4);
    if (!tops.has(k)) { let y = TRIM.y0; while (y < barTop(x) && !onHead({ x, y })) y += 0.25; tops.set(k, y); }
    return tops.get(k)!;
  };
  let cx0 = Infinity, cx1 = -Infinity;
  for (let x = TRIM.x0; x <= TRIM.x1; x += 0.5) if (headTop(x) < barTop(x) - 4) { cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x); }
  const slices: Slice[] = [];
  const fragments: Point[][] = [];
  const ribbons: { pen: Pen; path: Point[] }[] = [];
  const LIFT_TOP = TRIM.y0 + 10;
  const snap = (y: number) => Math.round(y / 1.5) * 1.5;
  if (assembled && cx0 < cx1) {
    let x = cx0;
    while (x < cx1 - 2) {
      const w = Math.min(cx1 - x, 4 + 9 * crng() ** 1.4);
      if (w < 4) break;
      const a = x, b = x + w;
      x = b;
      let top = -Infinity;
      for (let t = a; t <= b; t += 0.5) top = Math.max(top, headTop(t));
      const bottom = Math.max(barTop(a), barTop(b)) + 4;
      const height = barTop((a + b) / 2) - top;
      const windows: SliceWindow[] = [];
      if (height < 5) { slices.push({ x0: a, x1: b, windows: [{ y0: snap(top), y1: bottom, dy: 0, kind: 'base' }] }); continue; }
      const eroded = crng() < erosion;
      const keepTo = eroded ? top + height * (0.45 + 0.55 * crng()) : top + height * 0.1 * crng();
      windows.push({ y0: keepTo, y1: bottom, dy: 0, kind: 'base' });
      const fate = crng();
      if (eroded && fate < 0.8) {
        const floor = Math.min(barBottom(a), barBottom(b)) - 3;
        let ceiling = keepTo;
        const pieces = 2 + Math.floor(3 * crng());
        for (let k = 0; k < pieces; k++) {
          const h = 4 + 10 * crng();
          const y0 = top + (floor - h - top) * crng(), y1 = y0 + h;
          const destBottom = ceiling - (5 + 30 * crng() * (k + 1) ** 0.6);
          if (destBottom - h < LIFT_TOP) break;
          windows.push({ y0, y1, dy: y1 - destBottom, kind: crng() < 0.45 ? 'gold' : 'black' });
          ceiling = destBottom - h;
        }
      } else if (eroded && fragments.length < 5) {
        const fh = Math.max(4, Math.min(12, (keepTo - top) * 0.7)), fy = keepTo - 5 - fh - 30 * crng();
        if (fy > LIFT_TOP) fragments.push(rect(a + 0.6, fy, b - 0.6, fy + fh));
      }
      slices.push({ x0: a, x1: b, windows: windows.map(wd => ({ ...wd, y0: snap(wd.y0), y1: wd.dy ? snap(wd.y1) : wd.y1, dy: snap(wd.dy) })) });
    }
    // The ribbons: silver (a few gold), falling from the top edge toward the slices; some step sideways onto the next
    // slice, some are doubled, some end in a short bar.
    for (const [si, sl] of slices.entries()) {
      const count = Math.floor((sl.x1 - sl.x0) / 3) + (crng() < 0.5 ? 1 : 0);
      const highest = Math.min(...sl.windows.map(wd => wd.y0 - wd.dy));
      for (let k = 0; k < count; k++) {
        if (crng() < 0.25) continue;
        const pen: Pen = crng() < 0.2 ? 'gold' : 'silver';
        const xr = sl.x0 + 1.4 + (sl.x1 - sl.x0 - 2.8) * (count === 1 ? 0.5 : k / (count - 1));
        const end = TRIM.y0 + (highest - 6 - TRIM.y0) * (0.3 + 0.7 * crng());
        if (end - TRIM.y0 < 8) continue;
        const kind = crng();
        const next = slices[si + 1];
        if (kind < 0.25 && next) {
          const nextTop = Math.min(...next.windows.map(wd => wd.y0 - wd.dy)) - 6;
          const xs = next.x0 + 1.4 + (next.x1 - next.x0 - 2.8) * crng();
          const yStep = TRIM.y0 + (Math.min(end, nextTop) - TRIM.y0) * (0.25 + 0.4 * crng());
          ribbons.push({ pen, path: [{ x: xr, y: TRIM.y0 - 2 }, { x: xr, y: yStep }, { x: xs, y: yStep }, { x: xs, y: Math.max(yStep + 6, Math.min(end, nextTop)) }] });
        } else if (kind < 0.45) {
          ribbons.push({ pen, path: [{ x: xr - 0.6, y: TRIM.y0 - 2 }, { x: xr - 0.6, y: end }, { x: xr + 0.6, y: end }, { x: xr + 0.6, y: TRIM.y0 - 2 }] });
        } else {
          ribbons.push({ pen, path: [{ x: xr, y: TRIM.y0 - 2 }, { x: xr, y: end }] });
          if (crng() < 0.4) ribbons.push({ pen, path: [{ x: xr - 0.9, y: end + 2 }, { x: xr + 0.9, y: end + 2 }, { x: xr + 0.9, y: end + 6 }, { x: xr - 0.9, y: end + 6 }, { x: xr - 0.9, y: end + 2 }] });
        }
      }
    }
  }

  // ── The black's windows ───────────────────────────────────────────
  // The bar (less the nose, which stands over it), the slices cut onto the gold, the fragments, the shirt and collar.
  const inGoldSlice = (p: Point) => slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1 && sl.windows.some(wd => wd.kind === 'gold' && p.y >= wd.y0 - wd.dy && p.y <= wd.y1 - wd.dy));
  const shirtRings = suit.shirt;
  const windowAt = (p: Point) => (assembled && insideRing(bar, p) && !onNose(p)) || inGoldSlice(p) || fragments.some(f => insideRing(f, p))
    || (shirtRings.some(r => insideRing(r, p)) && !suit.tie.some(r => insideRing(r, p))) || (insideRing(suit.back, p) && !onHead(p));
  const window = traceMask(windowAt, { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, 0.25, { simplify: 0.08, minRadius: 0.5, minArea: 12 });

  return {
    head: seen, onHead, onNose, bar, barTop, slices, fragments, panels: suit.panels, suitLines: suit.lines, bySuit, shirt: shirtRings, collarBack: suit.back, window, ribbons, page,
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
