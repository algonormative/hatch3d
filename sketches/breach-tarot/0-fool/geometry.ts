import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, strandPoint, strandStrokes, type Strand } from '../../kit/helix.ts';
import { glyphMask, groundWord, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import { barPattern } from '../../kit/rhythm.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { bigSuit, bigSuitMeshes, bigSuitStrokes } from '../../kit/mannequin/big-suit.ts';
import { bodyMeshes, contourTube } from '../../kit/mannequin/body.ts';
import { ELONGATED, flowBody, gesture } from '../../kit/mannequin/gesture.ts';
import { LOOK } from '../../kit/mannequin/hatch.ts';
import { walkCycle } from '../../kit/mannequin/motion.ts';
import { grip } from '../../kit/mannequin/pieces.ts';
import { poseSkeleton, withPose } from '../../kit/mannequin/skeleton.ts';
import { silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * 0 The Fool: a maze of his own making. The maze is the Fool's own wandering: a seeded walk that
 * carves it cell by cell from an entrance far off on the horizon, and he stands where the walk has
 * got to, in the big suit, looking up, carrying the next block like a briefcase. Every wall is as
 * old as the walk that raised it, and kept building: the newest beside him are only waist high (he
 * could step over any of them); the oldest, far back, have grown into a skyline of courses that lean,
 * slip, drop blocks and break open upward, some blocks still in the air, his head among them. Walls
 * not yet decided are dashed footprints on the open ground in front of him, and his face is a blank
 * egg with only its dashed construction cross: not decided either. The helix is his tie, knotted at
 * the throat and streaming up out of the maze into the open sky. Where the old card's sun stands, a
 * quiet flat echo of XIX's sun is the card's flat mark.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FIGURE = 24;
const EYE = 12;
const CELL = 20, THICK = 2.2, COURSE = 2.5, COPING = 0.7;
/** Page millimetres per world unit at the Tower's slab depth, where the facet hatch is tuned. */
const FACET_MM_PER_UNIT = 8.3;

export function foolCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    // The near plane sits just short of the nearest ground in view: depth precision is what keeps
    // the body hidden inside the suit, a few units behind the cloth.
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 3000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

type Cell = { c: number; r: number; x: number; z: number; t: number };

/** The grid's axes on the ground: columns run along `u`, rows recede along `v`, turned `angle` degrees from the picture plane. */
function gridAxes(angle: number): { u: THREE.Vector3; v: THREE.Vector3 } {
  const a = THREE.MathUtils.degToRad(angle);
  return { u: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), v: new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)) };
}
const key = (c: number, r: number) => `${c},${r}`;

export interface Maze {
  cells: Map<string, Cell>;
  /** The visit time of the Fool's cell: cells visited later are not made yet. */
  now: number;
  /** Open passages between neighbouring cells, by `a|b` key. */
  open: Set<string>;
  /** The walk's stack when it reached the Fool: his path back to the entrance, entrance first. */
  thread: Cell[];
  fool: Cell;
  entrance: Cell;
  axes: { u: THREE.Vector3; v: THREE.Vector3 };
}

const pair = (a: Cell, b: Cell) => (key(a.c, a.r) < key(b.c, b.r) ? `${key(a.c, a.r)}|${key(b.c, b.r)}` : `${key(b.c, b.r)}|${key(a.c, a.r)}`);

/**
 * The maze, carved by a seeded depth-first walk from an entrance far off toward the horizon. The walk
 * leans away from the Fool's cell, so it wanders the whole field before it reaches him: he is where
 * it has got to, and everything nearer him is still to be made. The grid is turned to the view (45°
 * by default) so both directions of wall recede and the corridors read as a lattice.
 */
