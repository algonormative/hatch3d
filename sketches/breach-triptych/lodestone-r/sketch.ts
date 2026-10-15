import * as THREE from 'three';
import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { HEM, agentFigure, cutTube, headCoil, uNear, type AgentHead } from '../../kit/agent.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, onGround, pageOf } from '../../kit/perspective.ts';
import { insideRing } from '../../kit/page.ts';
import { cutSchemeOf, floorKind, hasPortal, inGrown, rCuts, stripeFill } from '../lodestone-cuts.ts';
import { facetStrokes, slabGeometry, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { LOOK, toneField, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import type { JointAngles, JointName, Proportions } from '../../kit/mannequin/skeleton.ts';
import { HEMS, pinstripeTube, suitFront } from '../../kit/mannequin/suit.ts';
import { Tube, silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { ART, H, MM_X, MM_Y, PAGE, PAPER, THREAD, TRIM, W, bustFrame, flatRibbon, lintelBar, pensOf, smoothPath, type RibbonStroke } from '../world.ts';
import { FILL_OVER, LENS, LODESTONE_ASSEMBLY, LODESTONE_CONTROLS, cosmos, eyeCentre, faceMarks, faceOutline, fieldLines, fieldPull, gapOf, lensCamera, lensImage, lensShift, rEntries, seenBy, EMPHASIS, emphasisOn, frameBand, frameRings, outwardDouble, spacer, suitFrontOutlines, magnet, orientedSlab, slabHand, wordAlong } from '../lodestone-world.ts';

/**
 * Lodestone, panel R: the ground. A suited figure with the helix coiled where its head would be kneels on white,
 * three-quarters turned toward the centre panel. The magnet's field lines come in at R's left edge at the heights they
 * left C's right edge; the figure gathers them in its hands and leads them down into a black disc on the floor, a
 * curved cut in the white sheet over a black one, so the alignment doesn't lock everything. One strand is fluorescent
 * pink: the triptych's one shock. Two plies, bottom to top: black, white. With `figureField` the field reaches R too and
 * pulls at the figure toward C: the head leans and unwinds, the torso with it, the strands bow toward C as they fall,
 * while the knees hold their ground. `figure` = `clean` draws a straighter figure with a stacked-ring head instead.
 */

const plies = [
  { id: 'black', paper: PAPER.black, pens: ['silver', 'fluoro-pink'], cutInk: 'silver' },
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine', 'fluoro-pink'], cutInk: 'carbon' },
];
/** The signature: carbon, in a box at the foot of the sheet, right of the figure. */
const SIGNATURE = { ply: 'white', pen: 'carbon', box: { x: 222, y: 394, width: 40, height: 12 } };
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies, signature: SIGNATURE };
const pens = pensOf(['silver', 'fluoro-pink', 'carbon', 'ultramarine']);

/**
 * White: the suit in carbon and ultramarine (its violet accent and vermilion edges to carbon, acid detail to
 * ultramarine), the strands in ultramarine, the pink one (`vermilion` here) in fluoro pink. Black, seen through the
 * disc: the same marks in silver, the pink strand in pink, and the ground rings.
 */
const ROUTES = {
  black: { groups: ['under', 'rings', 'ribbonunder', 'emphunder'], inks: { carbon: 'silver', ultramarine: 'silver', violet: 'silver', acid: 'silver', vermilion: 'silver' } },
  white: { groups: ['figure', 'contour', 'helix', 'hand', 'word', 'ribbon', 'emph'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon', acid: 'ultramarine', vermilion: 'carbon' } },
};
/** The strands' pens: blue ones ultramarine on white and silver on black; the pink one (`vermilion`) pink on both. */
const STRAND_PEN = { white: { ultramarine: 'ultramarine', vermilion: 'fluoro-pink' }, black: { ultramarine: 'silver', vermilion: 'fluoro-pink' } } as const;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['figure', 'contour', 'helix', 'hand', 'strand', 'word', 'ribbon', 'under', 'strandunder', 'ribbonunder', 'rings', 'emph', 'emphunder'] as const;

/** The kneeling pose: the kit's kneel, the arms raised forward to gather at head height, the head bowed to its hands. */
// Each upper arm forward and up, turned in so the bent forearms come across: the two hands meet before the chest.
const KNEEL: Partial<Record<JointName, JointAngles>> = {
  shoulder_l: { flex: 112, abduct: 0, twist: -84 }, elbow_l: { flex: 84 },
  shoulder_r: { flex: 104, abduct: 0, twist: 92 }, elbow_r: { flex: 88 },
  wrist_l: { flex: 0 }, wrist_r: { flex: 0 },
  neck: { flex: 14 }, head: { flex: 8 },
};
const BROAD: Proportions = { shoulderX: 1.22, hipX: 1.1 };
/** World units per canon unit: the suit's stripes land about 1.7 mm apart on the sheet. */
const K = 4;
/** How far the field pulls the crown of the figure toward C (mm; the head half again), and how far it bows the falling strands. */
const PULL_MM = 20, BOW_MM = 16;

/**
 * The clean figure's head: a stack of five flat ring bands round the head's axis, an egg in profile, each a short smooth
 * tube tipped a little off the last, like a coiled spring of flat band.
 */
function ringHead(h: AgentHead): Tube[] {
  const bands: Tube[] = [];
  const N = 5, bh = 0.24 * h.r, gap = 0.1 * h.r;
  for (let i = 0; i < N; i++) {
    const along = (-0.72 + i * (bh + gap) / h.r) * h.r + bh / 2;
    const egg = Math.sqrt(Math.max(0.12, 1 - (along / (1.15 * h.r)) ** 2)) * (along > 0 ? 1 : 0.9 + 0.1 * (1 + along / h.r));
    const R = 0.92 * egg * h.r;
    const a = h.axis.clone().applyAxisAngle(h.side, (i % 2 ? 1 : -1) * 0.07).normalize();
    const c = h.centre.clone().addScaledVector(h.axis, along);
    bands.push(new Tube(`ring${i}`, [c.clone().addScaledVector(a, -bh / 2), c.clone().addScaledVector(a, bh / 2)], [[0, R, R], [1, R, R]], h.face, 1, [0, 0]));
  }
  return bands;
}

type Tagged = Stroke & { slack: number };

/** An egg inside the head's coil, never drawn: it hides the coil's far side. */
function skull(h: AgentHead): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 18);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(h.side, h.axis, h.face).multiply(new THREE.Matrix4().makeScale(0.52 * h.r, 0.66 * h.r, 0.52 * h.r)));
  g.translate(h.centre.x, h.centre.y, h.centre.z);
  return g;
}

/** A cut sleeve or trouser for the depth pass: its surface and a disc closing the end. */
function cutMeshes(t: Tube): THREE.BufferGeometry[] {
  const segs = t.facets >= 3 ? t.facets * 4 : 32;
  return [t.mesh(96, segs), buildSurfaceMesh((u, v) => t.centre(1).lerp(t.point(1, v), u), {}, 2, segs)];
}

/** A convex-or-not polygon clipped to a rectangle (Sutherland–Hodgman). */
function clipPolygon(poly: Point[], r: { x0: number; x1: number; y0: number; y1: number }): Point[] {
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [p => p.x >= r.x0, (a, b) => ({ x: r.x0, y: a.y + (b.y - a.y) * (r.x0 - a.x) / (b.x - a.x) })],
    [p => p.x <= r.x1, (a, b) => ({ x: r.x1, y: a.y + (b.y - a.y) * (r.x1 - a.x) / (b.x - a.x) })],
    [p => p.y >= r.y0, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y0 - a.y) / (b.y - a.y), y: r.y0 })],
    [p => p.y <= r.y1, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y1 - a.y) / (b.y - a.y), y: r.y1 })],
  ];
  let out = poly;
  for (const [inside, cross] of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      if (inside(b)) { if (!inside(a)) out.push(cross(a, b)); out.push(b); } else if (inside(a)) out.push(cross(a, b));
    }
  }
  return out;
}

