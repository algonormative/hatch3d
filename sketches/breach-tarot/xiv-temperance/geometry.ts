import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, type Slab } from '../../kit/slabs.ts';
import type { HelixStroke } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { twinHelix, type StrandPlan } from './helix.ts';
import { buildVessel, type Vessel } from './vessel.ts';

/**
 * XIV Temperance: it goes both ways. No figure, and no angel: liquidity. Two tower-vessels, built
 * of slab courses, stand at different distances, the near one on dry paved ground (slabs in courses
 * running up to the shore, which cuts them), the far one in water, which gives it back upside down
 * as a quiet reflection broken by ripples. A shoreline crosses the ground on a diagonal and the
 * water is ruled darker than the land. The helix pours between the vessels in an arc gravity would
 * not allow: it climbs from the far vessel's rim to the near one's, and its two strands flow
 * opposite ways, each spilling over the rim it arrives at (the near one down the front of its
 * vessel, clear of the vessel's edge) while the other goes into the vessel's mouth. The sky is
 * lightly ruled and knocked out round everything in it; the phrase is cut into the vessels'
 * courses, word by word.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const PW = TABLOID_PAGE.width;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/** The helix is built this many times the size and brought back: the kit's wiggles are fixed in world units. */
const S = 4;

export function temperanceCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const eye = n(ctx, 'eye', 6, 3, 12);
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, eye, 0], target: [0, eye, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

const focalOf = (view: THREE.PerspectiveCamera) => TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
/** The world point at page position `p`, `t` units in front of the eye. */
const worldAt = (view: THREE.PerspectiveCamera, p: Point, t: number) =>
  new THREE.Vector3((p.x - PW / 2) * t / focalOf(view), view.position.y + (HORIZON_Y - p.y) * t / focalOf(view), -t);

/** Where the shoreline lies across the ground: its x on the ground plane at depth t. Land is to its left. */
function shoreline(ctx: SketchContext, view: THREE.PerspectiveCamera): (t: number) => number {
  const f = focalOf(view);
  const rng = ctx.random('temperance-shore');
  const p1 = rng() * 6.28, p2 = rng() * 6.28;
  const vanish = n(ctx, 'shoreVanish', 92, 40, 200), foot = n(ctx, 'shoreFoot', 250, 150, 330);
  const tFoot = f * view.position.y / (CARD.y1 - HORIZON_Y - 1);
  const k = (vanish - PW / 2) / f;
  const x0 = (foot - PW / 2) * tFoot / f;
  const wobble = n(ctx, 'shoreWobble', 5, 0, 14);
  // A line that vanishes at `vanish`, bent a little: the bend is the same size on the sheet at any depth.
  return t => x0 + k * (t - tFoot) + wobble * t / f * (0.7 * Math.sin(2.6 * Math.log(t) + p1) + 0.35 * Math.sin(6.1 * Math.log(t) + p2));
}

interface Layout {
  near: Vessel; far: Vessel;
  /** The helix's two strands. */
  plans: StrandPlan[];
  scaleAt: (p: THREE.Vector3) => number;
}

function layout(ctx: SketchContext, view: THREE.PerspectiveCamera): Layout {
  const f = focalOf(view), eye = view.position.y;
  const rimHeight = (rimY: number, depth: number) => eye + (HORIZON_Y - rimY) * depth / f - 0;
  const nearDepth = n(ctx, 'nearDepth', 100, 45, 140), farDepth = n(ctx, 'farDepth', 190, 150, 600);
  const nearX = (n(ctx, 'nearX', 74, 30, 120) - PW / 2) * nearDepth / f, farX = (n(ctx, 'farX', 214, 170, 250) - PW / 2) * farDepth / f;
  const nearHeight = rimHeight(n(ctx, 'nearRim', 92, 50, 150), nearDepth), farHeight = rimHeight(n(ctx, 'farRim', 190, 120, 240), farDepth);
  const near = buildVessel(ctx, {
    x: nearX, z: -nearDepth, height: nearHeight, width: n(ctx, 'nearWidth', 10, 5, 16), yaw: n(ctx, 'nearYaw', -0.5, -1.2, 1.2),
    courses: Math.round(n(ctx, 'nearCourses', 17, 8, 22)), stream: 'temperance-near',
  });
  const far = buildVessel(ctx, {
    x: farX, z: -farDepth, height: farHeight, width: n(ctx, 'farWidth', 14, 6, 24), yaw: n(ctx, 'farYaw', -0.6, -1.2, 1.2),
    courses: Math.round(n(ctx, 'farCourses', 13, 8, 22)), stream: 'temperance-far',
  });
  const above = (v: Vessel, up: number, out = 0, dir = v.front) => v.axis.clone().addScaledVector(dir, out).setY(v.rim + up);

  // The arc between the rims: it climbs from the far vessel's mouth to the near one's, swinging toward us.
  const knots: [number, number, number][] = [
    [217, 150, 188], [206, 118, 170], [186, 92, 148], [158, 74, 128], [124, 64, 114],
  ];
  const arc = [above(far, n(ctx, 'farLift', 5.8, 3, 12)), ...knots.map(([x, y, t]) => worldAt(view, { x: n(ctx, 'arcX', 0, -40, 40) + x, y: y - n(ctx, 'arcLift', 0, -90, 40) }, t)), above(near, n(ctx, 'nearLift', 7.5, 3, 12))];
  // Spill: over the rim and out, falling, on the side facing the eye and away from the other vessel.
  const hN = near.lipHalf, hF = far.lipHalf;
  // The strand's winding is laid out on the spill it was first approved with (`laidOnN`), so nothing else about
  // the helix moves; its last stretch is re-routed (`spillN`) to run down the near vessel's front face, clear of
  // the vessel's left edge: it crosses the lip's front edge and hangs `spillOut` units in front of the face,
  // `spillSlide` millimetres across from the face's middle.
  const laidOnN = [above(near, 4.0, hN * 0.9), above(near, 2.4, hN + 3.4), above(near, -2.5, hN + 6.4), above(near, -9, hN + 8.0), above(near, -14, hN + 8.3)];
  const spillOut = n(ctx, 'spillOut', 4.8, 4, 9), drop = n(ctx, 'spillDrop', 8, 4, 16);
  const faceMiddle = pageOf(view, near.axis.clone().addScaledVector(near.front, hN).setY(near.rim)).x + n(ctx, 'spillSlide', -6, -20, 20);
  const handAt = (s: number, up: number) => near.axis.clone().addScaledVector(near.front, hN + spillOut).addScaledVector(near.right, s).setY(near.rim + up);
  const slide0 = pageOf(view, handAt(0, 0)).x, slide1 = pageOf(view, handAt(1, 0)).x;
  const along = (faceMiddle - slide0) / (slide1 - slide0);
  const spillN = [
    near.axis.clone().addScaledVector(near.front, hN * 0.5).addScaledVector(near.right, along * 0.5).setY(near.rim + 6.0),
    handAt(along, 3.6), handAt(along, -0.8), handAt(along, -4.5), handAt(along, -drop),
  ];
  const spillF = [above(far, -14, hF + 6.8, far.right), above(far, -8, hF + 6.6, far.right), above(far, -2.5, hF + 5.8, far.right), above(far, 2.8, hF + 4.0, far.right), above(far, 4.8, hF * 0.6, far.right)];
  const intoF = [above(far, -3.2), above(far, -0.4), above(far, 2.2)];
  const intoN = [above(near, 2.2), above(near, -0.4), above(near, -3.2)];
  // `sever` cuts the pour short of one rim (for trying the reading's invariant; `none` is the card).
  const sever = ctx.params.sever === 'far' || ctx.params.sever === 'near' ? ctx.params.sever : 'none';
  const arcUsed = arc.slice(sever === 'far' ? 1 : 0, sever === 'near' ? arc.length - 1 : arc.length);
  const headA = sever === 'far' ? [] : intoF, headB = sever === 'far' ? [] : spillF;
  const a = [...headA, ...arcUsed, ...(sever === 'near' ? [] : laidOnN)];
  const b = [...headB, ...arcUsed, ...(sever === 'near' ? [] : intoN)];
  const plans: StrandPlan[] = [
    {
      index: 0, points: a, ref: headA.length, tipStart: sever === 'far', tipEnd: true,
      reroute: sever === 'near' ? undefined : { from: headA.length + arcUsed.length - 1, points: [arcUsed[arcUsed.length - 1], ...spillN] },
    },
    { index: 1, points: b, ref: headB.length, tipStart: true, tipEnd: sever === 'near' },
  ];
  const depthK = n(ctx, 'helixDepth', 0.4, 0, 1);
  const scaleAt = (p: THREE.Vector3) => (clamp(-p.z, 40, 400) / nearDepth) ** depthK;
  return { near, far, plans, scaleAt };
}

export function drawTemperance(ctx: SketchContext): Part[] {
  const view = temperanceCamera(ctx);
  const eye = view.position.clone();
  const f = focalOf(view);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const { near, far, plans, scaleAt } = layout(ctx, view);
  const shoreX = shoreline(ctx, view);

  const helix = twinHelix(ctx, view, plans, {
    radius: n(ctx, 'helixRadius', 1.8, 0.5, 3) * S, width: n(ctx, 'helixRadius', 1.8, 0.5, 3) * S * n(ctx, 'helixWidth', 0.75, 0.3, 1.4),
    pitch: n(ctx, 'helixPitch', 12, 4, 30) * S, spread: n(ctx, 'helixRadius', 1.8, 0.5, 3) * S * 0.3, narrow: n(ctx, 'helixRadius', 1.8, 0.5, 3) * S * 0.12,
    twist: n(ctx, 'helixTwist', 0.3, 0, 1), density: n(ctx, 'helixDensity', 0.6, 0, 1), scaleAt, tip: n(ctx, 'helixTip', 1.4, 0.3, 4) * S, lamination: n(ctx, 'helixLamination', 9, 3, 30), S,
  });
  const helixStrokes: Stroke[] = helix.strokes.map((h: HelixStroke) => ({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points }));

  const light = new THREE.Vector3(n(ctx, 'lightX', -0.6, -1, 1), n(ctx, 'lightY', 0.35, 0.1, 1), n(ctx, 'lightZ', 0.72, 0.2, 1.5)).normalize();
  const vessels: [string, Vessel][] = [['near', near], ['far', far]];
  const strokes: Stroke[] = [];
  for (const [group, v] of vessels) for (const sl of v.slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    for (const st of facetStrokes(sl, light, eye, Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5, FACET_MM_PER_UNIT / mmPerUnit(at))) {
      strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
    }
  }

  const slabsOf = (v: Vessel) => v.slabs.map(slabGeometry);
  const nearGeos = slabsOf(near), farGeos = slabsOf(far);
  const geometries = [...nearGeos, ...farGeos, ...helix.meshes];
  try {
    fitDepthRange(view, geometries);
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);
    const slack = n(ctx, 'slabSlack', 0.6, 0.1, 2), helixSlack = n(ctx, 'helixSlack', 0.4, 0.1, 2);

    const knock = n(ctx, 'knockout', 1.1, 0.3, 3);
    const nearCover = meshCoverage(nearGeos, view, TABLOID_PAGE, knock);
    const farCover = meshCoverage(farGeos, view, TABLOID_PAGE, knock);
    const solids = (p: Point) => nearCover(p) || farCover(p);
    const helixCover = meshCoverage(helix.meshes, view, TABLOID_PAGE, n(ctx, 'helixKnockout', 1.0, 0.3, 3));
    // Where the helix hangs in front of a vessel it only clears a thin margin of the vessel's own lines.
    const helixTight = meshCoverage(helix.meshes, view, TABLOID_PAGE, 0.5);
    const helixClear = meshCoverage(helix.meshes, view, TABLOID_PAGE, n(ctx, 'skyClear', 2.6, 0.5, 6));

    // The phrase: each word cut into a front face of one vessel, going from one to the other and
    // down: it, goes, both, ways. A word is placed on the course nearest its target share of the
    // vessel's height that is wide enough and wholly in view.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size };
    const wrng = ctx.random('temperance-words');
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    const targets: [Vessel, number][] = [[near, 0.8], [far, 0.9], [near, 0.5], [far, 0.65], [near, 0.3], [far, 0.4]];
    const used = new Set<Slab>();
    words.forEach((word, wi) => {
      const [vessel, want] = targets[wi % targets.length];
      const ranked = vessel.slabs.filter(sl => !used.has(sl)).map(sl => ({ sl, score: Math.abs(sl.y / vessel.rim - want) }))
        .sort((a, b) => a.score - b.score);
      for (const { sl } of ranked) {
        const m = slabMatrix(sl);
        const unit = 1 / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        if (ww > sl.w - 0.9 || hh > sl.h - 0.5) continue;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 0.9), y0 = hh / 2;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q2 => new THREE.Vector3(x0 + q2.x * unit, y0 - q2.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3)) continue;
        textStrokes.push(...word3);
        used.add(sl);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], keep: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && keep(p), 0.15)) buckets.add(key, piece, false, min);
    };

    const farEdges: Point[][] = [];
    // The vessels, each with hidden-line slack in world units at its own distance; the paper round the
    // helix is clear of their hatch where it hangs in front of them.
    for (const [group, v] of vessels) {
      const mine = strokes.filter(st => st.group === group);
      const d = eye.distanceTo(v.axis.clone().setY(v.rim / 2));
      projectStrokes(mine, { view, depth, width: W, height: H, bias: biasAt(slack, d) }, {
        begin: st => runs => {
          for (const run of runs) {
            const page = scalePoints(run, MM_X, MM_Y);
            // The far vessel's outlines are kept: the water gives them back upside down.
            if (group === 'far' && st.family === 'edge') farEdges.push(page);
            add(`${st.group}-${st.ink}`, page, p => !helixTight(p), 0.9);
          }
        },
      });
    }
    // The helix, in depth bands so its slack stays the same distance in the world near and far.
    const bands = new Map<number, Stroke[]>();
    for (const st of helixStrokes) {
      const band = Math.floor(eye.distanceTo(st.points[Math.floor(st.points.length / 2)]) / 40);
      bands.set(band, [...(bands.get(band) ?? []), st]);
    }
    for (const [band, mine] of bands) {
      projectStrokes(mine, { view, depth, width: W, height: H, bias: biasAt(helixSlack, band * 40 + 20) }, {
        begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
      });
    }

    // The ground. Ground depth under a page y, and the ground's x there, to say which side of the shore a point is on.
    const depthAt = (y: number) => f * eye.y / (y - HORIZON_Y);
    const shoreAt = (y: number) => { const t = depthAt(y); return PW / 2 + f * shoreX(t) / t; };
    const isWater = (p: Point) => p.x > shoreAt(p.y);
    // Water: dark ruled lines from the horizon down, close at the horizon and opening toward us,
    // broken near the horizon where it shimmers; knocked out round whatever stands in it.
    // The far vessel stands in the water, and the water gives it back: its outlines upside down below the
    // waterline, courses and all, bent a little by the ripple and broken where the ripples cross it, fading
    // with depth; the water ruling inside it thins to its blue lines. A quiet note.
    const waterline = pageOf(view, far.axis).y;
    const farBody = meshCoverage(farGeos, view, TABLOID_PAGE, 0);
    const rippleRng = ctx.random('temperance-ripples');
    const rp1 = rippleRng() * 6.28, rp2 = rippleRng() * 6.28;
    const rippleCut = n(ctx, 'rippleCut', 0.9, 0.2, 1.2);
    const farTop = Math.min(...farEdges.flat().map(p => p.y));
    const mirrorReach = Math.max(1, waterline - farTop);
    const ripple = (y: number) => 0.6 * Math.sin(y * 1.55 + rp1) + 0.4 * Math.sin(y * 3.9 + rp2);
    const mirrored = (y: number) => y > waterline + 0.4 && ripple(y) < rippleCut - 1.7 * Math.min(1, (y - waterline) / mirrorReach) ** 1.1;
    const bend = (y: number) => 0.8 * Math.sin(y * 1.1);
    const reflected = (p: Point) => mirrored(p.y) && farBody({ x: p.x - bend(p.y), y: 2 * waterline - p.y });
    const pattern = barPattern(ctx.random('temperance-water'), 0.9);
    const pitch = n(ctx, 'waterPitch', 0.62, 0.5, 1.4);
    const bottom = CARD.y1;
    for (let y = HORIZON_Y + 0.7, i = 0; y < bottom; i++) {
      const t = (y - HORIZON_Y) / (bottom - HORIZON_Y);
      const ink = i % 4 === 0 ? 'ultramarine' : 'carbon';
      add(`water-${ink}`, [{ x: shoreAt(y) + 0.5, y }, { x: CARD.x1, y }],
        p => !solids(p) && !helixCover(p) && (t > 0.3 || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]) && (i % 4 === 0 || !reflected(p)));
      y += pitch * (1 + 0.55 * t ** 1.3);
    }
    for (const run of farEdges) {
      const flipped = run.map(p => ({ x: p.x + bend(2 * waterline - p.y), y: 2 * waterline - p.y }));
      add('reflect-carbon', flipped, p => mirrored(p.y) && isWater(p) && !solids(p));
    }
    // The land is paved: slabs laid in courses across the ground, each course its own width of slab and
    // its joints staggered against the course before, every joint running up to the shore and cut by it. The
    // courses end where they would crowd under a millimetre apart, so the land opens toward the horizon.
    const slabRng = ctx.random('temperance-slabs');
    const course = n(ctx, 'courseDepth', 4, 2.5, 8);
    const tFoot = depthAt(CARD.y1 - 0.5), tEnd = Math.sqrt(f * eye.y * course / n(ctx, 'pavingEnd', 1.1, 0.6, 3));
    const rows: number[] = [];
    for (let t = tFoot * 1.04; t < tEnd; t += course) rows.push(t);
    const yOf = (t: number) => HORIZON_Y + f * eye.y / t;
    const onLand = (p: Point) => !isWater(p) && !solids(p);
    rows.forEach((t, k) => {
      const y = yOf(t);
      add('land-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], onLand);
      if (k + 1 >= rows.length) return;
      const t2 = rows[k + 1], y2 = yOf(t2);
      const sp = 5 + 3.5 * slabRng(), off = slabRng() * sp;
      for (let X = -40 * sp + off; X < 40 * sp; X += sp) {
        add('land-carbon', [{ x: PW / 2 + f * X / t, y }, { x: PW / 2 + f * X / t2, y: y2 }], onLand);
      }
    });
    // The shore: a line and its beach, down the diagonal.
    const shore: Point[] = [];
    for (let y = HORIZON_Y + 1; y <= bottom; y += 1.5) shore.push({ x: shoreAt(y), y });
    add('shore-carbon', shore);
    add('shore-carbon', shore.map(p => ({ x: p.x - 1.4 - 1.2 * (p.y - HORIZON_Y) / (bottom - HORIZON_Y), y: p.y })), p => !solids(p));

    // The sky: the deck's light ruling, full lines at the top that thin and break as they come down to
    // the horizon, knocked out round the vessels and well clear of the helix.
    const reachSky = n(ctx, 'sky', 0.5, 0, 1);
    if (reachSky > 0) {
      const skyPattern = barPattern(ctx.random('temperance-sky'), 0.86);
      const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
      for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += n(ctx, 'skyPitch', 1.3, 0.8, 2.5)) {
        const t = (y - skyTop) / (skyBottom - skyTop);
        const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
        const deep = i % 16 === 0;
        const limit = [deep ? 1 / reachSky : 0.95, 0.72, 0.5, 0.28][tier];
        if (t > limit * reachSky) continue;
        const broken = t > 0.3 * Math.min(limit, 0.95) * reachSky;
        add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => {
          const step = Math.floor((p.x - CARD.x0) / 3.2 + i);
          return !solids(p) && !helixClear(p) && (!broken || skyPattern[step % 64]);
        });
      }
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'water', 'reflect', 'land', 'shore', 'near', 'far', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !helixCover(p), 0.3) });
    parts.push(...cardFrame('XIV', 'TEMPERANCE'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
