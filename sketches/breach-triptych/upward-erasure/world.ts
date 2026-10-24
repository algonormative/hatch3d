import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { clipToRect, insideRing, keepAlong, meshCoverage, pathLength, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import { contourLines, isoLines, meshSdf, modelPoint, perVertex, sculptGeometry, toWorld, type IsoLine, type SurfacePoint, type V3 } from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import { traceMask } from '../../kit/outline.ts';
import { clipToTrim, rect, stripeFill } from '../lodestone-cuts.ts';
import { ART, H, MM_X, MM_Y, PAGE, TRIM, W } from '../world.ts';

/**
 * Upward Erasure, the world its sheets share (after the Lodestone character study of 2026-10-21): an androgynous
 * suited figure's head tipped back, seen from below, engraved in fine lines that follow its form, one pink line from
 * the lower lip down the throat; a gold-yellow bar across the eyes, the edge of an erasure field; above it the crown
 * coming apart into vertical slices that rise off the head.
 *
 * Three sheets: the white at the back carries the drawing (the head in Micron 01, the suit in Micron 05 blue, the pink
 * line); the black in front has the bust cut out of it as one window, and the crown's slices as windows above the bar,
 * and silver data ribbons falling from the top edge; the bar and a few fragments are gold-yellow pieces glued on top.
 */

const deg = THREE.MathUtils.degToRad;

/** The pens on the white: the head's lines, the suit, the pink line. */
export type WhitePen = 'carbon' | 'ultramarine' | 'fluoro-pink';

/** A projected, visible mark of the white sheet, and how the thinning ranks it (0 outlines, 1 creases, 2 hatch). */
export interface Seen { pen: WhitePen; rank: number; id: string; piece: Point[] }

/** A slice of the crown: its x range, and the windows it shows (each with the shift its art is drawn at). */
export interface Slice { x0: number; x1: number; windows: { y0: number; y1: number; dy: number }[] }

/** A line of the suit; `behind` the neck (the collar's back), hidden where the neck is. */
export interface SuitLine { pen: WhitePen; path: Point[]; behind?: boolean }

/** A panel of the suit, filled with stripes at `angle`, `pitch` apart, in `pen`. */
export interface Panel { id: string; ring: Point[]; angle: number; pitch: number; pen: WhitePen; cross?: number }

export interface Erasure {
  /** The head's marks, visible, hidden behind nothing but itself; the pink line among them. */
  head: Seen[];
  /** Whether a page point is on the head or neck. */
  onHead: (p: Point) => boolean;
  /** The bar (a quad, clockwise) and the height of its top edge across the sheet. */
  bar: Point[];
  barTop: (x: number) => number;
  slices: Slice[];
  /** The gold-yellow fragments above the bar. */
  fragments: Point[][];
  panels: Panel[];
  /** The suit's outlines and the shirt's lines. */
  suitLines: SuitLine[];
  /** Whether a point is covered by the suit or the shirt's collar (in front of the neck). */
  bySuit: (p: Point) => boolean;
  /** The black's window rings. */
  window: Point[][];
  /** The silver ribbons on the black. */
  ribbons: Point[][];
  /** Page positions of the landmarks. */
  page: { eyes: Point[]; noseTip: Point; chin: Point; neck: { left: Point; right: Point } };
}

// ── Controls ─────────────────────────────────────────────────────────

const slider = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string): Control =>
  ({ type: 'slider', id, label, default: d, min, max, step, group, ...(units ? { units } : {}) });