/**
 * `rOut` ribbon: where the portal stands (its middle, mm in from R's left trim), how long the lines take to ravel into
 * the ribbon after it (mm along), and the dashes the lines come in as across the bare paper before it (dash, gap,
 * how far each is set off its line, mm).
 */
const RAVEL = { portalAt: 16, length: 55, dash: 1.6, gap: 1.1, loose: 0.4 };

/**
 * The strands out of the portal ravelled back into a ribbon. Each strand comes in across the bare paper before the
 * portal as short dashes, a little loose, so a few millimetres' misalignment with C's lines reads as natural; passes
 * the portal as it is; and from the portal's far edge its line draws in, over RAVEL.length, to its place across a
 * twisting ribbon (its edges, laminations and spine, the pink strand its +1 edge), which runs on along the middle
 * strand's course to the hands and down to the floor, `widen` times the thread's width (R9: twice, `rRibbonWidth`; its
 * laminations as many times over). Returns the strands cut short after the ravel (in place), the
 * dashes, the lines' whole courses in to the portal (`entries`), the ribbon (flatRibbon's strokes: its first two the -1
 * and +1 edges) and its centreline.
 */
function ravel(strands: { path: Point[]; ink: Ink }[], portal: Point[], pink: number, widen = 1): { dashes: { path: Point[]; ink: Ink }[]; entries: { path: Point[]; ink: Ink }[]; ribbon: { strokes: RibbonStroke[]; mask: Point[][] }; centre: Point[] } | undefined {
  const cut = strands.map(st => { const inside = st.path.map(q => insideRing(portal, q)); return { i0: inside.indexOf(true), i1: inside.lastIndexOf(true) }; });
  if (cut.some(c => c.i0 < 1 || c.i1 < c.i0 || c.i1 >= strands[0].path.length - 2)) return undefined;
  const mid = Math.floor(strands.length / 2);
  const exits = strands.map((st, k) => st.path[cut[k].i1 + 1]);
  const ec = { x: exits.reduce((t, q) => t + q.x, 0) / exits.length, y: exits.reduce((t, q) => t + q.y, 0) / exits.length };
  // The centreline: the middle strand's course on from the portal, eased from the middle of the exits onto it.
  const guide = strands[mid].path.slice(cut[mid].i1 + 1), gs = lengths(guide);
  const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const centre = guide.map((q, i) => { const w = 1 - smooth(0, RAVEL.length, gs[i]); return { x: q.x + (ec.x - guide[0].x) * w, y: q.y + (ec.y - guide[0].y) * w }; });
  const cs = lengths(centre);
  const normal = centre.map((_, i) => { const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)], d = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }; });
  const half = widen * THREAD.widthMm / 2;
  let phase = 0;
  const cosPhase = centre.map((_, i) => { if (i) phase += 2 * Math.PI * (cs[i] - cs[i - 1]) / THREAD.pitchMm; return Math.cos(phase); });
  // Each strand's place across the ribbon: in order of where it leaves the portal, the pink strand on the +1 edge.
  const start = exits.map(q => (q.x - centre[0].x) * normal[0].x + (q.y - centre[0].y) * normal[0].y);
  const order = strands.map((_, k) => k).sort((a, b) => start[a] - start[b]);
  const target = new Array<number>(strands.length);
  order.forEach((k, j) => { target[k] = strands.length > 1 ? -1 + 2 * j / (strands.length - 1) : 0; });
  const swap = target.indexOf(1);
  if (swap >= 0 && swap !== pink) [target[swap], target[pink]] = [target[pink], 1];
  const iR = Math.max(1, cs.findIndex(v => v >= RAVEL.length));
  const dashes: { path: Point[]; ink: Ink }[] = [], entries: { path: Point[]; ink: Ink }[] = [];
  strands.forEach((st, k) => {
    // In as dashes across the bare paper to the portal.
    const entry = st.path.slice(0, cut[k].i0 + 1), es = lengths(entry);
    entries.push({ ink: st.ink, path: entry });
    for (let a = 0, n = 0; a < es.at(-1)!; a += RAVEL.dash + RAVEL.gap, n++) {
      const pts = entry.filter((_, i) => es[i] >= a && es[i] <= a + RAVEL.dash);
      if (pts.length < 2) continue;
      const d = (n % 2 ? 1 : -1) * RAVEL.loose, q0 = pts[0], q1 = pts[pts.length - 1], l = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
      dashes.push({ ink: st.ink, path: pts.map(q => ({ x: q.x - (q1.y - q0.y) / l * d, y: q.y + (q1.x - q0.x) / l * d })) });
    }
    // Through the portal as it is, then drawing in to its place across the ribbon.
    const ravelled: Point[] = [];
    for (let i = 0; i <= iR; i++) {
      const u = smooth(0, RAVEL.length, cs[i]), o = (1 - u) * start[k] + u * target[k] * half * cosPhase[i];
      ravelled.push({ x: centre[i].x + normal[i].x * o, y: centre[i].y + normal[i].y * o });
    }
    st.path = [...st.path.slice(cut[k].i0, cut[k].i1 + 1), ...ravelled];
  });
  const ribbon = flatRibbon(centre.slice(iR), { width: widen * THREAD.widthMm, pitch: THREAD.pitchMm, laminations: Math.round(6 * widen), phase0: 2 * Math.PI * cs[iR] / THREAD.pitchMm });
  return { dashes, entries, ribbon, centre };
}

