import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_SPACING, PAGE, PHRASE, TABLOID_CARD, TABLOID_RASTER, depthRaster, halo, hatchMin, layoutLength, layoutY, printFine, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { thinRanked } from '../../kit/density.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong, narrowStrands } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { atPage, fitDepthRange, horizonCamera, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, fineDepth, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { bodyMeshes, contourTube } from '../../kit/mannequin/body.ts';
import { ELONGATED, flowBody, gesture } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look } from '../../kit/mannequin/hatch.ts';
import { POSES, poseSkeleton, withPose, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { silhouettes, type ClothStroke, type Tube } from '../../kit/mannequin/tube.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { bodyPerson, figureBounds } from './figure.ts';

/**
 * VIII Strength: it lets you hold it. Not a woman and a lion but a person and a system: who is
 * holding whom? A thin arched dam of slab courses runs across the card on a diagonal, near and tall
 * at the lower left and receding to the right: a sheer wall, level with the lake behind it and a
 * long drop in front, the drop falling into shadow. On the lake lies the helix, an enormous coil
 * of rope laid turn on turn, asleep. Its tail leaves the outer turn and crosses the water to the
 * open hand of one small figure standing on the dam's top in a pocket of clear paper; its inner
 * end lifts out of the centre of the coil and arches slowly up into the sky and over, to stop above
 * the figure, looking down: the lion. The sky is light. The phrase is cut into the dam's courses, a
 * word to a course.
 *
 * On a small card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`strengthWorld`): the dam,
 * the coil and its neck, the person and the hand the tail ends on. The card's own camera draws it, so the person keeps
 * the print's place and size against the dam, and the head still hangs over them.
 */
/**
 * How much finer than the card's raster its depth pass is: the card's own at tabloid; on a smaller card as fine as the
 * print's each way (`printFine`, four at 70 × 120; `fineDepth`), so the hidden-line test sees the world about as finely
 * as the print's does. At the card's own raster a pixel there covers several times as much of the world, and the
 * parapet's thin top, the crest behind it and the person's limbs were lost to the faces in front of them.
 */
const OVERSAMPLE = printFine();
/** The card's depth raster at tabloid; on any other page, the format's, with room for the finer pass. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, OVERSAMPLE);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/** The helix is built this many times larger and brought back, so its fixed-size wiggles stay small. */
const BIG = 4;
/**
 * How far, in world units, a line along a helix ribbon can dip behind the ribbon's own surface: the kit traces the
 * surfaces coarsely (`helixAlong`: 320 steps along the whole curve, over 50° of a turn each here), so on the far side
 * of each turn the facets' chords stand up to about a unit in front of the true ribbon. The print hides those stretches
 * of its edges among the laminations; a small card's strand drawn as one line would print as dashes, so its depth test
 * gets this much more slack, still less than the gap between the two strands, so they keep crossing over and under.
 */
const STRAND_SAG = 1.6;

type V2 = { x: number; z: number };

/** Everything the card reads from its controls about the wall, once. */
export function damSpec(ctx: SketchContext) {
  const height = n(ctx, 'damHeight', 170, 60, 300);
  const spec = {
    height,
    eyeRise: n(ctx, 'eyeRise', 88, 20, 160),
    lakeBelow: n(ctx, 'lakeBelow', 1.5, 0.3, 8),
    parapet: n(ctx, 'parapet', 4.2, 1, 10),
    courses: Math.round(n(ctx, 'courses', 10, 5, 20)),
    crest: n(ctx, 'crest', 9, 4, 20),
    base: n(ctx, 'base', 13, 4, 60),
    panel: n(ctx, 'panel', 0.2, 0.04, 0.3),
    nearDepth: n(ctx, 'nearDepth', 200, 100, 400),
    farDepth: n(ctx, 'farDepth', 600, 350, 1500),
    bow: n(ctx, 'bow', 90, 0, 160),
  };
  return { ...spec, eye: height + spec.eyeRise, water: height - spec.lakeBelow };
}
export type DamSpec = ReturnType<typeof damSpec>;

/** The card's camera, on the format's page. */
export function strengthCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const spec = damSpec(ctx);
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, spec.eye, 0], target: [0, spec.eye, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the card's world is laid out with. At tabloid it is `strengthCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye: damSpec(ctx).eye, near: 8, far: 4000 });
}

/** The dam in plan: an arc bowed upstream, from beyond the left edge of the card to beyond the right (on the print). */
export interface Plan {
  at(u: number): V2;
  /** Unit tangent, near end to far end. */
  tangent(u: number): V2;
  /** |dP/du|: arc length per unit u. */
  speed(u: number): number;
}