export const CONTROLS: Control[] = [
  slider('tilt', 'How far the head tips back on the neck', 24, 0, 70, 1, 'Pose', '°'),
  slider('turn', 'How far the head turns on the neck', 6, -40, 40, 1, 'Pose', '°'),
  slider('yaw', 'How far the figure turns from the camera', 48, -90, 90, 1, 'Pose', '°'),
  slider('lookUp', 'Camera look up', 8, 0, 60, 1, 'Camera', '°'),
  slider('headMm', 'Head height on the sheet (chin to crown)', 165, 60, 330, 1, 'Camera', 'mm'),
  slider('crownY', 'Crown height on the sheet', 100, 20, 250, 1, 'Camera', 'mm'),
  slider('headX', 'Head centre across the sheet', 140, 40, 240, 1, 'Camera', 'mm'),
  slider('collarAt', 'Where the collar meets the neck (head units below the ears)', 0.72, 0.4, 1.6, 0.01, 'Suit'),
  slider('pitch', 'Densest engraving pitch (head units)', 0.0034, 0.002, 0.01, 0.0001, 'Lines'),
  slider('step', 'Mesh cell (head units)', 0.009, 0.004, 0.03, 0.001, 'Lines'),
  slider('barMm', 'Bar height', 28, 16, 60, 0.5, 'Bar', 'mm'),
  slider('barTilt', 'Bar tilt (down to the right)', 9, -20, 25, 0.5, 'Bar', '°'),
  slider('erosion', 'How much of the crown comes away', 0.6, 0, 1, 0.01, 'Crown'),
  { type: 'select', id: 'view', label: 'What to draw', default: 'assembly', options: ['assembly', 'head'],
    optionLabels: { assembly: 'The sheet as cut', head: 'The head alone (no bar, no erasure)' }, group: 'Crown' },
];

// ── The head ─────────────────────────────────────────────────────────

/** Where the crown begins: the head's own height (units above the ears) above which the erasure takes it. */
const CROWN = 0.2;

/** The jaw: below this height of the head (its mouth's corners) a surface turned down is the jaw's underside. */
const JAW = -0.3;

/** Which family of lines a point of the head takes. */
type Zone = 'face' | 'under' | 'ear' | 'neck' | 'crown';

interface Mark { points: THREE.Vector3[]; pen: WhitePen; rank: number; id: string }