/** Arc lengths along a page path. */
const lengths = (path: Point[]): number[] => { const s = [0]; for (let i = 1; i < path.length; i++) s.push(s[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)); return s; };
/** Where segment p0-p1 meets segment q0-q1, as the fraction along q, or undefined. */
function meetAlong(p0: Point, p1: Point, q0: Point, q1: Point): number | undefined {
  const rx = p1.x - p0.x, ry = p1.y - p0.y, sx = q1.x - q0.x, sy = q1.y - q0.y, d = rx * sy - ry * sx;
  if (Math.abs(d) < 1e-12) return undefined;
  const t = ((q0.x - p0.x) * sy - (q0.y - p0.y) * sx) / d, u = ((q0.x - p0.x) * ry - (q0.y - p0.y) * rx) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : undefined;
}

/** How far a line through the portal is moved along it (`refract`), and how far before and after it the lines ease into and out of their aligned course (`align`), mm. */
const PORTAL = { shift: 6, relax: 34, ease: 16, at: 0.35, thick: 12, margin: 7 };

/**
 * The portal: a rectangle across the incoming strands where they cross x = `x` (PORTAL.at of the way from R's left
 * edge to the hands), square to their mean course, PORTAL.thick along it and spanning them all with PORTAL.margin to
 * spare either side. Corners: the near edge (that the strands come in through) then the far edge, end to end.
 */
function portalBand(paths: Point[][], x: number): Point[] | undefined {
  const at: { p: Point; t: Point }[] = [];
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) { const f = (x - a.x) / (b.x - a.x), l = Math.hypot(b.x - a.x, b.y - a.y) || 1; at.push({ p: { x, y: a.y + (b.y - a.y) * f }, t: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } }); break; }
  }
  if (at.length < 2) return undefined;
  const c = { x: at.reduce((s, q) => s + q.p.x, 0) / at.length, y: at.reduce((s, q) => s + q.p.y, 0) / at.length };
  const tx = at.reduce((s, q) => s + q.t.x, 0), ty = at.reduce((s, q) => s + q.t.y, 0), tl = Math.hypot(tx, ty) || 1, t = { x: tx / tl, y: ty / tl }, e = { x: -t.y, y: t.x };
  const offs = at.map(q => (q.p.x - c.x) * e.x + (q.p.y - c.y) * e.y), lo = Math.min(...offs) - PORTAL.margin, hi = Math.max(...offs) + PORTAL.margin, h = PORTAL.thick / 2;
  const P = (along: number, across: number): Point => ({ x: c.x + t.x * along + e.x * across, y: c.y + t.y * along + e.y * across });
  return [P(-h, lo), P(-h, hi), P(h, hi), P(h, lo)];
}

/**
 * A strand through the portal, a four-sided band (`portalBand`: its near edge, corners 0 and 1, faces the strands as they
 * come in; its far edge, corners 3 and 2, lets them out). `refract`: as through a block of glass, the line runs
 * straight across the band to a point PORTAL.shift along its far edge, and comes out parallel to its course but moved
 * by that much, which eases off over PORTAL.relax. `align`: inside the band the lines run straight across it, square
 * to its outer edge, evenly spaced along it (the `k`-th of `n`), the field ruled into line; they ease into that course
 * over PORTAL.ease before the band and back to their own over PORTAL.relax after it. `none`: as it is.
 */
function throughPortal(path: Point[], portal: Point[], mode: string, k: number, n: number): Point[] {
  if (mode === 'none') return path;
  const inside = path.map(q => insideRing(portal, q));
  const i0 = inside.indexOf(true), i1 = inside.lastIndexOf(true);
  if (i0 < 1 || i1 <= i0 || i1 >= path.length - 1) return path;
  const s = lengths(path);
  const [o0, o1, n1, n0] = portal;
  const len = Math.hypot(o1.x - o0.x, o1.y - o0.y), e = { x: (o1.x - o0.x) / len, y: (o1.y - o0.y) / len };
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (mode === 'refract') {
    const a = path[i0], b = path[i1], d = { x: e.x * PORTAL.shift, y: e.y * PORTAL.shift };
    const out: Point[] = path.slice(0, i0);
    for (let i = i0; i <= i1; i++) { const f = (s[i] - s[i0]) / (s[i1] - s[i0]); out.push({ x: a.x + (b.x + d.x - a.x) * f, y: a.y + (b.y + d.y - a.y) * f }); }
    for (let i = i1 + 1; i < path.length; i++) { const w = 1 - ease(Math.min(1, (s[i] - s[i1]) / PORTAL.relax)); out.push({ x: path[i].x + d.x * w, y: path[i].y + d.y * w }); }
    return out;
  }
  // align: the k-th line crosses at fraction f along the near edge, square to it, to the far edge.
  const f = (k + 1) / (n + 1);
  const A = { x: o0.x + (o1.x - o0.x) * f, y: o0.y + (o1.y - o0.y) * f };
  const norm = { x: -e.y, y: e.x }, far = { x: A.x + norm.x * 100, y: A.y + norm.y * 100 };
  const toward = (n0.x - o0.x) * norm.x + (n0.y - o0.y) * norm.y < 0 ? -1 : 1;
  const farPt = { x: A.x + toward * (far.x - A.x), y: A.y + toward * (far.y - A.y) };
  const u = meetAlong(A, farPt, n0, n1);
  const B = u === undefined ? { x: A.x + toward * norm.x * 9, y: A.y + toward * norm.y * 9 } : { x: n0.x + (n1.x - n0.x) * u, y: n0.y + (n1.y - n0.y) * u };
  const out: Point[] = [];
  for (let i = 0; i < i0; i++) {
    const w = ease(Math.max(0, 1 - (s[i0] - s[i]) / PORTAL.ease));
    out.push({ x: path[i].x + (A.x - path[i0].x) * w, y: path[i].y + (A.y - path[i0].y) * w });
  }
  for (let j = 0; j <= 12; j++) out.push({ x: A.x + (B.x - A.x) * j / 12, y: A.y + (B.y - A.y) * j / 12 });
  for (let i = i1 + 1; i < path.length; i++) {
    const w = 1 - ease(Math.min(1, (s[i] - s[i1]) / PORTAL.relax));
    out.push({ x: path[i].x + (B.x - path[i1].x) * w, y: path[i].y + (B.y - path[i1].y) * w });
  }
  return out;
}