/** `f` is the world camera's focal length in tabloid page millimetres (see `strengthWorld`). */
export function damPlan(spec: DamSpec, f: number): Plan {
  const cx = TABLOID_PAGE.width / 2;
  const A: V2 = { x: (TABLOID_CARD.x0 - 14 - cx) * spec.nearDepth / f, z: -spec.nearDepth };
  const B: V2 = { x: (TABLOID_CARD.x1 + 14 - cx) * spec.farDepth / f, z: -spec.farDepth };
  const c = { x: B.x - A.x, z: B.z - A.z };
  const len = Math.hypot(c.x, c.z);
  // Upstream: the side the lake is on, away from the eye.
  const lake = { x: c.z / len, z: -c.x / len };
  const d = (u: number): V2 => ({ x: c.x + lake.x * 4 * spec.bow * (1 - 2 * u), z: c.z + lake.z * 4 * spec.bow * (1 - 2 * u) });
  return {
    at: u => ({ x: A.x + c.x * u + lake.x * 4 * spec.bow * u * (1 - u), z: A.z + c.z * u + lake.z * 4 * spec.bow * u * (1 - u) }),
    tangent: u => { const t = d(u), l = Math.hypot(t.x, t.z); return { x: t.x / l, z: t.z / l }; },
    speed: u => Math.hypot(d(u).x, d(u).z),
  };
}

/** The downstream direction at a point of the arc (toward the eye). */
const downstream = (t: V2): V2 => ({ x: -t.z, z: t.x });

/** Panel boundaries along the arc, each panel a set fraction of its own distance long, so panels hold their size on the sheet. */
function boundaries(plan: Plan, frac: number): number[] {
  const out = [0];
  for (let u = 0; u < 1;) {
    const dist = -plan.at(u).z;
    u += frac * dist / plan.speed(u);
    out.push(Math.min(1, u));
  }
  return out;
}

export interface Dam { courses: Slab[]; courseOf: number[]; parapet: Slab[] }

/**
 * The wall: tall courses of slab panels along the arc, their joints in columns, the downstream face sheer
 * (it steps out only a hair toward the base) and darker the lower it falls. A low parapet runs
 * along the upstream edge of the top.
 */
export function buildDam(ctx: SketchContext, spec: DamSpec, plan: Plan): Dam {
  const rng = ctx.random('strength-dam');
  const bounds = boundaries(plan, spec.panel);
  const courses: Slab[] = [];
  const courseOf: number[] = [];
  const hk = spec.height / spec.courses;
  const place = (u0: number, u1: number, y0: number, h: number, off0: number, thick: number, gap = 0.012): Slab => {
    const um = (u0 + u1) / 2;
    const p0 = plan.at(u0), p1 = plan.at(u1), pm = plan.at(um), t = plan.tangent(um), dn = downstream(t);
    const dist = -pm.z;
    const length = Math.hypot(p1.x - p0.x, p1.z - p0.z) - Math.max(0.25, gap * dist);
    const s = solid(pm.x + dn.x * (off0 + thick / 2), y0 + h / 2, pm.z + dn.z * (off0 + thick / 2), length, h, thick, 0, 'stack');
    s.ry = Math.atan2(-t.z, t.x);
    return s;
  };
  for (let k = 0; k < spec.courses; k++) {
    const thick = spec.base + (spec.crest - spec.base) * (k / (spec.courses - 1));
    // Joints stand over each other from foot to crest: a dam is poured in tall monolith columns, not laid in bond.
    const edges = bounds;
    // The wall falls into shadow below the crest: the top courses catch the light, the foot is deep.
    const depthK = 1 - k / (spec.courses - 1);
    for (let j = 0; j + 1 < edges.length; j++) {
      if (edges[j + 1] - edges[j] < 1e-4) continue;
      const sl = place(edges[j], edges[j + 1], k * hk, hk - 0.12, 0, thick);
      sl.beat = courses.length;
      sl.tone = clamp((0.25 + 1.45 * depthK ** 0.9) * (0.92 + 0.16 * rng()), 0.1, 1.7);
      courses.push(sl);
      courseOf.push(k);
    }
  }
  // The parapet: a thin wall along the upstream edge of the walkway.
  const pb = boundaries(plan, spec.panel);
  const parapet: Slab[] = [];
  const pt = 2.2;
  for (let j = 0; j + 1 < pb.length; j++) {
    const sl = place(pb[j], pb[j + 1], spec.height + 0.02, spec.parapet, 0.3, pt, 0.002);
    sl.beat = 500 + j;
    sl.tone = 0.5 + 0.2 * rng();
    parapet.push(sl);
  }
  return { courses, courseOf, parapet };
}

/** A small figure standing, one arm out to the tail, the head tipped up to the lion. */
export function personPose() {
  return withPose(gesture(POSES.stand, { arc: -4, sway: 3 }), {
    hip_l: { abduct: 8 }, hip_r: { abduct: 8 }, knee_l: { flex: 5 }, knee_r: { flex: 5 },
    shoulder_l: { abduct: 16, flex: 4 }, elbow_l: { flex: 14 },
    // The right arm out to the lake side and a little up, the hand open, palm up.
    shoulder_r: { abduct: 104, flex: 16 }, elbow_r: { flex: 12 }, wrist_r: { flex: -24 },
    neck: { flex: -14 }, head: { flex: -10 },
  });
}

/** A convex tube's outline on the page, as a closed line through the surface points that make it. */
function headOutline(head: Tube, view: THREE.Camera, look: Look): ClothStroke {
  const pts: { p: THREE.Vector3; x: number; y: number }[] = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j < 48; j++) {
    const p = head.point(i / 40, j / 48, 0.012);
    const q = pageOf(view, p);
    pts.push({ p, x: q.x, y: q.y });
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [], upper: typeof pts = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return { ink: look.edge, group: look.contour, points: [...ring, ring[0]].map(q => q.p) };
}