export function maze(ctx: SketchContext, view: THREE.Camera, foot: THREE.Vector3): Maze {
  const rng = ctx.random('fool-maze');
  const cells = new Map<string, Cell>();
  const mmPerUnit = (d: number) => TABLOID_PAGE.height / (2 * d * Math.tan(THREE.MathUtils.degToRad((view as THREE.PerspectiveCamera).fov / 2)));
  const axes = gridAxes(n(ctx, 'gridAngle', 45, 0, 45));
  const eyeZ = view.position.z;
  const reach = (eyeZ - foot.z) + Math.round(n(ctx, 'depth', 12, 6, 24)) * CELL;
  for (let r = -6; r <= 60; r++) for (let c = -60; c <= 60; c++) {
    const at = foot.clone().addScaledVector(axes.u, c * CELL).addScaledVector(axes.v, r * CELL).setY(0);
    const dist = eyeZ - at.z;
    // In front of the eye, inside the card's width, near enough to draw, and big enough to plot.
    if (dist < 14 || dist > reach || mmPerUnit(dist) * CELL < 3.5) continue;
    const p = pageOf(view, at);
    if (p.x < CARD.x0 - 40 || p.x > CARD.x1 + 40) continue;
    // Ground nearer the eye than the Fool is still to come: the walk has not been there.
    cells.set(key(c, r), { c, r, x: at.x, z: at.z, t: at.z > foot.z + CELL * 0.3 ? Infinity : -1 });
  }
  const fool = cells.get(key(0, 0))!;
  // The way in: the farthest cell, near the middle of the view.
  const entrance = [...cells.values()].sort((a, b) => (a.z + 0.3 * Math.abs(a.x - foot.x)) - (b.z + 0.3 * Math.abs(b.x - foot.x)))[0];
  const lean = n(ctx, 'wander', 0.5, 0, 1) * 0.6;
  const open = new Set<string>();
  const stack: Cell[] = [entrance];
  let clock = 0;
  entrance.t = clock++;
  let thread: Cell[] = [];
  while (stack.length) {
    const here = stack[stack.length - 1];
    if (here === fool && !thread.length) thread = [...stack];
    const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => cells.get(key(here.c + dc, here.r + dr))).filter((cl): cl is Cell => !!cl && cl.t === -1);
    if (!next.length) { stack.pop(); continue; }
    // Weighted by distance from the Fool: the walk tends away from him, and reaches him late.
    const weights = next.map(cl => Math.exp(lean * Math.hypot(cl.c - fool.c, cl.r - fool.r)));
    let pick = rng() * weights.reduce((a, b) => a + b, 0), i = 0;
    while (i < next.length - 1 && (pick -= weights[i]) > 0) i++;
    const go = next[i];
    go.t = clock++;
    open.add(pair(here, go));
    stack.push(go);
  }
  return { cells, now: fool.t, open, thread, fool, entrance, axes };
}

export interface Wall { slabs: Slab[]; age: number; collapse: number; far: boolean }

/**
 * The walls the walk has made, block by block, each as old as the walk that closed it, collapsing
 * with age: leaning off its base, courses slipping, blocks dropping beside it or still falling.
 * Walls the walk has not decided come back as footprints.
 */