function draw(ctx: SketchContext): Part[] {
  const bar = lintelBar(ctx, bustFrame(ctx));
  // One field across the triptych: C's magnet (with the gripping hand's pole when it pulls), whose lines leave C's right
  // edge at the heights R's strands come in, and whose field reaches R and pulls at the figure.
  const m = magnet(bar, ctx);
  const entering = rEntries(m, fieldLines(m, Math.round(n(ctx, 'fieldLines', 26, 8, 48))));
  const exits = entering.map(e => e.y);
  const clean = ctx.params.figure === 'clean';
  const pulled = ctx.params.figureField !== false;

  // The figure, kneeling at the origin, turned toward the viewer's left (the centre panel).
  const yaw = -THREE.MathUtils.degToRad(n(ctx, 'kneelTurn', 50, 0, 80));
  // `clean`: straight faceted limbs (no bow) built like the bust, and a stacked-ring head; else R1's flowing figure.
  const fig = agentFigure({ height: 24 * K, anchor: new THREE.Vector3(), yaw, base: 'kneel', pose: KNEEL, proportions: BROAD, build: clean ? 1.3 : 1.25, facets: 6, bow: clean ? 0 : 0.015, hem: HEM, lift: 0.5 * K });
  const { body, head, stops, skeleton: s } = fig;
  const arms = body.limbs.filter(t => t.id.startsWith('arm')), legs = body.limbs.filter(t => t.id.startsWith('leg'));
  // The kit stops a trouser at a level hem above the ankle, which a kneeling leg's shin, lying along the floor, never
  // reaches: it would stop at the knee. Each trouser stops just short of its ankle instead.
  for (const side of ['l', 'r'] as const) {
    const leg = legs.find(t => t.id === `leg_${side}`)!;
    stops.set(leg.id, Math.max(stops.get(leg.id)!, uNear(leg, s.at(`ankle_${side}`)) - 0.03));
  }

  // The hands: gripping, fingers curled round the strands; the shoes: blunt slabs along each foot.
  const hands: Slab[] = [];
  for (const side of ['l', 'r'] as const) {
    const elbow = s.at(`elbow_${side}`), wrist = s.at(`wrist_${side}`);
    const along = wrist.clone().sub(elbow).normalize();
    const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(side === 'l' ? 1 : -1);
    hands.push(...slabHand({ wrist, along, across, size: 1.15 * K, curl: 0.62, spread: 0.06 }));
  }
  const shoes: Slab[] = [];
  for (const side of ['l', 'r'] as const) {
    const j = s.joints.get(`ankle_${side}`)!;
    const toe = j.end.clone(), heel = j.origin.clone();
    const along = toe.clone().sub(heel).normalize();
    const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0)).normalize();
    shoes.push(orientedSlab(heel.clone().lerp(toe, 0.5).add(new THREE.Vector3(0, -0.1 * K, 0)), across, along, 0.62 * K, toe.distanceTo(heel) + 0.35 * K, 0.5 * K, 30));
  }
  const gather = s.at('wrist_l').lerp(s.at('wrist_r'), 0.5);

  // The camera: in front, a little below the chest, the figure fitted to the sheet's height and set right of centre.
  const fov = 38;
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const pts: THREE.Vector3[] = [...headCoil(head)];
  for (const t of [body.trunk, ...body.limbs]) for (let i = 0; i <= 12; i++) for (let k = 0; k < 8; k++) pts.push(t.point(i / 12, k / 8));
  for (const sl of shoes) pts.push(new THREE.Vector3(sl.x, sl.y - sl.h / 2, sl.z));
  const camera = (target: THREE.Vector3, D: number) => {
    const c = new THREE.PerspectiveCamera(fov, W / H, 1, 1e6);
    // From a little above: the floor opens into a disc the figure kneels on.
    c.position.copy(target).add(new THREE.Vector3(0, 0.32, 1).normalize().multiplyScalar(D));
    c.lookAt(target);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  let target = s.at('chest').clone().setY(s.at('chest').y * 0.7), D = 60 * K;
  const top = TRIM.y0 + 20, bottom = TRIM.y1 - 30, cx = 0.58 * PAGE.width, right = TRIM.x1 - 6, left = 0.2 * PAGE.width;
  for (let it = 0; it < 40; it++) {
    const c = camera(target, D);
    const ps = pts.map(p => pageOf(c, p, PAGE));
    const y0 = Math.min(...ps.map(p => p.y)), y1 = Math.max(...ps.map(p => p.y)), x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    const across = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    target = target.clone().addScaledVector(across, ((x0 + x1) / 2 - Math.min(cx, (left + right) / 2 + 20)) * D / f).addScaledVector(up, -((y0 + y1) / 2 - (top + bottom) / 2) * D / f);
    D *= Math.max((y1 - y0) / (bottom - top), (x1 - x0) / (right - left));
  }
  const view = camera(target, D);
  const eye = view.position.clone(), forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;

  // The tone: the light is in the gathered strands at the hands.
  const aura = toneField(ctx, gather.clone().divideScalar(K), { noiseKey: 'kneel-aura', reach: 5 });
  // Clean: one even tone (between the second and third stripe tiers), so the stripes run whole, never in patches.
  const env: ToneEnv = clean
    ? { density: 0.8 * n(ctx, 'density', 0.45, 0, 1), dark: () => 0.5, screen: p => pageOf(view, p, PAGE) }
    : { density: n(ctx, 'density', 0.45, 0, 1), dark: (p, nrm) => 0.05 + 0.5 * aura(p.clone().divideScalar(K), nrm), screen: p => pageOf(view, p, PAGE) };
  const strokes: Tagged[] = [];
  const slack = 0.15 * K;
  const cloth = (list: ClothStroke[]) => { for (const st of list) strokes.push({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points, slack }); };
  cloth(pinstripeTube(body.trunk, env, HEMS.trunk, LOOK));
  cloth(suitFront(body.trunk, env, LOOK));
  const cut = body.limbs.map(t => cutTube(t, stops.get(t.id)!));
  for (const t of arms) { const stop = stops.get(t.id)!; cloth(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, LOOK)); }
  for (const t of legs) { const stop = stops.get(t.id)!; cloth(pinstripeTube(t, env, { seams: [0, 0.5], hems: [stop - 0.004], creases: [0.25], stop }, LOOK)); }
  for (const t of [body.trunk, ...cut]) cloth(silhouettes(t, { forward, eye }, { ink: LOOK.edge, group: LOOK.contour }));
  const light = new THREE.Vector3(-0.6, 0.7, 0.4).normalize();
  // Hands hatched in the raking light; shoes as outlines (the planted one stands on the disc, where a hatched block
  // would read as a slab of silver).
  for (const sl of [...hands, ...shoes]) for (const st of facetStrokes(sl, light, eye, shoes.includes(sl), 4 / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z)))) strokes.push({ ink: st.ink === 'violet' ? 'carbon' : st.ink, group: 'hand', family: st.family, points: st.points, slack: 0.05 * K });
  // The head: R1's helix wound along the coil, or (clean) a stack of flat ring bands like a coiled spring.
  const headGeos: THREE.BufferGeometry[] = [];
  if (clean) {
    for (const band of ringHead(head)) {
      cloth(pinstripeTube(band, env, { seams: [], hems: [0.05, 0.95] }, LOOK).map(st => ({ ...st, group: 'helix' })));
      cloth(silhouettes(band, { forward, eye }, { ink: 'carbon', group: 'helix' }));
      headGeos.push(band.mesh(6, 72));
    }
  } else {
    const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
      { radius: 0.12 * K, width: 0.6 * K, pitch: 9 * K, spread: 0.1 * K, narrow: 0.08 * K, density: 0.4, interruption: 0.1 });
    for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points, slack });
    headGeos.push(...helix.meshes, skull(head));
  }

  // The floor disc: a circle on the ground the figure kneels on, reaching forward under its hands, as a curved cut in
  // the white.
  // Centred under the kneeling knee and the planted foot, so the figure kneels on it; its front edge takes the strands.
  const under = s.at('knee_r').lerp(s.at('ankle_l'), 0.5);
  const centre = new THREE.Vector3(under.x, 0, under.z);
  const radius = 6.4 * K;
  const ring = (r: number) => Array.from({ length: 96 }, (_, i) => pageOf(view, centre.clone().add(new THREE.Vector3(r * Math.cos(2 * Math.PI * i / 96), 0, r * Math.sin(2 * Math.PI * i / 96))), PAGE));
  // The floor's outline: R1 to R4's disc, or (the angular cut set) a square on the ground seen corner-on, angular.
  const square = [0, 1, 2, 3].map(k => pageOf(view, centre.clone().add(new THREE.Vector3(radius * Math.cos(k * Math.PI / 2), 0, radius * Math.sin(k * Math.PI / 2))), PAGE));
  const disc = clipPolygon(floorKind(ctx) === 'square' ? square : ring(radius), TRIM);
  const discCentre = pageOf(view, centre, PAGE);

  // The field's pull on the figure (`figureField`): every mark moved along the field toward C, nothing at the ground and
  // most at the crown of the head, so the head leans and the torso with it while the knees hold. The head's own marks
  // are pulled half again as far, so it unwinds toward C.
  const groundY = discCentre.y, crownY = Math.min(...headCoil(head).map(p => pageOf(view, p, PAGE).y));
  const lift = (p: Point) => Math.max(0, Math.min(1, (groundY - p.y) / (groundY - crownY))) ** 1.7;
  const pullBody = pulled ? fieldPull(m, PULL_MM, lift) : (p: Point) => p;
  const pullHead = pulled ? fieldPull(m, 1.5 * PULL_MM, lift) : (p: Point) => p;
  // The figure's tie, as on L but inverted: cut from the white (in the tie cut set), it shows black, filled with silver
  // stripes over the window grown by the bleed; traced on the trunk and moved with the field's pull, as its marks are.
  const tie = suitFrontOutlines(body.trunk, view).tie.map(pullBody);
  const grow = spec.bleed + FILL_OVER;
  const tieCut = cutSchemeOf(ctx) === 'tie';
  const inTie = tieCut ? inGrown(tie, grow) : () => false;

  // The strands: in at the left edge at the heights the field left C, gathered at the hands (where the pull has moved
  // them), led down into the disc, and with the pull, bowed toward C as they fall.
  const g = pullBody(pageOf(view, gather, PAGE));
  const bow = pulled ? -BOW_MM : 0;
  const pink = Math.floor(exits.length / 2);
  const strands = exits.map((y, k) => {
    const t = exits.length > 1 ? k / (exits.length - 1) - 0.5 : 0;
    // In along the field line's own slope at the edge (level with no gap, as R2 to R5), so it meets its line from C.
    const slope = gapOf(m) > 0 ? entering[k].slope : 0;
    const path = smoothPath([{ x: TRIM.x0 - 6, y: y - 6 * slope }, { x: TRIM.x0, y }, ...(slope ? [{ x: TRIM.x0 + 8, y: y + 8 * slope }] : []), { x: TRIM.x0 + 26, y: y + (g.y - y) * 0.12 }, { x: g.x - 34, y: g.y + (y - g.y) * 0.35 + 6 * t }, { x: g.x + 3 * t, y: g.y + 2 * t },
      { x: g.x - 10 + 14 * t + bow, y: (g.y + discCentre.y) / 2 }, { x: discCentre.x + 22 * t, y: discCentre.y + 3 * Math.abs(t) }]);
    return { path, ink: (k === pink ? 'vermilion' : 'ultramarine') as Ink };
  });
  // The portal (`portalFx`): where the strands come in through the band cut in the white, the lines change there.
  // `rOut` ribbon (the default, with the portal): the portal stands near R's left edge, so the lines cross only a short
  // span of bare paper before it, and come in as short dashes there; after it they ravel back into a ribbon (the
  // mirror of L, where the ribbon unravels into lines) that runs on to the hands and down to the floor.
  const toRibbon = ctx.params.rOut !== 'lines' && hasPortal(ctx);
  const portal = hasPortal(ctx) ? portalBand(strands.map(st => st.path), toRibbon ? TRIM.x0 + RAVEL.portalAt : TRIM.x0 + PORTAL.at * (g.x - TRIM.x0)) : undefined;
  if (portal) {
    const fx = String(ctx.params.portalFx ?? 'align');
    strands.forEach((st, k) => { st.path = throughPortal(st.path, portal, fx, k, strands.length); });
  }
  const widen = n(ctx, 'rRibbonWidth', 2, 1, 3);
  const reformed = toRibbon && portal ? ravel(strands, portal, pink, widen) : undefined;
  const strandArea = glyphMask([...strands.map(st => st.path), ...(reformed?.ribbon.mask ?? [])], 0.9, 6, PAGE);
  // "line", along the pink strand where it falls from the hands toward the floor (with the ribbon, beside it).
  const pinkPath = strands[pink]?.path ?? [];
  const word = reformed
    ? wordAlong('line', reformed.centre, 0.62 * lengths(reformed.centre).at(-1)!, 2.4, -(widen * THREAD.widthMm / 2 + 2.6))
    : wordAlong('line', pinkPath, 0.74 * 0.4 * pinkPath.length, 2.4, 2.4);
  const clear = glyphMask(word, 0.8, 6, PAGE);

  // The cut set's windows in the white (`cutScheme`), beside the floor disc: the black shows there, the figure and the
  // strands drawn on it in silver (the `under` marks); with `rCuts` lens (R9) the head's window shows the head larger
  // and shifted instead, as L's bar, and with cosmos every window looks out on stars.
  const headPage = pullHead(pageOf(view, head.centre, PAGE));
  const windows = rCuts(ctx, { head: headPage, headR: head.r * mmPerUnit(head.centre), gather: g, entries: exits, floor: disc, tie, ...(portal ? { portal } : {}) });
  const rMode = String(ctx.params.rCuts ?? 'lens');
  const headWindow = windows.find(w => w.id === 'head')?.rings[0];
  const lensWindow = rMode === 'lens' ? headWindow : undefined;
  const inLens = lensWindow ? inGrown(lensWindow, grow) : () => false;
  // Emphasis (R9): the head's window framed three times and the portal twice, on the white kept round them (the white's
  // marks stop short of the frames), the figure's long outer contours and the ribbon's widest edges doubled outward.
  const emph = emphasisOn(ctx);
  const frames = emph ? [
    ...(headWindow ? [{ ring: headWindow, lines: 3, pen: 'carbon' }] : []),
    ...(portal ? [{ ring: portal, lines: 2, pen: 'ultramarine' }] : []),
  ] : [];
  const bands = frames.map(f => frameBand(f.ring, f.lines));
  const framed = (p: Point) => bands.some(b => b(p));
  const contours: Point[][] = [], figureMarks: Point[][] = [];

  const figureGeos = [body.trunk.mesh(192, body.trunk.facets * 4), ...cut.flatMap(cutMeshes), ...[...hands, ...shoes].map(slabGeometry), ...headGeos];
  fitDepthRange(view, figureGeos, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(figureGeos, view, W, H);
  const buckets = new PartBuckets(0.4);
  const BANDS = 10;
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);
  const order = [...strokes].sort((a, b) => dist(a) - dist(b));
  for (let b = 0; b < BANDS; b++) {
    const chunk = order.slice(Math.floor(b * order.length / BANDS), Math.floor((b + 1) * order.length / BANDS));
    if (!chunk.length) continue;
    projectStrokes(chunk, { view, depth, width: W, height: H, bias: hiddenBias(view, slack, dist(chunk[chunk.length >> 1])) }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y).map(st.group === 'helix' ? pullHead : pullBody), ART)) {
          for (const piece of keepAlong(inside, p => !strandArea(p) && !clear(p), 0.15)) {
            for (const white of keepAlong(piece, q => !framed(q), 0.15)) {
              if (buckets.add(`${st.group === 'contour' || st.group === 'figure' || st.group === 'helix' || st.group === 'hand' ? st.group : 'figure'}-${st.ink}`, white, false)) {
                if (emph && st.group === 'contour') contours.push(white);
                else if (emph) figureMarks.push(white);
              }
            }
            // Where the figure stands on the disc, the black shows: the same mark there in silver (but for the tie, filled).
            for (const part of keepAlong(piece, q => !inTie(q) && !inLens(q), 0.15)) buckets.add(`under-${st.ink}`, part, false);
          }
        }
      },
    });
  }
  for (const st of strands) for (const piece of clipToRect(st.path, ART)) {
    for (const part of keepAlong(piece, p => !clear(p), 0.15)) { buckets.add(`strand-${st.ink}`, part, true); buckets.add(`strandunder-${st.ink}`, part, true); }
  }
  // The dashes on the white; on the black, under the portal's edge, the lines come in whole (out to the portal grown by
  // the bleed), so a portal cut a little off shows a line going on, never a dash cut short.
  for (const st of reformed?.dashes ?? []) for (const piece of clipToRect(st.path, ART)) buckets.add(`strand-${st.ink}`, piece, true);
  const nearPortal = portal ? inGrown(portal, grow) : () => false;
  for (const st of reformed?.entries ?? []) for (const piece of clipToRect(st.path, ART)) for (const part of keepAlong(piece, nearPortal, 0.1)) buckets.add(`strandunder-${st.ink}`, part, true);
  // The ribbon: its +1 edge is the pink strand's, pink on both sheets; the rest in the ribbon's inks.
  reformed?.ribbon.strokes.forEach((st, i) => {
    for (const piece of clipToRect(st.points, ART)) for (const part of keepAlong(piece, p => !clear(p), 0.15)) {
      if (i === 1) { buckets.add('strand-vermilion', part, true); buckets.add('strandunder-vermilion', part, true); }
      else { buckets.add(`ribbon-${st.ink}`, part, true); buckets.add(`ribbonunder-${st.ink}`, part, true); }
    }
  });
  for (const w of word) for (const piece of clipToRect(w, ART)) buckets.add('word-ultramarine', piece, true);
  // The ground (`groundFx`), on the black sheet under the floor disc: R1's three silver rings, or the field going on into
  // the ground. A ring about a ground point, sampled on the floor plane and kept inside the floor disc.
  const fx = String(ctx.params.groundFx ?? 'pulse');
  const fxSilver: Point[][] = [], fxPink: Point[][] = [];
  // Out over the floor grown by the bleed, so a cut a little off never shows bare black at the floor's edge.
  const onDisc = inGrown(disc, grow);
  const ringAt = (c: THREE.Vector3, r: number, a0 = 0, a1 = 2 * Math.PI, n = 144): Point[] => Array.from({ length: n + 1 }, (_, i) => pageOf(view, c.clone().add(new THREE.Vector3(r * Math.cos(a0 + (a1 - a0) * i / n), 0, r * Math.sin(a0 + (a1 - a0) * i / n))), PAGE));
  const keepOnDisc = (path: Point[], into: Point[][]) => { for (const piece of keepAlong(path, onDisc, 0.2)) into.push(piece); };
  const landing = (st: { path: Point[] }) => onGround(view, st.path[st.path.length - 1], PAGE);
  const landed = reformed ? [{ path: reformed.centre }] : strands;
  const bundle = landed.map(landing).reduce((t, q) => t.add(q), new THREE.Vector3()).divideScalar(Math.max(1, landed.length)).setY(0);
  const pinkAt = reformed ? bundle : strands[pink] ? landing(strands[pink]).setY(0) : bundle;
  // Ring spacing on the floor: about 2.4 mm across the sheet at the disc.
  const stepW = 2.4 / mmPerUnit(centre);
  if (fx === 'interference') {
    // Two families of rings, from where the strands land and (a touch wider apart) from the disc's own centre: where
    // they cross they beat into moiré. The three rings round where the pink strand lands are pink.
    for (let r = 1.3 * stepW; r < 1.6 * radius; r += 1.3 * stepW) keepOnDisc(ringAt(bundle, r), fxSilver);
    for (let r = 1.45 * stepW; r < 1.6 * radius; r += 1.45 * stepW) keepOnDisc(ringAt(centre, r), fxSilver);
    for (let k = 1; k <= 3; k++) keepOnDisc(ringAt(pinkAt, 0.6 * k * stepW), fxPink);
  } else if (rMode === 'cosmos') {
    // The cosmos (R9): the ground a spiral galaxy seen at the floor's angle, about where the strands land: two arms of
    // three dashed tracks each, and a pink core of close rings.
    const rng = ctx.random('lodestone-floor-galaxy'), mm = stepW / 2.4, a = 3 * mm, b = 0.2, thMax = Math.log(1.6 * radius / a) / b;
    for (let k = 1; k <= 4; k++) keepOnDisc(ringAt(bundle, k * 0.6 * mm), fxPink);
    const turn = 2 * Math.PI * rng();
    for (const arm of [0, Math.PI]) for (const track of [-1, 0, 1]) {
      let th = 0.3 * rng();
      while (th < thMax) {
        const r = a * Math.exp(b * th), w = track * (0.45 * mm + 0.06 * r), len = (0.8 + 0.8 * rng()) * mm;
        if (rng() > 0.15 * Math.abs(track)) keepOnDisc(ringAt(bundle, r + w, turn + arm + th, turn + arm + th + len / r, 4), fxSilver);
        th += (len + (0.7 + 1.0 * rng()) * mm) / r;
      }
    }
  } else if (fx === 'pulse') {
    // Rings spreading from where the strands land, ever further apart, dashed by turns; between them, filings pointing
    // into the ground (radial dashes). The third ring is pink.
    const rings: number[] = [];
    for (let r = 1.2 * stepW; r < 1.6 * radius; r *= 1.22) rings.push(r);
    rings.forEach((r, k) => {
      const path = ringAt(bundle, r, 0.3 * k, 0.3 * k + 2 * Math.PI, 240);
      const into = k === 2 ? fxPink : fxSilver;
      if (k % 2 === 0) keepOnDisc(path, into);
      else for (let i = 0; i + 4 < path.length; i += 6) keepOnDisc(path.slice(i, i + 5), into);
      const next = rings[k + 1] ?? 1.22 * r, count = Math.round(18 + 6 * k);
      for (let i = 0; i < count; i++) {
        const a = 2 * Math.PI * (i + 0.5 * (k % 2)) / count;
        const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const r0 = r + 0.25 * (next - r), r1 = r + 0.6 * (next - r);
        keepOnDisc([pageOf(view, bundle.clone().addScaledVector(d, r0), PAGE), pageOf(view, bundle.clone().addScaledVector(d, r1), PAGE)], fxSilver);
      }
    });
  } else if (ctx.params.groundRings !== false) {
    for (const r of [0.22, 0.42, 0.64]) { const pr = ring(r * radius); for (const piece of clipToRect([...pr, pr[0]], ART)) buckets.add('rings-carbon', piece, true); }
  }
  if (emph) {
    // The figure's long outer contours doubled, a line outward (where they bound the figure on one side only).
    const figure = glyphMask([...figureMarks, ...contours], 1.6, 4, PAGE), spaced = spacer(), ground = spacer();
    for (const mark of [...figureMarks, ...contours]) { spaced.add(mark); ground.add(mark); }
    for (const mark of [...fxSilver, ...fxPink]) ground.add(mark);
    for (const piece of contours) {
      let len = 0;
      for (let i = 1; i < piece.length; i++) len += Math.hypot(piece[i].x - piece[i - 1].x, piece[i].y - piece[i - 1].y);
      if (len >= 40) for (const par of outwardDouble(piece, figure, 2.2)) for (const part of keepAlong(par, q => !strandArea(q) && !clear(q) && !framed(q) && !spaced.near(q, 0.6), 0.15)) {
        spaced.add(part);
        buckets.add('emph-vermilion', part, true);
        for (const under of keepAlong(part, q => !inTie(q) && !inLens(q) && !ground.near(q, 0.6), 0.15)) buckets.add('emphunder-vermilion', under, true);
      }
    }
    // The ribbon's edges doubled where it is widest (seen flat, over 0.7 of its full width), a line outward of each.
    const [e0, e1] = reformed?.ribbon.strokes ?? [];
    if (e0 && e1 && e0.points.length === e1.points.length) {
      const width = e0.points.map((q, i) => Math.hypot(e1.points[i].x - q.x, e1.points[i].y - q.y)), wide = 0.7 * Math.max(...width);
      ([[e0, e1, false], [e1, e0, true]] as const).forEach(([edge, other, isPink]) => {
        const runs: Point[][] = [];
        let run: Point[] = [];
        edge.points.forEach((q, i) => {
          if (width[i] < wide) { if (run.length > 1) runs.push(run); run = []; return; }
          const o = other.points[i];
          run.push({ x: q.x + (q.x - o.x) / width[i] * EMPHASIS.step, y: q.y + (q.y - o.y) / width[i] * EMPHASIS.step });
        });
        if (run.length > 1) runs.push(run);
        for (const r of runs) for (const piece of clipToRect(r, ART)) for (const part of keepAlong(piece, q => !clear(q) && !spaced.near(q, 0.6), 0.15)) {
          buckets.add(isPink ? 'strand-vermilion' : 'emph-vermilion', part, true);
          for (const under of keepAlong(part, q => !ground.near(q, 0.6), 0.15)) buckets.add(isPink ? 'strandunder-vermilion' : 'emphunder-vermilion', under, true);
        }
      });
    }
  }
  for (const geo of figureGeos) geo.dispose();

  // Route: the white keeps the figure and strands, the black the marks under the disc; the pink strand in pink on both.
  const parts = buckets.toParts(GROUPS, INKS);
  // (The strands are routed by hand: routeParts keys a ply's pens by ink, and the pink strand needs its own pen on both.)
  const art = routeParts(parts.filter(p => !p.id.startsWith('strand')), ROUTES);
  for (const p of parts.filter(q => q.id.startsWith('strand-'))) art.white.push({ ...p, pen: STRAND_PEN.white[p.pen as 'ultramarine' | 'vermilion'] });
  for (const p of parts.filter(q => q.id.startsWith('strandunder-'))) art.black.push({ ...p, pen: STRAND_PEN.black[p.pen as 'ultramarine' | 'vermilion'] });
  if (fxSilver.length) art.black.push({ id: 'fx-silver', pen: 'silver', paths: fxSilver });
  if (tieCut) {
    const axis = Math.atan2(tie[40].y - tie[0].y, tie[40].x - tie[0].x);
    art.black.push({ id: 'tie-silver', pen: 'silver', paths: stripeFill(tie, axis + Math.PI / 2 - 0.35, 1.5, grow) });
  }
  if (fxPink.length) art.black.push({ id: 'fx-pink', pen: 'fluoro-pink', paths: fxPink });
  // The lens (`rCuts` lens): the head through the head's window, as L's bar shows it, in silver on the black.
  if (lensWindow) {
    const cam = lensCamera(view, head), sk = skull(head), d = eye.distanceTo(head.centre);
    const faceSeen = seenBy(cam, [...faceMarks(head), faceOutline(head, cam)].map(points => ({ ink: 'carbon' as Ink, group: 'face', family: 'text' as const, points })), [sk], slack, d);
    const coilSeen = seenBy(cam, strokes.filter(t => t.group === 'helix'), [...headGeos, sk], slack, d);
    sk.dispose();
    const mid = { x: lensWindow.reduce((t, q) => t + q.x, 0) / lensWindow.length, y: lensWindow.reduce((t, q) => t + q.y, 0) / lensWindow.length };
    const shift = lensShift(-Math.PI / 6), from = pageOf(cam, eyeCentre(head), PAGE), to = { x: mid.x + shift.x, y: mid.y + shift.y };
    const face = lensImage(faceSeen, from, to, LENS.mag), coil = lensImage(coilSeen, from, to, LENS.mag), onFace = glyphMask(face, 1.2, 6, PAGE);
    art.black.push({ id: 'lens-silver', pen: 'silver', paths: [
      ...face.flatMap(path => keepAlong(path, inLens, 0.1)),
      ...coil.flatMap(path => keepAlong(path, q => inLens(q) && !onFace(q), 0.1)),
    ] });
  }
  // The cosmos (`rCuts` cosmos): stars behind what each window shows (and in the tie, in place of its stripes), the
  // head's window a small galaxy too, kept clear of the black's own marks; one star pink.
  if (rMode === 'cosmos') {
    if (tieCut) art.black = art.black.filter(part => part.id !== 'tie-silver');
    const marks = glyphMask(art.black.flatMap(part => part.paths), 1.0, 6, PAGE);
    const stars: Point[][] = [], bright: Point[][] = [];
    for (const w of windows.filter(c => c.id !== 'floor')) {
      const ring = w.rings[0], xs = ring.map(q => q.x), ys = ring.map(q => q.y), inside = inGrown(ring, grow);
      const sky = cosmos(ctx.random(`lodestone-cosmos-${w.id}`), { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, angle: 0, l: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, { grow, galaxies: w.id === 'head' ? 1 : 0 });
      const whole = (path: Point[]) => path.every(q => inside(q) && !marks(q));
      stars.push(...[...sky.silver, ...sky.cores].filter(whole));
      if (w.id === 'head') bright.push(...sky.accent.filter(whole));
    }
    art.black.push({ id: 'cosmos-silver', pen: 'silver', paths: stars });
    if (bright.length) art.black.push({ id: 'cosmos-pink', pen: 'fluoro-pink', paths: bright });
  }
  // The frames, on the white: the head's in carbon, the portal's in ultramarine, giving way where the strands cross it.
  if (frames.length) {
    const crossing = glyphMask([...strands.map(st => st.path), ...(reformed?.dashes ?? []).map(st => st.path)], 0.7, 6, PAGE);
    for (const f of frames) art.white.push({ id: `emphasis-${f.pen}`, pen: f.pen, paths: frameRings(f.ring, f.lines).flatMap(r => clipToRect(r, ART)).flatMap(r => keepAlong(r, q => !crossing(q), 0.1)) });
  }
  return renderPly(spec, ctx, pens, { cuts: { white: windows }, art });
}

const sketch: Sketch = {
  name: 'Breach triptych: Lodestone R (the ground)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...LODESTONE_CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