/**
 * The person as the World's small figure is made: the kit's flowing body on a posed skeleton, in
 * plain contour hatch (rings across every tube, darker where it turns from the light) and outline,
 * no suit.
 */
export function person(s: Skeleton, view: THREE.PerspectiveCamera) {
  const body = flowBody(s, { toes: 'point' });
  const light = new THREE.Vector3(-0.35, 0.6, 0.72).normalize();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const env = {
    forward, density: 0.4,
    screen: (p: THREE.Vector3) => pageOf(view, p),
    dark: (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.95 - 0.95 * Math.max(0, normal.dot(light)), 0, 1),
  };
  // Its outlines are grouped `figure-edge`, so a small card can rank them above the rings (the card draws every stroke into
  // its `figure` part).
  const look: Look = { ...LOOK, cloth: 'carbon', accent: 'ultramarine', edge: 'carbon', crease: 'carbon', figure: 'figure', contour: 'figure-edge' };
  const head = body.head!;
  const strokes: ClothStroke[] = [
    ...[body.trunk, ...body.limbs].flatMap(t => [...contourTube(t, env, look), ...silhouettes(t, env, { ink: 'carbon', group: 'figure-edge' })]),
    ...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.3) }, look),
    headOutline(head, view, look),
  ];
  return { strokes, meshes: bodyMeshes(body, 0.8), bounds: figureBounds(s, view) };
}

/** What the seed moves: where the coil sits and how it winds, how high the neck goes, and where the person stands, all scaled by `variety`. */
export function seedLayout(ctx: SketchContext) {
  const r = ctx.random('strength-layout');
  const v = n(ctx, 'variety', 1, 0, 2);
  const d = () => (r() - 0.5) * 2 * v;
  return { across: d() * 8, figure: d() * 0.05, turns: d() * 0.3, radius: d() * 8, depth: d() * 20, neck: d() * 10 };
}

/**
 * The helix as the force, asleep. A coil of rope lies on the lake: a flat spiral of three or
 * four turns, the outer the largest, each turn a little higher than the one outside it. The tail
 * leaves the outer turn, crosses the water and ends on the person's open hand. The inner end lifts
 * out of the middle of the coil, rises into the sky, arches slowly over toward the person and
 * stops above them, its tip pointing down. The curve runs from that head to the hand, thick at the
 * head and thinning only along the tail. This is its course through the world, laid out in tabloid's frame: `view`
 * is `worldCamera`, `f` its focal length in tabloid page millimetres, and the neck is drawn as intent on the print's
 * sheet. `sleepingHelix` builds the helix along it.
 */