export function erasure(ctx: SketchContext): Erasure {
  const S = 100;
  const head = sculptHead({ tilt: deg(n(ctx, 'tilt', 24, 0, 70)), turn: deg(n(ctx, 'turn', 6, -40, 40)), neck: 1.6 });
  const transform = new THREE.Matrix4().makeRotationY(deg(n(ctx, 'yaw', 48, -90, 90))).multiply(new THREE.Matrix4().makeScale(S, S, S));
  const mesh = meshSdf(head.sdf, head.lo, head.hi, n(ctx, 'step', 0.009, 0.004, 0.03), transform);
  const toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const isHead = (p: V3) => head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p);

  // The camera below the chin, looking up; its field of view and offset fitted so the head (chin to crown) is `headMm`
  // tall on the sheet, its crown at `crownY` and its middle at `headX`.
  const target = toW(head.at.chinUnder).lerp(toW(head.at.neckBase), 0.4);
  const D = 8 * S, lookUp = deg(n(ctx, 'lookUp', 8, 0, 60));
  const sample: THREE.Vector3[] = [];
  for (let v = 0; v < mesh.pos.length; v += 3 * 29) { const p: V3 = [mesh.pos[v], mesh.pos[v + 1], mesh.pos[v + 2]]; if (isHead(p)) sample.push(toW(p)); }
  const want = { h: n(ctx, 'headMm', 165, 60, 330), top: n(ctx, 'crownY', 100, 20, 250), x: n(ctx, 'headX', 140, 40, 240) };
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
  const eyeM = modelPoint(mesh, view.position);

  // Light from above and a little ahead of the face: the face, turned up into it, is bare; the jaw's underside and the
  // throat are dense. Every fourth line of a family is drawn wherever there is any darkness, every second from
  // `TH[1]`, all from `TH[2]`.
  const light = new THREE.Vector3(0.35, 1, 0.55).normalize();
  const darkness = (sp: SurfacePoint) => 1 - Math.max(0, new THREE.Vector3(...sp.n).transformDirection(transform).dot(light)) ** 0.8;
  const TH = [0.08, 0.38, 0.62];
  const tier = (i: number) => (i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2);
  const ear = head.at.ears[1];
  /** How steeply a point's surface faces down, in the head's own frame (its normal's y there). */
  const headNy = (p: V3, nv: V3) => { const q = head.unplace(...p), q2 = head.unplace(p[0] + nv[0] * 0.01, p[1] + nv[1] * 0.01, p[2] + nv[2] * 0.01); return (q2[1] - q[1]) / 0.01; };
  // Lines stop a little short of the crease where the jaw meets the neck (drawn as a line of its own), from both sides:
  // the jaw's level slices hook as they bend into it.
  const zoneOf = (sp: SurfacePoint): Zone | undefined => {
    const seam = head.parts.head(...head.unplace(...sp.p)) - head.parts.neck(...sp.p);
    if (seam > 0.004) return 'neck';
    if (seam > -0.01) return undefined;
    if (Math.hypot(sp.p[0] - ear[0], sp.p[1] - ear[1], sp.p[2] - ear[2]) < 0.12) return 'ear';
    const y = head.unplace(...sp.p)[1];
    if (y > CROWN) return 'crown';
    return y < JAW && headNy(sp.p, sp.n) < -0.35 ? 'under' : 'face';
  };
  // A point turned away from the eye is never seen on a closed solid: where a fold puts one within the depth test's
  // slack of the surface in front (grazing the cheek, say), it would show through.
  const facing = (sp: SurfacePoint) => sp.n[0] * (eyeM[0] - sp.p[0]) + sp.n[1] * (eyeM[1] - sp.p[1]) + sp.n[2] * (eyeM[2] - sp.p[2]) > 0;
  const marks: Mark[] = [];
  const family = (zone: Zone, lines: IsoLine[], id: string, toned = true) => {
    for (const l of lines) {
      const t = tier(Math.abs(l.index));
      let run: SurfacePoint[] = [];
      const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), pen: 'carbon', rank: 2, id }); run = []; };
      for (const sp of l.points) if (facing(sp) && zoneOf(sp) === zone && (!toned || darkness(sp) >= TH[t])) run.push(sp); else flush();
      flush();
    }
  };
  const hq = (fn: (q: V3) => number) => perVertex(mesh, p => fn(head.unplace(...p)));
  const pitch = n(ctx, 'pitch', 0.0034, 0.002, 0.01);
  // Down the face, lines in planes along it (they draw its profile again and again); under the jaw, level planes of the
  // head (lines along the jaw's edge); the ear, one spiral; down the neck, lines along it. Above the brow, the crown
  // the erasure takes apart: level slices of the head at their full density whatever the light, nested contours
  // that read as the data it is made of.
  family('face', isoLines(mesh, hq(q => q[0]), pitch), 'face');
  family('under', isoLines(mesh, hq(q => q[1]), pitch * 1.1), 'under');
  family('crown', isoLines(mesh, hq(q => q[1]), pitch * 1.25), 'crown', false);
  const earQ = head.unplace(...ear), turn = pitch * 1.4;
  const spiral = { values: hq(q => Math.atan2(q[1] - earQ[1], q[2] - earQ[2])), period: 2 * Math.PI };
  family('ear', isoLines(mesh, hq(q => Math.hypot(q[1] - earQ[1], q[2] - earQ[2]) / turn * 2 * Math.PI), 2 * Math.PI, 0, undefined, spiral), 'ear', false);
  family('neck', isoLines(mesh, perVertex(mesh, p => Math.atan2(p[0], p[2] + 0.03)), pitch / 0.15), 'neck');
  // The silhouette, and the creases: the jaw's edge (where the face turns under) and the line the jaw meets the neck.
  for (const l of contourLines(mesh, eyeM)) marks.push({ points: toWorld(mesh, l.points), pen: 'carbon', rank: 0, id: 'outline' });
  const jawEdge = perVertex(mesh, (p, nv) => (isHead(p) && head.unplace(...p)[1] < JAW ? headNy(p, nv) : 1));
  for (const l of isoLines(mesh, jawEdge, 1, 0, [-0.35])) {
    const keep = l.points.filter(sp => zoneOf(sp) !== 'ear');
    if (keep.length >= 2) marks.push({ points: toWorld(mesh, keep), pen: 'carbon', rank: 1, id: 'crease' });
  }
  const seam = perVertex(mesh, p => head.parts.head(...head.unplace(...p)) - head.parts.neck(...p));
  for (const l of isoLines(mesh, seam, 1, 0, [0.004])) marks.push({ points: toWorld(mesh, l.points), pen: 'carbon', rank: 1, id: 'crease' });
  // The nostrils, dark: rings round each, closer toward its middle.
  for (const c of head.at.nostrils) {
    const dist = perVertex(mesh, p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    for (const l of isoLines(mesh, dist, 1, 0, [0.006, 0.01, 0.014, 0.018, 0.022])) marks.push({ points: toWorld(mesh, l.points), pen: 'carbon', rank: 1, id: 'nostril' });
  }
  // The lips' parting.
  for (const l of isoLines(mesh, hq(q => q[1]), 1, 0, [-0.256])) {
    const keep = l.points.filter(sp => { const q = head.unplace(...sp.p); return Math.abs(q[0]) < 0.068 && q[2] > 0.3; });
    if (keep.length >= 2) marks.push({ points: toWorld(mesh, keep), pen: 'carbon', rank: 1, id: 'crease' });
  }
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
  // Where the collar meets the neck: the neck's two sides on the sheet at that height.
  const collarY = -n(ctx, 'collarAt', 0.72, 0.4, 1.6);
  const ring: Point[] = [];
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; ring.push(at([0.15 * Math.sin(a), collarY, -0.04 + 0.15 * Math.cos(a)])); }
  const left = ring.reduce((a, b) => (b.x < a.x ? b : a)), right = ring.reduce((a, b) => (b.x > a.x ? b : a));
  const suit = suitOf(left, right);
  const bySuit = (p: Point) => suit.front.some(r => insideRing(r, p));

  const page = {
    eyes: head.at.eyes.map(at), noseTip: at(head.at.noseTip), chin: at(head.at.chin), neck: { left, right },
  };

  // ── The bar, and the crown above it ───────────────────────────────
  const assembled = ctx.params.view !== 'head';
  const barH = n(ctx, 'barMm', 28, 16, 60), tilt = deg(n(ctx, 'barTilt', 9, -20, 25));
  const dir = { x: Math.cos(tilt), y: Math.sin(tilt) }, nrm = { x: -dir.y, y: dir.x };
  // Over the nearer eye (it sits in the bar's upper part, so the brow and the crown show above), from off the left edge
  // to short of the nose's tip.
  const nearer = head.at.eyes.map(toW).map(p => p.distanceTo(view.position));
  const eyeAt = page.eyes[nearer[0] < nearer[1] ? 0 : 1];
  const eyeMid = { x: eyeAt.x, y: eyeAt.y + 0.22 * barH };
  const along = (p: Point) => (p.x - eyeMid.x) * dir.x + (p.y - eyeMid.y) * dir.y;
  const s0 = along({ x: TRIM.x0 - 8, y: eyeMid.y }), s1 = along(page.noseTip) - 3;
  const corner = (s: number, o: number): Point => ({ x: eyeMid.x + dir.x * s + nrm.x * o, y: eyeMid.y + dir.y * s + nrm.y * o });
  const bar = clipToTrim([corner(s0, -barH / 2), corner(s1, -barH / 2), corner(s1, barH / 2), corner(s0, barH / 2)]);
  const barTop = (x: number) => eyeMid.y + (x - eyeMid.x) * Math.tan(tilt) - barH / 2 / Math.cos(tilt);

  // The crown's slices: across the head where it rises above the bar, seeded widths of 4 to 13 mm. Each keeps a base
  // that steps down the skull's curve, and may lose its top: left as black (erased), or lifted off the head and drawn
  // higher up the sheet (once or twice, each piece smaller and higher), or (a few) replaced by a gold-yellow fragment.
  const rng = ctx.random('erasure-crown');
  const erosion = n(ctx, 'erosion', 0.6, 0, 1);
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
  const ribbons: Point[][] = [];
  const LIFT_TOP = TRIM.y0 + 12;
  // Heights on a 1.5 mm grid: neighbouring slices' steps are then either level or a knife's step apart, never a hair.
  const snap = (y: number) => Math.round(y / 1.5) * 1.5;
  if (assembled && cx0 < cx1) {
    let x = cx0;
    while (x < cx1 - 2) {
      const w = Math.min(cx1 - x, 4 + 9 * rng() ** 1.4);
      if (w < 4) break;
      const a = x, b = x + w;
      x = b;
      let top = -Infinity;
      for (let t = a; t <= b; t += 0.5) top = Math.max(top, headTop(t));
      const bottom = Math.max(barTop(a), barTop(b)) + 4;
      const height = barTop((a + b) / 2) - top;
      if (height < 6) { slices.push({ x0: a, x1: b, windows: [{ y0: snap(top), y1: bottom, dy: 0 }] }); continue; }
      // How much of the slice stays on the head (a base from the bar up), and what becomes of the rest: lifted off and
      // drawn higher up the sheet in one to three pieces, each a little further from the last; left black; or (a few)
      // a gold-yellow fragment of the bar in its place.
      const eroded = rng() < erosion;
      const keepTo = eroded ? top + height * (0.3 + 0.5 * rng()) : top + height * 0.1 * rng();
      const windows = [{ y0: keepTo, y1: bottom, dy: 0 }];
      const fate = rng();
      if (eroded && fate < 0.62) {
        // Each piece is a few millimetres of the slice from anywhere on the head above the bar's lower edge (the
        // forehead under the bar too), drawn further up the sheet than the last, the gaps opening as they rise.
        const floor = Math.min(barTop(a), barTop(b)) + barH * 0.9;
        let ceiling = keepTo;
        const pieces = 1 + Math.floor(3 * rng());
        for (let k = 0; k < pieces; k++) {
          const h = 4 + 8 * rng();
          const y0 = top + (floor - h - top) * rng(), y1 = y0 + h;
          const destBottom = ceiling - (5 + 26 * rng() * (k + 1) ** 0.7);
          if (destBottom - h < LIFT_TOP) break;
          windows.push({ y0, y1, dy: y1 - destBottom });
          ceiling = destBottom - h;
        }
      } else if (eroded && (fate < 0.82 || (fragments.length < 2 && x > (cx0 + cx1) / 2)) && fragments.length < 4) {
        const fh = Math.max(4, Math.min(12, (keepTo - top) * 0.7)), fy = keepTo - 5 - fh - 14 * rng();
        if (fy > LIFT_TOP) fragments.push(rect(a + 0.6, fy, b - 0.6, fy + fh));
      }
      slices.push({ x0: a, x1: b, windows: windows.map(wd => ({ y0: snap(wd.y0), y1: wd.dy ? snap(wd.y1) : wd.y1, dy: snap(wd.dy) })) });
    }
    // The ribbons: silver, falling from the top edge toward the slices, a few over each; some step sideways partway
    // down (onto the next slice's line), some are doubled (two lines 1.2 mm apart, closed at the foot), some end in a
    // short bar.
    for (const [si, sl] of slices.entries()) {
      const count = Math.floor((sl.x1 - sl.x0) / 3.5) + (rng() < 0.5 ? 1 : 0);
      const highest = Math.min(...sl.windows.map(wd => wd.y0 - wd.dy));
      for (let k = 0; k < count; k++) {
        if (rng() < 0.3) continue;
        const xr = sl.x0 + 1.4 + (sl.x1 - sl.x0 - 2.8) * (count === 1 ? 0.5 : k / (count - 1));
        const end = TRIM.y0 + (highest - 6 - TRIM.y0) * (0.3 + 0.7 * rng());
        if (end - TRIM.y0 < 8) continue;
        const kind = rng();
        const next = slices[si + 1];
        if (kind < 0.25 && next) {
          // Stepped: down to a seeded height, across to the next slice, and on down there (short of its own top).
          const nextTop = Math.min(...next.windows.map(wd => wd.y0 - wd.dy)) - 6;
          const xs = next.x0 + 1.4 + (next.x1 - next.x0 - 2.8) * rng();
          const yStep = TRIM.y0 + (Math.min(end, nextTop) - TRIM.y0) * (0.25 + 0.4 * rng());
          ribbons.push([{ x: xr, y: TRIM.y0 - 2 }, { x: xr, y: yStep }, { x: xs, y: yStep }, { x: xs, y: Math.max(yStep + 6, Math.min(end, nextTop)) }]);
        } else if (kind < 0.45) {
          ribbons.push([{ x: xr - 0.6, y: TRIM.y0 - 2 }, { x: xr - 0.6, y: end }, { x: xr + 0.6, y: end }, { x: xr + 0.6, y: TRIM.y0 - 2 }]);
        } else {
          ribbons.push([{ x: xr, y: TRIM.y0 - 2 }, { x: xr, y: end }]);
          if (rng() < 0.4) ribbons.push([{ x: xr - 0.9, y: end + 2 }, { x: xr + 0.9, y: end + 2 }, { x: xr + 0.9, y: end + 6 }, { x: xr - 0.9, y: end + 6 }, { x: xr - 0.9, y: end + 2 }]);
        }
      }
    }
  }

  // ── The black's window ────────────────────────────────────────────
  // The bust (head, neck, collar and suit) below a line inside the bar (the onlay covers the line), and the slices'
  // windows above it.
  const inSlices = (p: Point) => slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1 && sl.windows.some(wd => p.y >= wd.y0 - wd.dy && p.y <= wd.y1 - wd.dy));
  const below = (p: Point) => !assembled || p.y > barTop(p.x) + 4;
  const bust = (p: Point) => onHead(p) || suit.all.some(r => insideRing(r, p));
  const window = traceMask(p => (below(p) && bust(p)) || inSlices(p), { x0: TRIM.x0 + 0.2, x1: TRIM.x1 - 0.2, y0: TRIM.y0 + 0.2, y1: TRIM.y1 - 0.2 }, 0.25, { simplify: 0.08, minRadius: 0.5, minArea: 30 });

  return {
    head: seen, onHead, bar, barTop, slices, fragments, panels: suit.panels, suitLines: suit.lines, bySuit, window, ribbons, page,
  };
}