export function walls(ctx: SketchContext, view: THREE.Camera, m: Maze): { walls: Wall[]; undecided: THREE.Vector3[][] } {
  const rng = ctx.random('fool-walls');
  // The fray has its own stream, so how much the tall walls dissolve never moves the maze itself.
  const fray = { rng: ctx.random('fool-fray'), amount: n(ctx, 'fray', 0.5, 0, 1) };
  const decay = n(ctx, 'collapse', 0.5, 0, 1);
  const out: Wall[] = [];
  const undecided: THREE.Vector3[][] = [];
  const made = (cl?: Cell) => !!cl && cl.t >= 0 && cl.t <= m.now;
  const eyeZ = view.position.z;
  const seen = new Set<string>();
  for (const a of m.cells.values()) {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = m.cells.get(key(a.c + dc, a.r + dr));
      const id = b ? pair(a, b) : `${key(a.c, a.r)}>${dc},${dr}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (b && m.open.has(id) && made(a) && made(b)) continue;
      const step = m.axes.u.clone().multiplyScalar(dc * CELL).addScaledVector(m.axes.v, dr * CELL);
      const mid = new THREE.Vector3(a.x, 0, a.z).addScaledVector(step, 0.5);
      const mx = mid.x, mz = mid.z;
      // The wall runs square to the step between the two cells.
      const dir = (dc !== 0 ? m.axes.v : m.axes.u).clone();
      const madeA = made(a), madeB = b ? made(b) : false;
      if (!madeA && !madeB) continue;
      // The way in: the entrance's far wall stays open; and the field's edge nearer the eye than the
      // Fool is open ground he has not reached.
      if (!b && ((a === m.entrance && step.z < 0) || mz > m.fool.z - CELL * 0.3)) continue;
      // A wall between made and unmade ground is undecided: a footprint.
      if (madeA !== madeB && b) {
        const across = new THREE.Vector3(dir.z, 0, -dir.x);
        undecided.push([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sz]) =>
          mid.clone().addScaledVector(dir, sx * CELL / 2).addScaledVector(across, sz * THICK / 2).setY(0.02)));
        continue;
      }
      const t = Math.max(madeA ? a.t : 0, madeB ? b!.t : 0);
      const age = 1 - t / Math.max(1, m.now);
      const collapse = clamp(smooth(0.55 - 0.4 * decay, 1.02 - 0.2 * decay, age), 0, 1);
      const dist = eyeZ - mz;
      const far = TABLOID_PAGE.height / (2 * dist * Math.tan(THREE.MathUtils.degToRad((view as THREE.PerspectiveCamera).fov / 2))) * COURSE < 1.6;
      // He keeps building: the older a wall, the more courses it has grown.
      const courses = 2 + Math.round(n(ctx, 'grow', 0.5, 0, 1) * 64 * age ** 2.4 * (0.7 + 0.6 * rng()));
      const slabs = wallSlabs(rng, mx, mz, dir, collapse, far, courses, fray);
      // Weathered: the older the wall, the heavier its hatch.
      for (const sl of slabs) sl.tone = 0.4 + 0.6 * age;
      out.push({ slabs, age, collapse, far });
    }
  }
  return { walls: out, undecided };
}

/** One wall segment: three courses of blocks and a coping, then its collapse. */
function wallSlabs(rng: () => number, mx: number, mz: number, dir: THREE.Vector3, collapse: number, far: boolean, courses: number,
  fray: { rng: () => number; amount: number }): Slab[] {
  const len = CELL + THICK;
  const local: { x: number; y: number; w: number; h: number; d: number; course: number }[] = [];
  if (far) local.push({ x: 0, y: (courses * COURSE + COPING) / 2, w: len, h: courses * COURSE + COPING, d: THICK, course: 0 });
  else {
    for (let k = 0; k < courses; k++) {
      let x = -len / 2;
      while (x < len / 2 - 0.5) {
        const w = Math.min(len / 2 - x, 3.6 + 4.4 * rng());
        local.push({ x: x + w / 2, y: COURSE * (k + 0.5), w: w - 0.12, h: COURSE - 0.1, d: THICK, course: k });
        x += w;
      }
    }
    local.push({ x: 0, y: courses * COURSE + COPING / 2, w: len + 0.6, h: COPING, d: THICK + 0.7, course: courses });
  }
  // Collapse: the wall leans off its base toward one side, its courses slip along it, and blocks
  // come away, the top ones first: lying beside it, or still falling.
  const lean = collapse ** 1.4 * (0.12 + 0.5 * rng()) * (rng() < 0.5 ? -1 : 1);
  const slip = (k: number) => collapse * (rng() - 0.5) * 2.2 * k;
  const breach = collapse > 0.72 && rng() < 0.6 ? { at: (rng() - 0.5) * len * 0.5, half: (0.15 + 0.25 * rng()) * len * collapse } : null;
  const slabs: Slab[] = [];
  const across = new THREE.Vector3(dir.z, 0, -dir.x);
  const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(mx, y, mz).addScaledVector(dir, x).addScaledVector(across, z);
  // The yaw that turns a slab's length onto the wall's line.
  const yaw = Math.atan2(-dir.z, dir.x);
  const slips = Array.from({ length: courses + 1 }, (_, k) => slip(k / 3));
  for (const b of local) {
    const high = b.course / Math.max(1, courses);
    const gone = !far && (rng() < collapse ** 2 * (0.12 + 0.66 * high) || (breach && Math.abs(b.x - breach.at) < breach.half && high >= 1 - 1.15 * collapse));
    if (gone) {
      const roll = rng();
      if (roll < 0.55) {
        // Fallen: on the ground beside the wall, tumbled.
        const side = rng() < 0.5 ? -1 : 1;
        const p = toWorld(b.x + (rng() - 0.5) * 3, b.h / 2, side * (THICK + 1.5 + 4 * rng()));
        const s = solid(p.x, p.y, p.z, b.w, b.h, b.d, slabs.length, 'fallen');
        s.ry = yaw + (rng() - 0.5) * 1.2; s.rz = (rng() - 0.5) * 0.25; s.rx = (rng() - 0.5) * 0.25;
        slabs.push(s);
      } else if (roll < 0.55 + 0.3 * collapse) {
        // Still falling: in the air above or beside the wall, turning.
        const p = toWorld(b.x + (rng() - 0.5) * 6, b.y * (0.5 + 0.7 * rng()) + COURSE * 2 * rng() + b.y * 0.9 * rng() ** 2, (rng() - 0.5) * (6 + 0.3 * b.y));
        const s = solid(p.x, p.y, p.z, b.w, b.h, b.d, slabs.length, 'debris');
        s.rx = (rng() - 0.5) * 1.6; s.ry = yaw + (rng() - 0.5) * 1.6; s.rz = (rng() - 0.5) * 1.6;
        slabs.push(s);
      }
      continue;
    }
    // Fraying: up a grown wall, blocks lift away and keep rising, the higher the more of them. Walls
    // already coming down, and copings, are left to their collapse.
    const frayAt = b.course >= courses ? 0 : fray.amount * 1.1 * clamp((b.y - 4) / 28, 0, 1) ** 1.2 * clamp(1 - collapse / 0.3, 0, 1);
    if (!far && frayAt > 0 && fray.rng() < frayAt) {
      const f = fray.rng;
      const p = toWorld(b.x + (f() - 0.5) * 7, b.y + COURSE * (1 + 3 * f()) + b.y * 0.7 * f() ** 1.6, (f() - 0.5) * (5 + 0.25 * b.y));
      const s = solid(p.x, p.y, p.z, b.w, b.h, b.d, slabs.length, 'debris');
      s.rx = (f() - 0.5) * 1.8; s.ry = yaw + (f() - 0.5) * 1.8; s.rz = (f() - 0.5) * 1.8;
      slabs.push(s);
      continue;
    }
    // Standing: lean the course stack about the wall's base line, slipping each course along the wall.
    const x = b.x + slips[b.course];
    const y = b.y * Math.cos(lean), off = b.y * Math.sin(lean);
    const p = toWorld(x, y, off);
    const s = solid(p.x, p.y, p.z, b.w, b.h, b.d, slabs.length, far ? 'pier' : 'stack');
    // Turn onto the wall's line, then lean about it: as Euler angles in the slab's XYZ order.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lean));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    s.rx = e.x; s.ry = e.y; s.rz = e.z;
    slabs.push(s);
  }
  return slabs;
}

/**
 * The helix as his tie: the deck's twin strands, knotted at his collar, thrown out ahead of him and
 * then streaming up beside his head and on into the open sky. The strands are built in their own
 * upright space and bent onto the tie's path.
 */
function tieHelix(ctx: SketchContext, view: THREE.Camera, knot: THREE.Vector3, facing: THREE.Vector3): { strokes: Stroke[]; meshes: THREE.BufferGeometry[] } {
  const up = new THREE.Vector3(0, 1, 0);
  const left = new THREE.Vector3().crossVectors(up, facing).normalize();
  const reach = n(ctx, 'tie', 0.5, 0, 1);
  const at = (f: number, u: number, l: number) => knot.clone().addScaledVector(facing, f).addScaledVector(up, u).addScaledVector(left, l);
  const curve = new THREE.CatmullRomCurve3([
    at(0, 0, 0), at(2.2, -1.4, -0.6), at(3.2, 1, -3.4), at(0.5, 6.5, -7.5), at(-3, 15 + 6 * reach, -5.5),
    at(-6.5, 26 + 12 * reach, 0.5), at(-10, 37 + 20 * reach, -3), at(-14, 49 + 28 * reach, 0.5),
  ], false, 'centripetal');
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.35 } });
  const strands: Strand[] = template.map((st, i) => ({
    ...st, x: knot.x, y: knot.y, z: knot.z, y0: 0, y1: length, radius: 1.0 + 0.15 * i, depth: 1, width: 0.95 - 0.1 * i,
    swell: 0, centre: -1e3, turns: length / 9,
  }));
  // Bend a point of upright strand space onto the tie's path: height along the strand becomes arc
  // length along the curve, the sideways offsets ride the curve's frame.
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - knot.y) / length, 0, 1);
    const k = Math.min(400, Math.round(u * 400));
    return curve.getPointAt(u).addScaledVector(frames.normals[k], p.x - knot.x).addScaledVector(frames.binormals[k], p.z - knot.z - 0.25);
  };
  const strokes: Stroke[] = [];
  for (const st of strands) for (const h of strandStrokes(st, 0.35, 0.3, ctx, view)) {
    strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points.map(bend) });
  }
  const meshes = strands.map(st => buildSurfaceMesh((u, v) => bend(strandPoint(st, u, 2 * v - 1)), {}, 320, 8));
  return { strokes, meshes };
}

export function drawFool(ctx: SketchContext): Part[] {
  const view = foolCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => TABLOID_PAGE.height / (2 * Math.max(1, eye.z - p.z) * fovT);
  // The Fool stands near the foot of the card, right of centre, walking left into the open ground.
  const foot = onGround(view, { x: CARD.x0 + (CARD.x1 - CARD.x0) * n(ctx, 'foolX', 0.6, 0.3, 0.75), y: CARD.y1 - n(ctx, 'footY', 32, 10, 80) });
  const m = maze(ctx, view, foot);
  const { walls: built, undecided } = walls(ctx, view, m);
  const light = new THREE.Vector3(-0.6, 0.42 + 0.5 * n(ctx, 'lightAngle', 0.3, 0, 1), 0.6).normalize();

  // The Fool: the gesture walk, the big suit, head up, the next block swinging from his hand.
  const pose = withPose(gesture(withPose(walkCycle(0), { neck: { flex: -n(ctx, 'lookUp', 12, 0, 40) }, head: { flex: -n(ctx, 'lookUp', 12, 0, 40) * 0.6 } }), { push: 1.3, arc: -10, wring: 8, lean: 5 }),
    {}, { yaw: -n(ctx, 'facing', 38, 0, 90) });
  const s = poseSkeleton(pose, { height: FIGURE, position: foot, proportions: { ...ELONGATED, head: 0.72, neck: n(ctx, 'neck', 1.9, 1, 2.6) } });
  const body = flowBody(s, { toes: 'curl' });
  const suit = bigSuit(s, { size: n(ctx, 'suit', 1.6, 1, 2.2), feet: body.limbs });
  const facing = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-n(ctx, 'facing', 38, 0, 90)));
  const g = grip(s, 'l');
  const handle = g.at.clone().add(new THREE.Vector3(0, -1.6, 0));
  const carried = solid(handle.x, handle.y - 1.5, handle.z, 5.4, 3.0, THICK, 0, 'debris');
  carried.ry = Math.atan2(facing.x, facing.z) + Math.PI / 2; carried.rz = 0.1;
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const env = {
    forward, density: n(ctx, 'density', 0.4, 0, 1),
    screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; },
    dark: (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.95 - 0.95 * Math.max(0, normal.dot(light)), 0, 1),
  };
  const shoes = { ...LOOK, cloth: 'carbon' as const, accent: 'carbon' as const };
  const head = body.head!;
  /** A world polyline cut into dashes, about 0.2 units on and 0.15 off. */
  const dashed = (pts: THREE.Vector3[]): ClothStroke[] => {
    const out: ClothStroke[] = [];
    let run: THREE.Vector3[] = [], along = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) along += pts[i].distanceTo(pts[i - 1]);
      if (along % 0.35 < 0.2) run.push(pts[i]);
      else { if (run.length > 1) out.push({ ink: 'carbon', group: 'contour', points: run }); run = []; }
    }
    if (run.length > 1) out.push({ ink: 'carbon', group: 'contour', points: run });
    return out;
  };
  const figureStrokes: ClothStroke[] = [
    ...bigSuitStrokes(suit, env, LOOK, { motley: ctx.params.motley === true, wind: null }),
    ...body.limbs.flatMap(t => [...contourTube(t, env, t.id.startsWith('leg') ? shoes : LOOK), ...silhouettes(t, env, { ink: LOOK.edge, group: LOOK.contour })]),
    // The head: nearly blank, hatched only in its deepest shadow, and the dashed construction cross
    // of a face not drawn yet.
    ...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.45) }, LOOK),
    ...silhouettes(head, env, { ink: LOOK.edge, group: LOOK.contour }),
    ...dashed(Array.from({ length: 61 }, (_, i) => head.point(0.12 + 0.8 * i / 60, 0.25, 0.02))),
    ...dashed(Array.from({ length: 41 }, (_, i) => head.point(0.5, 0.25 + 0.17 * (i / 20 - 1), 0.02))),
    // The handle: a loop from the cuff to the block's top.
    ...[-1.2, 1.2].map(dx => ({ ink: 'carbon' as const, group: 'contour', points: [g.at.clone(), handle.clone().addScaledVector(facing, dx), new THREE.Vector3(carried.x, carried.y + 1.5, carried.z).addScaledVector(facing, dx * 1.2)] })),
  ];

  const strokes: Stroke[] = [];
  for (const st of figureStrokes) strokes.push({ ink: st.ink, group: st.group === 'contour' ? 'figure-edge' : 'figure', family: st.family ?? 'hatch', points: st.points });
  strokes.push(...facetStrokes(carried, light, eye, false, FACET_MM_PER_UNIT / mmPerUnit(new THREE.Vector3(carried.x, carried.y, carried.z)))
    .map(st => ({ ink: st.ink, group: 'figure', family: st.family, points: st.points })));
  const allSlabs: Slab[] = [];
  for (const w of built) for (const sl of w.slabs) {
    allSlabs.push(sl);
    const scale = FACET_MM_PER_UNIT / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
    const pageSize = Math.max(sl.w, sl.h) * mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
    const outline = pageSize < 1.5;
    const group = sl.role === 'fallen' || sl.role === 'debris' ? 'collapse' : 'maze';
    for (const st of facetStrokes(sl, light, eye, outline, scale)) strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
  }
  // The knot sits on the throat, just above the buttoned collar, so the tie leaves from the neck itself.
  const knot = s.at('neck').lerp(s.at('head'), n(ctx, 'knot', 0.55, 0, 1)).addScaledVector(s.axes('neck').z, 0.55);
  const tie = tieHelix(ctx, view, knot, facing);
  strokes.push(...tie.strokes);

  const geometries = [...allSlabs.map(slabGeometry), slabGeometry(carried), ...bodyMeshes(body, 0.8), ...bigSuitMeshes(suit), ...tie.meshes];
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const figureCover = meshCoverage([...bodyMeshes(body, 0.5), ...bigSuitMeshes(suit, 0.5), slabGeometry(carried)], view, TABLOID_PAGE, 2.5);
    // The phrase, painted on the open ground in front of him and down the near corridors, staggered.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size + 0.4 };
    const wrng = ctx.random('fool-words');
    const textStrokes: THREE.Vector3[][] = [];
    const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const top = HORIZON_Y + 22, bottom = CARD.y1 - 6;
    let side = wrng() < 0.5 ? -1 : 1;
    let lastY = top - 8;
    words.forEach((word, i) => {
      const half = measureStrokeText(word, style) / 2 + 3;
      for (let attempt = 0; attempt < 160; attempt++) {
        const yy = top + (bottom - top) * clamp((i + 0.5) / words.length + (wrng() - 0.5) * 0.25 * (1 + attempt / 20), 0, 1);
        if (yy < lastY + 4) continue;
        const xx = clamp((CARD.x0 + CARD.x1) / 2 + side * (10 + 90 * wrng()), CARD.x0 + half + 2, CARD.x1 - half - 2);
        const box = { x0: xx - half - 3, x1: xx + half + 3, y0: yy - 6, y1: yy + 6 };
        if (taken.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        const word3 = groundWord(view, word, { x: xx, y: yy }, style);
        let total = 0, seen = 0, blocked = false;
        const count = (hidden: boolean, add: (k: number) => void) => projectStrokes(word3.map(points => ({ points })), { view, depth, width: W, height: H }, {
          hidden: () => hidden, begin: () => runs => { for (const r of runs) add(r.length); },
        });
        count(false, k => { total += k; });
        count(true, k => { seen += k; });
        for (const path3 of word3) for (const p of path3) { const q = pageOf(view, p); if (figureCover(q)) blocked = true; }
        if (blocked || seen < total * 0.97) continue;
        textStrokes.push(...word3);
        taken.push(box);
        lastY = yy;
        break;
      }
      side = -side;
    });
    const glyphPaths: Point[][] = [];
    const lettering = projectPolylinesClipped(textStrokes, view, W, H);
    for (const line of lettering.polylines) for (const c of clipProjectedPolyline(line, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.8);
    const buckets = new PartBuckets(0.4);
    const solidThings = meshCoverage(geometries, view, TABLOID_PAGE, 0.4);
    const add = (key: string, run: Point[]) => { for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p), 0.15)) buckets.add(key, piece); };
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // Shadows on the ground: each standing block cast along the light, hatched in rows across the
    // ground; the depth pass hides what the walls stand in front of.
    const shadows = allSlabs.filter(sl => sl.role !== 'debris').map(sl => {
      const g2 = slabGeometry(sl);
      const pos = g2.getAttribute('position');
      const pts: { x: number; z: number }[] = [];
      for (let k = 0; k < pos.count; k++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, k);
        pts.push({ x: v.x - light.x * v.y / light.y, z: v.z - light.z * v.y / light.y });
      }
      g2.dispose();
      return hull(pts);
    });
    const shadowRows: Stroke[] = [];
    for (let y = HORIZON_Y + 0.6, k = 0; y < CARD.y1; y += 0.62 + 0.004 * (y - HORIZON_Y), k++) {
      const z = onGround(view, { x: TABLOID_PAGE.width / 2, y }).z;
      const spans: [number, number][] = [];
      for (const poly of shadows) {
        const xs: number[] = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          if ((a.z - z) * (b.z - z) < 0) xs.push(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
        }
        if (xs.length >= 2) spans.push([Math.min(...xs), Math.max(...xs)]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]); }
      for (const [x0, x1] of merged) shadowRows.push({ ink: k % 4 === 0 ? 'ultramarine' : 'carbon', group: 'shadow', family: 'hatch', points: [new THREE.Vector3(x0, 0.03, z), new THREE.Vector3(x1, 0.03, z)] });
    }
    projectStrokes(shadowRows, { view, depth, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // Undecided walls: dashed footprints on the open ground.
    const dash = (run: Point[], on: number, off: number, key: string) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, (p, at) => at % (on + off) < on && !onGlyph(p) && !figureCover(p), 0.1)) buckets.add(key, piece);
    };
    projectStrokes(undecided.map(points => ({ points })), { view, depth, width: W, height: H }, {
      begin: () => runs => { for (const run of runs) dash(scalePoints(run, MM_X, MM_Y), 1.6, 1.2, 'undecided-carbon'); },
    });
    // The flat mark: where the old card's sun stands, a quiet echo of XIX's: a paper disc with fine
    // rims, rays alternating straight and twisting, and fine rays over the sky broken by the 64-step
    // rhythm. Drawn flat, all in the lightest pen, kept clear of everything in front of it.
    if (ctx.params.sun !== false) {
      const c = { x: CARD.x1 - n(ctx, 'sunInset', 0.2, 0.08, 0.4) * (CARD.x1 - CARD.x0), y: CARD.y0 + n(ctx, 'sunDrop', 0.13, 0.05, 0.3) * (CARD.y1 - CARD.y0) };
      const R = n(ctx, 'sunSize', 18, 10, 40);
      const sky = { ...CARD, y1: HORIZON_Y - 6 };
      const clearOf = meshCoverage(geometries, view, TABLOID_PAGE, 2.2);
      const clear = (p: Point) => !clearOf(p) && !onGlyph(p);
      const put = (key: string, run: Point[], keep: (p: Point, at: number) => boolean = clear) => {
        for (const inside of clipWindow(run, sky)) for (const piece of keepAlong(inside, keep, 0.12)) buckets.add(key, piece);
      };
      const at = (a: number, r: number): Point => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
      for (const r of [R, R - 0.9]) put('sun-acid', Array.from({ length: 241 }, (_, i) => at(i / 240 * Math.PI * 2, r)));
      const srng = ctx.random('fool-sun');
      const count = 12, spin = srng() * Math.PI / count;
      for (let k = 0; k < count; k++) {
        const a = spin + k * Math.PI * 2 / count;
        const r0 = R * 1.12, r1 = R * (k % 4 === 0 ? 2.5 : k % 2 === 0 ? 2.0 : 2.25);
        const nx = -Math.sin(a), ny = Math.cos(a);
        const side = (r: number, w: number): Point => ({ x: c.x + r * Math.cos(a) + nx * w, y: c.y + r * Math.sin(a) + ny * w });
        if (k % 2 === 0) {
          // Straight: a long thin slab seen flat, narrowing to its tip.
          const w0 = R * 0.09, w1 = R * 0.035;
          put('sun-acid', [side(r0, -w0), side(r1, -w1), side(r1, w1), side(r0, w0), side(r0, -w0)]);
        } else {
          // Twisting: two strands crossing as the helix's do, narrowing to the tip.
          for (const sgn of [-1, 1]) put('sun-acid', Array.from({ length: 80 }, (_, i) => {
            const f = i / 79, r = r0 + (r1 - r0) * f;
            return side(r, sgn * R * 0.1 * (1 - 0.6 * f) * Math.sin(f * Math.PI * 2 * 2.2 + k));
          }));
        }
      }
      // Fine rays over the sky beyond the rays, broken into the rhythm, thinning with distance.
      const pattern = barPattern(srng, 0.7);
      const fine = Math.round(48 + 64 * n(ctx, 'radiance', 0.5, 0, 1));
      for (let k = 0; k < fine; k++) {
        const a = (k + 0.5) / fine * Math.PI * 2;
        if (k % 3 === 1) continue;
        const r0 = R * (1.3 + 0.25 * (k % 3));
        put('sun-acid', [at(a, r0), at(a, 260)], (p, along) => clear(p)
          && pattern[Math.floor(along / (2.2 + 0.05 * Math.hypot(p.x - c.x, p.y - c.y))) % 64]
          && Math.hypot(p.x - c.x, p.y - c.y) < R * (2.8 + 1.2 * ((k * 7) % 5) / 4));
      }
    }
    for (const path2 of glyphPaths) buckets.add('slogan-lettering', path2, true);
    const parts = buckets.toParts(['maze', 'collapse', 'shadow', 'undecided', 'figure', 'figure-edge', 'helix', 'sun', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p), 0.3) });
    parts.push(...cardFrame('0', 'THE FOOL'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}

/** Convex hull of ground points (monotone chain). */
function hull(pts: { x: number; z: number }[]): { x: number; z: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: typeof p = [], upper: typeof p = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