export function helixCourse(ctx: SketchContext, view: THREE.PerspectiveCamera, spec: DamSpec, f: number,
  person: { headTop: THREE.Vector3; hand: THREE.Vector3 }, layout: ReturnType<typeof seedLayout>) {
  const tube = n(ctx, 'tube', 6.5, 3, 20);
  const tipFraction = n(ctx, 'tip', 0.14, 0.05, 0.4);
  const outer = clamp(n(ctx, 'coilRadius', 80, 40, 140) + layout.radius, 40, 140);
  const inner = 1.6 * tube;
  // Neighbouring turns keep a clear gap: the turns asked for are capped by the room.
  const turns = Math.min(clamp(n(ctx, 'coilTurns', 3.2, 2, 5) + layout.turns, 2, 5), (outer - inner) / (2.4 * tube));
  const rise = n(ctx, 'coilRise', 1.4, 0, 2) * tube;
  const rng = ctx.random('strength-coil');
  const hanged = rng() < 0.5 ? 1 : -1;
  const sway = n(ctx, 'tailSway', 0.1, 0, 0.3);
  const cx = TABLOID_PAGE.width / 2;
  const dc = clamp(n(ctx, 'coilDepth', 580, 250, 900) + layout.depth, 250, 900);
  const centre: V2 = { x: (clamp(n(ctx, 'coilAcross', 100, TABLOID_CARD.x0, TABLOID_CARD.x1) + layout.across, TABLOID_CARD.x0, TABLOID_CARD.x1) - cx) * dc / f, z: -dc };
  const flare = n(ctx, 'tailFlare', 7, 2, 12);
  const widthAt = (s: number) => tipFraction ** (s ** flare);
  const hand = person.hand;
  // Plan direction and distance from the coil to the person.
  const to = { x: hand.x - centre.x, z: hand.z - centre.z };
  const run = Math.hypot(to.x, to.z);
  const dir = { x: to.x / run, z: to.z / run };
  const aEnd = Math.atan2(-hanged * dir.x, hanged * dir.z);
  const lakeY = spec.water;
  const lowY = lakeY + tube * 0.6;
  const topY = lowY + rise * turns;
  const at = (r: number, a: number, y: number) => new THREE.Vector3(centre.x + r * Math.cos(a), y, centre.z + r * Math.sin(a));

  // The coil, inner end to outer end: an even spiral, stepping up toward the middle.
  const steps = Math.round(turns * 24);
  const coil: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    coil.push(at(inner + (outer - inner) * t, aEnd - hanged * Math.PI * 2 * turns * (1 - t), topY - (topY - lowY) * t));
  }

  // The neck, a swan's: out of the middle of the coil, a long rise that leans toward the person as it
  // climbs, over the top, and a shorter hang that ends in the head, a set distance straight above
  // the person's head and tipped down at it. Drawn as intent on the sheet (page millimetres) and
  // carried into the world at a depth that eases from the coil's to the person's.
  const foot = coil[0];
  const eyeAt = view.position;
  const footPage = pageOf(view, foot, TABLOID_PAGE), headPage = pageOf(view, person.headTop, TABLOID_PAGE);
  const tip = { x: headPage.x + n(ctx, 'headOffset', 0, -60, 60), y: headPage.y - n(ctx, 'headGap', 32, 5, 60) };
  const apexPage = clamp(n(ctx, 'neckTop', 122, 60, 200) + layout.neck, 60, 200);
  const dx = tip.x - footPage.x;
  // A rounded hook (its radius a fraction of the way across to the person) tops a long rise that
  // eases over toward the person in an S, and drops into a shorter hang: smooth on the sheet at
  // every join, vertical where it leaves the coil, in the hook's crown and at the tip.
  const r = n(ctx, 'hookRadius', 0.3, 0.12, 0.4) * dx;
  const hookY = apexPage + r;
  const climb = footPage.y - hookY;
  const xTop = tip.x + 0.06 * dx - 2 * r;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const intent: Point[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    intent.push({ x: footPage.x + (xTop - footPage.x) * ease(t) ** 1.6 - 0.04 * dx * Math.sin(Math.PI * t), y: footPage.y - t * climb });
  }
  for (let i = 1; i <= 10; i++) {
    const th = Math.PI + Math.PI * i / 10;
    intent.push({ x: xTop + r + r * Math.cos(th), y: hookY + r * Math.sin(th) });
  }
  const endX = xTop + 2 * r;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    intent.push({ x: endX + (tip.x - endX) * ease(t), y: hookY + (tip.y - hookY) * t });
  }
  const sheet = intent.map(q => new THREE.Vector3(q.x, q.y, 0));
  const dFoot = eyeAt.distanceTo(foot), dHead = eyeAt.distanceTo(person.headTop);
  const neck = sheet.map((q, i) => {
    if (i === 0) return foot.clone();
    const u = i / (sheet.length - 1);
    return atPage(view, { x: q.x, y: q.y }, dFoot + (dHead - dFoot) * u, TABLOID_PAGE);
  }).reverse();

  // The tail: a long slow S across the water, rising only at the very end to the hand.
  const exit = coil[coil.length - 1];
  // The tail bows out over the open water, away from the wall.
  const perp = { x: -dir.z, z: dir.x };
  const side = perp.z > 0 ? { x: -perp.x, z: -perp.z } : perp;
  const tailPts: THREE.Vector3[] = [];
  const reach = Math.hypot(hand.x - exit.x, hand.z - exit.z);
  const tailCount = 7;
  for (let i = 1; i <= tailCount; i++) {
    const t = i / tailCount;
    const ease = t - 0.08 * Math.sin(Math.PI * 2 * t);
    const lateral = sway * reach * Math.sin(Math.PI * t) * (1 - t) ** 0.4;
    tailPts.push(new THREE.Vector3(exit.x + (hand.x - exit.x) * ease + side.x * lateral, i === tailCount ? hand.y : lowY + (hand.y - lowY) * t ** 2.4, exit.z + (hand.z - exit.z) * ease + side.z * lateral));
  }
  const pts = [...neck, ...coil.slice(1), ...tailPts];
  // Rest the thinning tail on the water: its own girth sets how high its line floats.
  let total = 0;
  const cum = pts.map((q, i) => (total += i ? q.distanceTo(pts[i - 1]) : 0));
  const first = neck.length + coil.length - 1;
  const lying = pts.map((q, i) => (i >= first && i < pts.length - 1 ? q.clone().setY(Math.max(q.y, lakeY + tube * widthAt(cum[i] / total) * 0.6)) : q));
  const curve = new THREE.CatmullRomCurve3(lying.map(q => q.clone().multiplyScalar(BIG)), false, 'centripetal');
  return { curve, centre, tube, tipFraction, flare, topY, apexUp: Math.max(...neck.map(q => q.y)) };
}
export type HelixCourse = ReturnType<typeof helixCourse>;

/**
 * The helix along its course (`helixCourse`), built `BIG` times larger and brought back. Its lamination is spaced on
 * the card's paper, so it takes the card's own camera.
 */