// ── The suit, flat on the sheet ──────────────────────────────────────

/**
 * The suit as flat panels laid out from the neck's two sides where the collar meets it (its width `w` the unit): the
 * shirt's collar standing round the neck (its back seen behind the neck, its two leaves in front, meeting at the tie's
 * knot), the shirt, the tie, the lapels and the jacket off both edges of the sheet. Each jacket panel is striped along
 * its lapel's edge, the tie across.
 */
function suitOf(left: Point, right: Point): { panels: Panel[]; lines: SuitLine[]; front: Point[][]; all: Point[][] } {
  const c = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, w = right.x - left.x;
  // The neck leans: the collar follows the line between its sides.
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
  const panels: Panel[] = [
    { id: 'jacket-l', ring: jacketL, angle: angleOf(P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }), pitch: 0.8, pen: 'ultramarine', cross: angleOf(P(-1.1, 0.98), { x: P(-0.42, 0).x, y: bottom }) + 0.8 },
    { id: 'jacket-r', ring: jacketR, angle: angleOf(P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom }), pitch: 0.8, pen: 'ultramarine', cross: angleOf(P(1.04, 0.9), { x: P(0.62, 0).x, y: bottom }) - 0.8 },
    { id: 'lapel-l', ring: lapelL, angle: angleOf(P(-1.28, 0.78), { x: P(-0.42, 0).x, y: bottom }) + 0.12, pitch: 0.72, pen: 'ultramarine' },
    { id: 'lapel-r', ring: lapelR, angle: angleOf(P(1.2, 0.7), { x: P(0.62, 0).x, y: bottom }) - 0.12, pitch: 0.72, pen: 'ultramarine' },
    { id: 'tie', ring: [...blade], angle: -0.7, pitch: 0.75, pen: 'ultramarine', cross: 0.7 },
    { id: 'knot', ring: knot, angle: 0.5, pitch: 0.7, pen: 'ultramarine', cross: -0.9 },
  ];
  const close = (r: Point[]) => [...r, r[0]];
  const lines: SuitLine[] = [
    ...[leafL, leafR].map(r => ({ pen: 'carbon' as const, path: close(r) })),
    { pen: 'carbon' as const, path: close(back), behind: true },
    ...[lapelL, lapelR, knot, blade].map(r => ({ pen: 'ultramarine' as const, path: close(r) })),
    // The shirt's shading under each leaf of the collar: a few fine lines along it.
    ...[0.06, 0.12, 0.18].flatMap(d => [
      [P(-0.34 + d, 1.0 + d * 0.4), P(-0.1 + d * 0.3, 0.64 + d)],
      [P(0.44 - d, 0.96 + d * 0.4), P(0.12 - d * 0.3, 0.62 + d)],
    ]).map(path => ({ pen: 'carbon' as const, path })),
  ];
  return { panels, lines, front: [leafL, leafR, knot, blade, shirt, lapelL, lapelR, jacketL, jacketR], all: [leafL, leafR, back, knot, blade, shirt, lapelL, lapelR, jacketL, jacketR] };
}

/** A panel's stripes (and its cross stripes), clipped to the panel and the trim. */
export function panelStripes(p: Panel, clip: Rect = ART): Point[][] {
  const out = stripeFill(p.ring, p.angle, p.pitch, 0);
  if (p.cross !== undefined) out.push(...stripeFill(p.ring, p.cross, p.pitch * 1.6, 0));
  return out.flatMap(path => clipToRect(path, clip)).flatMap(path => keepAlong(path, q => insideRing(p.ring, q), 0.2));
}