export function sleepingHelix(ctx: SketchContext, view: THREE.PerspectiveCamera, course: HelixCourse) {
  const { curve, tube, tipFraction, flare, topY, apexUp } = course;
  const big = view.clone();
  big.position.multiplyScalar(BIG); big.near *= BIG; big.far *= BIG;
  big.updateProjectionMatrix(); big.updateMatrixWorld(true);
  const made = helixAlong(ctx, big, curve, {
    radius: tube * BIG, width: tube * BIG * n(ctx, 'helixWidth', 0.5, 0.25, 1), pitch: n(ctx, 'helixPitch', 5, 2, 9) * tube * BIG, spread: tube * 0.35 * BIG, narrow: 0.1, twist: 0.12,
    density: n(ctx, 'helixDensity', 0.45, 0, 1), interruption: 0.2, taper: tipFraction, flare, pitchGrowth: 0.7,
  });
  // The head end swells a little over the first stretch of the curve, so it reads as the end that looks;
  // the strokes and the surfaces are pushed out from the axis together.
  const swell = n(ctx, 'headSwell', 1.5, 1, 2);
  const span = 0.16, N = 600;
  const near = curve.getSpacedPoints(N).slice(0, Math.floor(span * N) + 4);
  const reshape = (p: THREE.Vector3): THREE.Vector3 => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < near.length; i++) { const d = p.distanceToSquared(near[i]); if (d < bd) { bd = d; best = i; } }
    const along = best / N;
    if (along >= span || bd > (4 * tube * BIG) ** 2) return p;
    const c = near[best];
    return c.clone().addScaledVector(p.clone().sub(c), 1 + (swell - 1) * smooth(span, 0, along));
  };
  if (swell > 1) {
    for (const h of made.strokes) h.points = h.points.map(reshape);
    for (const g of made.meshes) {
      const pos = g.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const q = reshape(v.clone()); pos.setXYZ(i, q.x, q.y, q.z); }
      pos.needsUpdate = true;
      g.computeBoundingSphere();
    }
  }
  // The turn over the top. The strands are traced coarsely, so where the neck stands high and its turns
  // are seen end-on they show as polygons and tangle. There, each trace is subdivided along a smooth
  // curve through the same samples; the rest of the helix is left exactly as it was.
  const zoneY = BIG * (topY + 0.55 * (apexUp - topY));
  const smoothed = (pts: THREE.Vector3[]): THREE.Vector3[] => {
    if (pts.length < 4 || !pts.some(q => q.y > zoneY)) return pts;
    const spline = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (pts[i].y > zoneY && pts[i + 1].y > zoneY) for (let k = 1; k < 4; k++) out.push(spline.getPoint((i + k / 4) / (pts.length - 1)));
      out.push(pts[i + 1]);
    }
    return out;
  };
  // On a small card a strand whose ribbon is narrower on paper than the smallest feature is drawn as its line instead
  // (`narrowStrands`; none at tabloid): its edges would print as one blot and its laminations as specks. It is measured
  // before the turn is smoothed, while the two edges still pair sample for sample.
  const strokes = narrowStrands(made.strokes, big);
  for (const h of strokes) h.points = smoothed(h.points);
  return {
    curve, centre: course.centre,
    strokes: strokes.map(h => ({ ...h, points: h.points.map(q => q.clone().multiplyScalar(1 / BIG)) })),
    meshes: made.meshes.map(g => g.scale(1 / BIG, 1 / BIG, 1 / BIG)),
  };
}

/**
 * The card's world: the dam, where the person stands and how tall (the skeleton, and the hand the tail ends on), and
 * the helix's course from its head over the person, round the coil and across the water to that hand. It is laid out in
 * tabloid's frame, with `worldCamera` and tabloid's page millimetres, so every size and fit builds the same world, to
 * the bit; each card's own camera then draws it.
 */
export function strengthWorld(ctx: SketchContext) {
  const spec = damSpec(ctx);
  const camera = worldCamera(ctx);
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, camera.position.z - p.z);
  const plan = damPlan(spec, f);
  const dam = buildDam(ctx, spec, plan);

  // The person: on the walkway, at a set fraction along the dam, a set height on the card (the print).
  const layout = seedLayout(ctx);
  const uf = clamp(n(ctx, 'figureAt', 0.72, 0.05, 0.95) + layout.figure, 0.05, 0.95);
  const pf = plan.at(uf), tf = plan.tangent(uf), df = downstream(tf);
  const walk = 2.5 + (spec.crest - 2.5) * 0.5;
  const stand = new THREE.Vector3(pf.x + df.x * walk, spec.height + 0.02, pf.z + df.z * walk);
  const figureMm = n(ctx, 'figure', 26, 12, 50);
  const figureH = figureMm / mmPerUnit(stand);
  const skeleton = poseSkeleton(personPose(), { height: figureH, position: stand, proportions: { ...ELONGATED, head: 1.0, neck: 1.3 } });
  const k = figureH / 24;
  const hand = skeleton.at('wrist_r').lerp(skeleton.at('wrist_r', true), 0.5).add(new THREE.Vector3(0, 1.5 * k, 0));
  const course = helixCourse(ctx, camera, spec, f, { headTop: skeleton.at('head', true), hand }, layout);
  return { spec, plan, dam, stand, skeleton, k, hand, course };
}
export type StrengthWorld = ReturnType<typeof strengthWorld>;

export function drawStrength(ctx: SketchContext): Part[] {
  const view = strengthCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  // The world, the same at every size; this card's camera draws it.
  const { spec, plan, dam, stand, skeleton, k, course } = strengthWorld(ctx);
  // `scratch` is the approved figure; `body` is the deck's current one. Same skeleton, so the hand and the head stay where they were.
  const figure = (ctx.params.figureStyle === 'body' ? bodyPerson : person)(skeleton, view);

  const helix = sleepingHelix(ctx, view, course);

  const light = new THREE.Vector3(n(ctx, 'lightX', 0, -1, 1), 0.55, n(ctx, 'lightZ', 0.12, 0.05, 1.5)).normalize();
  const strokes: Stroke[] = [];
  const slabs = [...dam.courses, ...dam.parapet];
  slabs.forEach((sl, owner) => {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const pitch = FACET_MM_PER_UNIT / mmPerUnit(at);
    const outline = Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5 || owner >= dam.courses.length;
    // The slabs keep all their edges on a small card, untrimmed: the trim (kit/slabs.ts) folds a sliver of a face into the
    // far edge, and here the far edges are hidden (the walkway's behind the parapet, the parapet's behind its own front),
    // so the crest and the parapet went missing. The wall is thinned on the page instead (see `addWall`).
    for (const st of facetStrokes(sl, light, eye, outline, pitch)) {
      strokes.push({ ink: st.ink, group: owner < dam.courses.length ? 'dam' : 'parapet', family: st.family, points: st.points, owner });
    }
  });
  const helixStrokes: Stroke[] = helix.strokes.map(h => ({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points }));
  // Off tabloid, which of them are strands drawn as their line (`narrowStrands`; at tabloid none is).
  const strandLine = new Set(FORMAT.tabloid ? [] : helixStrokes.filter((_, i) => helix.strokes[i].role === 'spine'));
  const figureStrokes: Stroke[] = figure.strokes.map(st => ({ ink: st.ink, group: 'figure', family: 'hatch', points: st.points }));
  // Its outlines, which a small card ranks above its bands or rings (see `person` below).
  const figureEdge = new Set(figureStrokes.filter((_, i) => figure.strokes[i].group === 'figure-edge'));

  const slabGeos = slabs.map(slabGeometry);
  const geometries = [...slabGeos, ...helix.meshes, ...figure.meshes];
  try {
    fitDepthRange(view, geometries);
    const fine = fineDepth(geometries, view, { W, H, MM_X, MM_Y }, OVERSAMPLE), px = fine.env;
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);
    const slack = n(ctx, 'slabSlack', 0.6, 0.1, 2);

    // Page masks: where the wall stands, where the helix lies, and the pocket of clear paper round the person.
    const damCover = meshCoverage(slabGeos, view, PAGE, halo(n(ctx, 'knockout', 0.6, 0.2, 2)));
    const helixKnockout = halo(n(ctx, 'helixKnockout', 1.1, 0.3, 3));
    const helixCover = meshCoverage(helix.meshes, view, PAGE, helixKnockout);
    const b = figure.bounds;
    // The pocket reaches well above the head and out on both sides but stops just under the feet, so the walkway shows.
    // Its reach round the figure scales with the card.
    const prx = (b.x1 - b.x0) / 2 * n(ctx, 'pocket', 1.5, 1, 3.5) + layoutLength(3), pry = (b.y1 - b.y0 + layoutLength(7)) / 2;
    const pc = { x: (b.x0 + b.x1) / 2, y: b.y0 - layoutLength(5.5) + pry };
    const pph = ctx.random('strength-pocket')() * Math.PI * 2;
    const inPocket = (p: Point) => {
      const dx = (p.x - pc.x) / prx, dy = (p.y - pc.y) / pry, a = Math.atan2(dy, dx);
      return Math.hypot(dx, dy) < 1 + 0.1 * Math.sin(5 * a + pph) + 0.06 * Math.sin(9 * a + 2 * pph);
    };

    // The crest of the wall on the sheet, to say where the lake ends.
    const crestLine: Point[] = Array.from({ length: 161 }, (_, i) => {
      const u = -0.05 + 1.1 * i / 160, q = plan.at(u);
      return pageOf(view, new THREE.Vector3(q.x, spec.height + spec.parapet, q.z));
    });
    const yAt = (line: Point[], x: number): number => {
      for (let i = 1; i < line.length; i++) {
        if ((line[i - 1].x - x) * (line[i].x - x) <= 0 && line[i].x !== line[i - 1].x) {
          return line[i - 1].y + (line[i].y - line[i - 1].y) * (x - line[i - 1].x) / (line[i].x - line[i - 1].x);
        }
      }
      return x < line[0].x ? line[0].y : line[line.length - 1].y;
    };

    // The phrase: a word to a course of the wall, on its downstream face, stretched back toward its
    // own proportions so the face's slant does not squeeze it to a sliver; or, where the format sets it in the band,
    // under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size };
    const wrng = ctx.random('strength-words');
    const stretch = n(ctx, 'wordStretch', 0.8, 0, 1);
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), px, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    const wantedCourse = [0.72, 0.28, 0.58, 0.16, 0.42];
    const used = new Set<number>();
    const edge = layoutLength(3);
    const unseen = (pts: Point[]) => pts.some(p => inPocket(p) || p.x < CARD.x0 + edge || p.x > CARD.x1 - edge || p.y > CARD.y1 - edge);
    words.forEach((word, wi) => {
      const targetX = CARD.x0 + (CARD.x1 - CARD.x0) * (0.2 + 0.64 * wi / Math.max(1, words.length - 1)) + (wrng() - 0.5) * layoutLength(12);
      const want = wantedCourse[wi % wantedCourse.length];
      const ranked = dam.courses.map((sl, i) => {
        const front = new THREE.Vector3(0, 0, sl.d / 2).applyMatrix4(slabMatrix(sl));
        const at = pageOf(view, front);
        const kc = dam.courseOf[i] / (spec.courses - 1);
        return { sl, i, at, score: Math.abs(at.x - targetX) + layoutLength(45) * Math.abs(kc - want) };
      }).filter(c => !used.has(c.i) && c.at.y > CARD.y0 && c.at.y < CARD.y1 - layoutLength(4)).sort((a, c) => a.score - c.score).slice(0, 80);
      for (const { sl, i } of ranked) {
        const m = slabMatrix(sl);
        const front = new THREE.Vector3(0, 0, sl.d / 2).applyMatrix4(m);
        const axis = new THREE.Vector3(1, 0, 0).transformDirection(m);
        const hx = Math.abs(pageOf(view, front.clone().addScaledVector(axis, 0.5)).x - pageOf(view, front.clone().addScaledVector(axis, -0.5)).x);
        const frontal = mmPerUnit(front);
        const unitX = (1 - stretch) / frontal + stretch / Math.max(hx, 0.05 * frontal);
        const unitY = 1 / frontal;
        const ww = measureStrokeText(word, style) * unitX, hh = style.height * unitY;
        if (ww > sl.w - 1 || hh > sl.h - 0.5) continue;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 1), y0 = hh / 2;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q2 => new THREE.Vector3(x0 + q2.x * unitX, y0 - q2.y * unitY, sl.d / 2 + 0.03).applyMatrix4(m)));
        const onPage = word3.flat().map(v => pageOf(view, v));
        if (unseen(onPage) || !visible(word3)) continue;
        textStrokes.push(...word3);
        used.add(i);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.6));

    // Every ordinary path goes through the reducer at the card's scale (`reduceAtScale`: the print's reducer at tabloid), so
    // the helix's turns and the person keep their curves on a small card.
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    const add = (key: string, run: Point[], keep: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && keep(p), 0.15)) buckets.add(key, piece, false, min);
    };
    // On a small card the wall's pieces wait for `thinRanked`: its outlines, then its faces' rings and hatch, then
    // the gorge's rules. At this size a joint's two edges, a ring beside its face's edge, or a rule beside a joint print as
    // one thick line: where a line runs beside one that ranks above it, closer than the pens hold apart, that stretch of
    // it is left out. The print adds each as it comes.
    type Ranked = { key: string; piece: Point[]; min?: number; rank: number };
    const wall: Ranked[] = [];
    const ranked = (into: Ranked[], rank: number, key: string, run: Point[], keep: (p: Point) => boolean = () => true, min?: number) => {
      if (FORMAT.tabloid) return add(key, run, keep, min);
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && keep(p), 0.15)) into.push({ key, piece, min, rank });
    };
    const addWall = (rank: number, key: string, run: Point[], keep: (p: Point) => boolean, min?: number) => ranked(wall, rank, key, run, keep, min);
    /** A ranked set's pieces, thinned (`thinRanked`) and bucketed, in rank order. */
    const thinInto = (list: Ranked[]) => {
      for (const { item, runs } of thinRanked(list, MIN_SPACING, { order: 'rank' })) for (const piece of runs) buckets.add(item.key, piece, false, item.min);
    };

    // The wall, a slab at a time, each with slack in world units at its own distance.
    const bySlab = new Map<number, Stroke[]>();
    for (const st of strokes) {
      const list = bySlab.get(st.owner!) ?? [];
      list.push(st);
      bySlab.set(st.owner!, list);
    }
    for (const [i, mine] of bySlab) {
      const sl = slabs[i];
      projectStrokes(mine, { ...px, bias: biasAt(slack, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, {
        // Off tabloid a scrap of a face's hatch shorter than the smallest feature is a speck, and dropped (`hatchMin`).
        begin: st => runs => { for (const run of runs) addWall(st.family === 'edge' ? 0 : 1, `${st.group}-${st.ink}`, scalePoints(run, fine.mmX, fine.mmY), p => !inPocket(p), hatchMin(st.family)); },
      });
    }
    // The helix, in depth bands so its slack stays the same distance in the world near and far. A strand drawn as its
    // line gets the surfaces' sag on top (`STRAND_SAG`), in bands of its own.
    const helixSlack = n(ctx, 'helixSlack', 0.4, 0.1, 2);
    // Up in the turn over the top (above where it is on the print), scraps (what the hidden-line cuts leave) are dropped:
    // under a millimetre and a half on the print, and as much less as the helix is smaller on a small card.
    const turnY = layoutY(TABLOID_CARD.y0 + 116), scrap = layoutLength(1.5);
    const bands = new Map<number, Stroke[]>(), lineBands = new Map<number, Stroke[]>();
    for (const st of helixStrokes) {
      const band = Math.floor(eye.distanceTo(st.points[Math.floor(st.points.length / 2)]) / 60);
      const into = strandLine.has(st) ? lineBands : bands;
      into.set(band, [...(into.get(band) ?? []), st]);
    }
    // On a small card the helix's surfaces are coarse against the paper, and its tail is thinner than the coverage's
    // cells: the paper kept round it is measured from its drawn lines too (none at tabloid, where the surfaces suffice).
    const helixRuns: Point[][] = [];
    for (const [slackOf, banded] of [[helixSlack, bands], [helixSlack + STRAND_SAG, lineBands]] as const) for (const [band, mine] of banded) {
      projectStrokes(mine, { ...px, bias: biasAt(slackOf, band * 60 + 30) }, {
        begin: st => runs => {
          for (const run of runs) {
            const page = scalePoints(run, fine.mmX, fine.mmY);
            if (!FORMAT.tabloid) helixRuns.push(page);
            add(`${st.group}-${st.ink}`, page, undefined, run[0].y * fine.mmY < turnY ? scrap : undefined);
          }
        },
      });
    }
    const nearHelix = glyphMask(helixRuns, helixKnockout);
    const aroundHelix = (p: Point) => helixCover(p) || nearHelix(p);
    // The person: tube lines with the slack the figure cards use. On a small card the person is a few millimetres tall and
    // its pieces are thinned as the wall's are, its outline first, then its bands or rings.
    const figureSlack = n(ctx, 'figureSlack', 1.2, 0.1, 3) * k;
    const person: Ranked[] = [];
    projectStrokes(figureStrokes, { ...px, bias: biasAt(figureSlack, eye.distanceTo(stand)) }, {
      begin: st => runs => { for (const run of runs) ranked(person, figureEdge.has(st) ? 0 : 1, `${st.group}-${st.ink}`, scalePoints(run, fine.mmX, fine.mmY)); },
    });
    thinInto(person);

    // The lake: dark ruled lines from the horizon down to the parapet, close at the horizon and
    // opening toward us, knocked out round the wall, the helix and the person. The ruling, its gaps and its breaks keep
    // their millimetres on paper, so a small card keeps the print's tone in fewer lines.
    const pattern = barPattern(ctx.random('strength-lake'), 0.93);
    const lakeBottom = Math.max(...crestLine.map(p => p.y));
    const lakePitch = tolerance(n(ctx, 'lakePitch', 0.54, 0.5, 1.2));
    const shore = halo(0.3);
    for (let y = HORIZON_Y + tolerance(0.7), i = 0; y < lakeBottom; i++) {
      const t = (y - HORIZON_Y) / (lakeBottom - HORIZON_Y);
      const ink = i % 4 === 0 ? 'ultramarine' : 'carbon';
      add(`lake-${ink}`, [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => p.y < yAt(crestLine, p.x) - shore && !damCover(p) && !aroundHelix(p) && !inPocket(p) && (t > 0.3 || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
      y += lakePitch * (1 + 0.5 * t ** 1.3);
    }
    // The gorge: the lower wall falls into shadow in long vertical rules, a few at first and every one at the foot. The
    // rules keep their pitch on paper; they start a set way down the wall, which scales with the card.
    const shade = n(ctx, 'gorge', 0.5, 0, 1);
    if (shade > 0) {
      const gap = tolerance(1.8 - 0.9 * shade), drop = layoutLength(14);
      for (let x = CARD.x0 + 0.5, i = 0; x < CARD.x1; x += gap, i++) {
        const top = yAt(crestLine, x) + drop;
        const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
        addWall(2, 'gorge-carbon', [{ x, y: top }, { x, y: CARD.y1 }], p => {
          const t = (p.y - top) / (CARD.y1 - top);
          return damCover(p) && !inPocket(p) && t > [0.05, 0.3, 0.6][tier];
        });
      }
    }
    thinInto(wall);
    // The sky: the deck's light ruling, full lines at the top that thin and break as they come down to the
    // horizon, knocked out well clear of the neck and head. Its own stream, so nothing else moves.
    const reachSky = n(ctx, 'sky', 0.45, 0, 1);
    if (reachSky > 0) {
      const skyPattern = barPattern(ctx.random('strength-sky'), 0.86);
      // The rules and their breaks keep their millimetres on paper; the clearing round the neck scales with the card.
      const clearing = halo(n(ctx, 'skyClear', 2.6, 0.5, 6));
      const skyCover = meshCoverage(helix.meshes, view, PAGE, clearing), skyNear = glyphMask(helixRuns, clearing);
      const skyClear = (p: Point) => skyCover(p) || skyNear(p);
      const skyTop = CARD.y0, skyBottom = HORIZON_Y - layoutLength(1);
      for (let y = skyTop + tolerance(0.3), i = 0; y < skyBottom; i++, y += tolerance(n(ctx, 'skyPitch', 1.3, 0.8, 2.5))) {
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
          return !skyClear(p) && (!broken || skyPattern[step % 64]) && (!thinner || skyPattern[(step * 3 + 17) % 64]);
        });
      }
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'lake', 'dam', 'gorge', 'parapet', 'helix', 'figure', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !damCover(p) && !aroundHelix(p), 0.3) });
    parts.push(...cardFrame('VIII', 'STRENGTH', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
