import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { hatchedBar } from '../../kit/fills.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { bodyMeshes } from '../../kit/mannequin/body.ts';
import { TIER, perpendicular, runs, stride, tierOf, toneField, type Look, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { HEMS, pinstripeTube, suitFront } from '../../kit/mannequin/suit.ts';
import { silhouettes, type ClothStroke, type Tube } from '../../kit/mannequin/tube.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { colossus, frameAt, fromFrame, headCoil, headOf, plinthFronts, seatedSkeleton, toFrame, type Colossus, type Frame } from './figure.ts';

/**
 * IV The Emperor: you are already standing on it. Power is order, and it is colossal by distance: a
 * seated figure in a pinstripe suit on a block throne, so far down an avenue of identical cubes that
 * the foot of its stepped plinth lies just below the horizon, and still it rises through the whole
 * upper card, its head high in the top quarter. The avenue fills the lower card: rows of cubes either
 * side of a paved lane, perfectly aligned, running from under the viewer's feet to the plinth.
 *
 * The figure is rigid, upright and massive, turned three-quarter right of centre; only its head turns,
 * up and to the viewer's left. Its body is planes over a flowing figure, six to a limb. Its head is the
 * helix, wound into a coil where a skull would be, and the head is the light: line density falls off
 * with distance from it, so the suit blows out to paper round the head while the trousers, the throne's
 * base and the avenue stay heavy, and the ruled sky opens round it. Over the eyes, the one flat mark: a
 * hatched censor bar on the sheet itself. The phrase is cut word by word into the throne and the cubes.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const GROUPS = ['sky', 'ground', 'avenue', 'throne', 'figure', 'helix', 'bar', 'slogan'] as const;
const EYE = 6;
const MID_X = (CARD.x0 + CARD.x1) / 2;
/** The suit in the main pen: value by line density alone. The helix keeps its own inks. */
const SUIT: Look = { cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure' };

export function emperorCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 2, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * Where the colossus sits and how big it is: the throne's frame origin (under the pelvis) lies
 * `throneX` right of centre, so far away that the plinth's bottom front edge lands `baseDrop` below
 * the horizon, and the figure is scaled so the top of its head reaches `headTop`.
 */
export function placeColossus(ctx: SketchContext, view: THREE.Camera, yaw: number): { anchor: THREE.Vector3; height: number } {
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad((view as THREE.PerspectiveCamera).fov / 2));
  const drop = n(ctx, 'baseDrop', 10, 3, 40), headTop = n(ctx, 'headTop', 80, 50, 140), offX = n(ctx, 'throneX', 46, 0, 100);
  const at = (Z: number) => new THREE.Vector3(offX * Z / f, 0, -Z);
  const sized = (Z: number) => {
    const anchor = at(Z);
    const top = (h: number) => Math.min(...headCoil(headOf(seatedSkeleton(h, anchor, yaw), h / 24)).map(p => pageOf(view, p).y));
    let lo = 1, hi = 20000;
    for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (top(mid) > headTop) lo = mid; else hi = mid; }
    return Math.sqrt(lo * hi);
  };
  const foot = (Z: number) => {
    const h = sized(Z), anchor = at(Z), fr = frameAt(anchor, yaw);
    const p = fromFrame(fr, 0, 0, plinthFronts(seatedSkeleton(h, anchor, yaw), fr, h / 24).bottom);
    return p.z > -2 ? Infinity : pageOf(view, p).y;
  };
  let lo = 20, hi = 50000;
  for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (foot(mid) > HORIZON_Y + drop) lo = mid; else hi = mid; }
  const Z = Math.sqrt(lo * hi);
  return { anchor: at(Z), height: sized(Z) };
}

/**
 * The avenue: identical cubes in rows either side of a lane, perfectly aligned along its axis `av`
 * (origin at the plinth's foot, z toward the viewer), from the plinth to under the viewer's feet.
 * A cube that would stand on the plinth is left out.
 */
function avenue(ctx: SketchContext, view: THREE.Camera, av: Frame, length: number, lane: number, c: number, pitch: number, onPlinth: (p: THREE.Vector3) => boolean): Slab[] {
  const cols = Math.round(n(ctx, 'cols', 3, 1, 8));
  const out: Slab[] = [];
  for (let z = c / 2 + 0.25 * c; z < length; z += pitch) {
    for (let i = 0; i < cols; i++) for (const side of [-1, 1]) {
      const x = side * (lane + c / 2 + i * pitch);
      const centre = fromFrame(av, x, 0, z);
      if (-centre.z < 9) continue;
      const foot = [-1, 1].flatMap(a => [-1, 1].map(q => fromFrame(av, x + a * c / 2, 0, z + q * c / 2)));
      if (foot.some(onPlinth)) continue;
      // Kept only if some of it is on the card.
      const ps = foot.map(p => pageOf(view, p.setY(c)));
      if (Math.max(...ps.map(p => p.x)) < CARD.x0 || Math.min(...ps.map(p => p.x)) > CARD.x1 || Math.min(...ps.map(p => p.y)) > CARD.y1) continue;
      const sl = solid(centre.x, c / 2, centre.z, c, c, c, out.length, 'stack');
      sl.ry = Math.atan2(av.z.x, av.z.z);
      out.push(sl);
    }
  }
  return out;
}

/**
 * The bare end of a limb past `from` along it (a hand, a shoe): rings round it `spacing` apart, as
 * many as its tone asks for, thinned on the sheet like the cloth, and its plane edges.
 */
function bareEnd(t: Tube, from: number, env: ToneEnv, spacing: number): ClothStroke[] {
  const out: ClothStroke[] = [];
  const R = Math.max(4, Math.round((1 - from) * t.length / spacing)) * 4;
  const around = Math.max(96, Math.round(t.circ / 0.06));
  for (let i = 0; i < R; i++) {
    const u = from + (1 - from) * (i + 0.5) / R;
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let q = 0; q <= around; q++) {
      const v = q / around, p = t.point(u, v);
      pts.push(p);
      const st = stride(perpendicular(env, p, t.point(u, v + 1 / around), t.point(u + (1 - from) / R, v)));
      keep.push(i % st === 0 && env.dark(p, t.normal(u, v)) > TIER[tierOf(i)]);
    }
    runs(pts, keep, 'carbon', 'figure', out);
  }
  for (let q = 0; q < t.facets; q++) out.push({ ink: 'carbon', group: 'figure', points: Array.from({ length: 31 }, (_, i) => t.point(from + (1 - from) * i / 30, q / t.facets, 0.004)) });
  return out;
}

/** An egg inside the head's coil, never drawn: it hides the coil's far side so the knot reads as one form. */
function skull(h: Colossus['head']): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 18);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(h.side, h.axis, h.face).multiply(new THREE.Matrix4().makeScale(0.52 * h.r, 0.66 * h.r, 0.52 * h.r)));
  g.translate(h.centre.x, h.centre.y, h.centre.z);
  return g;
}

/** The point inside a convex page quad (clockwise on the sheet), grown by `margin`. */
const inQuad = (quad: Point[], margin: number) => (p: Point) => quad.every((a, i) => {
  const b2 = quad[(i + 1) % quad.length];
  const ex = b2.x - a.x, ey = b2.y - a.y;
  return (ex * (p.y - a.y) - ey * (p.x - a.x)) / Math.hypot(ex, ey) > -margin;
});

/** Number of times 2 divides k (a big number for 0): how far a paving joint carries into the distance. */
const twos = (k: number) => { if (k === 0) return 12; let t = 0; while (k % 2 === 0) { k /= 2; t++; } return t; };

export function drawEmperor(ctx: SketchContext): Part[] {
  const view = emperorCamera(ctx);
  const eye = view.position.clone();
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);

  // The colossus, far off and turned toward the viewer's left.
  const yaw = -THREE.MathUtils.degToRad(n(ctx, 'turn', 36, 0, 60));
  const { anchor, height } = placeColossus(ctx, view, yaw);
  const fig = colossus(height, anchor, yaw);
  const { k, head, body, frame, base } = fig;

  // The avenue's axis runs from the foot of the plinth to the viewer's feet.
  const foot = fromFrame(frame, 0, 0, base.z1);
  const length = Math.hypot(foot.x, foot.z);
  const av = frameAt(foot, Math.atan2(-foot.x, -foot.z));
  const c = n(ctx, 'cube', 2.5, 1, 6), b = c / 2;
  const pitch = c + b * Math.round(n(ctx, 'gap', 2, 1, 4));
  const lane = Math.ceil(n(ctx, 'lane', 4, 1, 20) / b) * b;
  const margin = 0.3 * c;
  const onPlinth = (p: THREE.Vector3) => {
    const q = toFrame(frame, p);
    return q.x > base.x0 - margin && q.x < base.x1 + margin && q.z > base.z0 - margin && q.z < base.z1 + margin;
  };
  const cubes = avenue(ctx, view, av, length, lane, c, pitch, onPlinth);
  const slabs = [...fig.throne, ...cubes];
  const groupOf = (i: number) => (i < fig.throne.length ? 'throne' : 'avenue');

  // The head: the helix wound into an egg-shaped coil, in its own inks.
  const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
    { radius: 0.12 * k, width: 0.5 * k, pitch: 9 * k, spread: 0.1 * k, narrow: 0.08 * k, density: 0.45, interruption: 0.1 });

  // The light is the head: an aura whose value falls off with distance from it (the kit's field,
  // read at canon scale so its reach and breakup suit a figure this size).
  const aura = toneField(ctx, head.centre.clone().divideScalar(k), { noiseKey: 'emperor-aura' });
  const dark = (p: THREE.Vector3, nrm: THREE.Vector3) => aura(p.clone().divideScalar(k), nrm);
  const env = { forward, density: n(ctx, 'density', 0.45, 0, 1), dark, screen: (p: THREE.Vector3) => pageOf(view, p) };

  const strokes: Stroke[] = [];
  const push = (list: ClothStroke[], group: string) => { for (const st of list) strokes.push({ ink: st.ink, group, family: st.family ?? 'hatch', points: st.points }); };
  // The suit: pinstripes along each piece, the jacket's lapels and tie, cuffs at the wrists and hems
  // at the ankles. Past them the hands and shoes are bare planes, hatched round in rings, the shoes
  // a shade darker.
  push(pinstripeTube(body.trunk, env, HEMS.trunk, SUIT), 'figure');
  push(suitFront(body.trunk, env, SUIT), 'figure');
  for (const t of body.limbs) {
    const stop = fig.stops.get(t.id)!;
    const leg = t.id.startsWith('leg');
    if (leg) push(pinstripeTube(t, env, { seams: [0, 0.5], hems: [stop - 0.004], creases: [0.25], stop }, SUIT), 'figure');
    else push(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, SUIT), 'figure');
    push(bareEnd(t, stop, leg ? { ...env, dark: (p, nrm) => Math.min(1, dark(p, nrm) + 0.25) } : env, 0.22 * k), 'figure');
  }
  for (const t of [body.trunk, ...body.limbs]) push(silhouettes(t, env, { ink: 'carbon', group: 'figure' }), 'figure');
  for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  // Slabs (throne, cubes): the raking hatch lit from the head, quieter the nearer they stand to it;
  // small far cubes are only outlined.
  const facet = n(ctx, 'facet', 12, 6, 18);
  const outlineBelow = n(ctx, 'outlineBelow', 5, 0, 20);
  for (const [i, sl] of slabs.entries()) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const toHead = head.centre.clone().sub(at).normalize();
    sl.tone = (2.4 * dark(at, toHead) - 1.1) * (i < fig.throne.length ? 1 : n(ctx, 'avenueTone', 0.35, 0, 1));
    const mpu = mmPerUnit(at);
    const small = Math.max(sl.w, sl.h) * mpu < (i < fig.throne.length ? 1.5 : outlineBelow);
    const spacing = i < fig.throne.length ? facet : n(ctx, 'avenueFacet', 22, 6, 40);
    for (const st of facetStrokes(sl, toHead, eye, small, spacing / mpu)) {
      strokes.push({ ink: 'carbon', group: groupOf(i), family: st.family, points: st.points, owner: i });
    }
  }

  const geometries = [...slabs.map(slabGeometry), ...bodyMeshes(body, 0.8), ...helix.meshes, skull(head)];
  // Small blocks hide their own back edges only if the depth range fits the scene.
  fitDepthRange(view, geometries);
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));
    const glowAt = pageOf(view, head.centre);

    // The censor bar: flat on the sheet across the eyes, at an odd seeded angle, knocking out what it covers.
    const brng = ctx.random('emperor-censor');
    const eyes = pageOf(view, head.centre.clone().addScaledVector(head.face, 0.9 * head.r).addScaledVector(head.axis, 0.12 * head.r));
    const headMm = 2 * head.r * mmPerUnit(head.centre);
    const tilt = (brng() < 0.5 ? -1 : 1) * (0.06 + 0.2 * n(ctx, 'censorAngle', 0.5, 0, 1) * (0.5 + brng()));
    const bar = hatchedBar({ cx: eyes.x, cy: eyes.y, l: 1.75 * headMm, h: 0.36 * headMm }, tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]]);
    const onBar = inQuad(bar.quad, 1.4);

    // The phrase: a word at a time cut into a face of the throne or of a cube that turns toward you,
    // staggered down the card on alternating sides, each wholly in view inside a padded frame.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('emperor-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], share = 0.98) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (q: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs2 => { for (const r of runs2) addTo(r.length); },
      });
      count(false, q => { total += q; });
      count(true, q => { seen += q; });
      return total > 0 && seen >= total * share;
    };
    // Each candidate face: a slab's matrix turned so the face is its local +z, with the face's size.
    const faces = [...fig.throne, ...cubes].flatMap(sl => [0, 1, 2, 3].map(q => {
      const m = slabMatrix(sl).multiply(new THREE.Matrix4().makeRotationY(q * Math.PI / 2));
      const fw = q % 2 ? sl.d : sl.w, half = q % 2 ? sl.w / 2 : sl.d / 2;
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(m);
      const centre = new THREE.Vector3(0, 0, half).applyMatrix4(m);
      return { m, fw, fh: sl.h, half, facing: normal.dot(eye.clone().sub(centre).normalize()), centre };
    })).filter(fc => fc.facing > 0.3).map(fc => {
      const ps = [-1, 1].flatMap(x => [-1, 1].map(y => pageOf(view, new THREE.Vector3(x * fc.fw / 2, y * fc.fh / 2, fc.half).applyMatrix4(fc.m))));
      return { ...fc, box: { x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) } };
    }).filter(fc => fc.box.x1 > CARD.x0 + 12 && fc.box.x0 < CARD.x1 - 12 && fc.box.y1 > CARD.y0 + 5 && fc.box.y0 < CARD.y1 - 5);
    const placed: Point[] = [];
    const tryWord = (word: string, target: number, side: number, reach: number, room = 1.2): boolean => {
      const pick = faces.filter(({ box }) => side === 0 || (side < 0 ? box.x0 < MID_X - 8 : box.x1 > MID_X + 8))
        .map(fc => ({ fc, score: Math.max(0, fc.box.y0 - target, target - fc.box.y1) + 25 * wrng() }))
        .sort((p, q) => p.score - q.score).slice(0, reach > 100 ? 80 : 18).map(({ fc }) => fc);
      for (const fc of pick) {
        // Sized on the sheet: wider in the face's own plane as it turns away from the eye.
        const unit = 1 / mmPerUnit(fc.centre);
        const ww = measureStrokeText(word, style) * unit / Math.max(0.35, fc.facing), hh = style.height * unit;
        const margin2 = room * hh;
        if (ww > fc.fw - 2 * margin2 || hh > fc.fh - 2 * margin2) continue;
        const sx = ww / measureStrokeText(word, style);
        for (let attempt = 0; attempt < 60; attempt++) {
          const x0 = -ww / 2 + (wrng() - 0.5) * (fc.fw - ww - 2 * margin2), y0 = hh / 2 + (wrng() - 0.5) * (fc.fh - hh - 2 * margin2);
          const centre = pageOf(view, new THREE.Vector3(x0 + ww / 2, y0 - hh / 2, fc.half).applyMatrix4(fc.m));
          const half = measureStrokeText(word, style) / 2;
          if (centre.x - half < CARD.x0 + 5 || centre.x + half > CARD.x1 - 5 || centre.y < CARD.y0 + 5 || centre.y > CARD.y1 - 5) continue;
          if (Math.abs(centre.x - MID_X) < 12 || (side !== 0 && (centre.x - MID_X) * side < 0) || Math.abs(centre.y - target) > reach) continue;
          if (placed.some(p => Math.hypot(p.x - centre.x, p.y - centre.y) < 32) || onBar(centre)) continue;
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * sx, y0 - q.y * unit, fc.half + 0.02).applyMatrix4(fc.m)));
          // A frame round the word must be in view too, so no word sits tight against an edge in front of it.
          const pad = 0.5 * hh;
          const frameLine = [[x0 - pad, y0 + pad], [x0 + ww + pad, y0 + pad], [x0 + ww + pad, y0 - hh - pad], [x0 - pad, y0 - hh - pad], [x0 - pad, y0 + pad]]
            .map(([x, y]) => new THREE.Vector3(x, y, fc.half + 0.02).applyMatrix4(fc.m));
          if (!visible(word3) || !visible([frameLine], 0.995)) continue;
          textStrokes.push(...word3);
          placed.push(centre);
          return true;
        }
      }
      return false;
    };
    const yTop = HORIZON_Y - 70, yBottom = CARD.y1 - 14;
    let side = wrng() < 0.5 ? -1 : 1;
    words.forEach((word, i) => {
      const target = yTop + (yBottom - yTop) * (words.length > 1 ? i / (words.length - 1) : 0.5);
      // Its own side near its own height first, then its own side anywhere, then either side, and last
      // with less paper round it.
      if (!tryWord(word, target, side, 40) && !tryWord(word, target, side, 110) && !tryWord(word, target, 0, 170)) tryWord(word, target, 0, 250, 0.6);
      side = -side;
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const cl of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(cl), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], keep: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onBar(p) && keep(p), 0.15)) buckets.add(key, piece);
    };

    // Hidden lines: each slab with up to half a unit of slack at its own distance; the figure and the
    // helix with slack in proportion to the figure.
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);
    const bySlab = new Map<number, Stroke[]>();
    const rest: Stroke[] = [];
    for (const st of strokes) {
      if (st.owner === undefined) { rest.push(st); continue; }
      const list = bySlab.get(st.owner) ?? [];
      list.push(st);
      bySlab.set(st.owner, list);
    }
    const receive = (st: Stroke) => (runs2: { x: number; y: number }[][]) => { for (const run of runs2) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); };
    for (const [i, mine] of bySlab) {
      const sl = slabs[i];
      const tol = Math.max(0.12, Math.min(0.5 * Math.max(1, k / 4), 0.25 * Math.min(sl.w, sl.h, sl.d)));
      projectStrokes(mine, { view, depth, width: W, height: H, bias: biasAt(tol, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, { begin: receive });
    }
    const figureAt = head.centre.clone().lerp(anchor, 0.5);
    projectStrokes(rest, { view, depth, width: W, height: H, bias: biasAt(n(ctx, 'figureSlack', 0.45, 0.05, 2) * k, eye.distanceTo(figureAt)) }, { begin: receive });

    // The paving: joints half a cube apart in the avenue's grid, from the plinth's foot to under the
    // viewer's feet. As they crowd into the distance they drop out in halves (every second, fourth,
    // eighth joint carries on), so the grid keeps an even weight; knocked out round all that stands.
    const gapMm = n(ctx, 'groundGap', 3.2, 1.5, 8);
    const cols = Math.round(n(ctx, 'cols', 3, 1, 8));
    const across = lane + (cols - 1) * pitch + c + b;
    const open = (p: Point) => !solids(p);
    const groundLine = (x0: number, z0: number, x1: number, z1: number, maxDepth: number) => {
      let pts: Point[] = [];
      const flush = () => { if (pts.length > 1) add('ground-carbon', pts, open); pts = []; };
      for (let i = 0; i <= 120; i++) {
        const p = fromFrame(av, x0 + (x1 - x0) * i / 120, 0, z0 + (z1 - z0) * i / 120);
        if (-p.z < 3 || -p.z > maxDepth) { flush(); continue; }
        pts.push(pageOf(view, p));
      }
      flush();
    };
    const steps = Math.round(across / b);
    for (let j = -steps; j <= steps; j++) groundLine(j * b, 0, j * b, length, b * 2 ** twos(Math.abs(j)) * f / gapMm);
    for (let j = 0; j * b <= length; j++) {
      const p = fromFrame(av, 0, 0, j * b);
      const d = -p.z;
      if (d < 3 || EYE * f * b * 2 ** twos(j) / (d * d) < gapMm) continue;
      groundLine(-across, j * b, across, j * b, Infinity);
    }

    // The sky: a ruled night, densest at the top and opening toward the horizon, knocked out round all
    // that stands, and opening round the head: power is the light.
    const pattern = barPattern(ctx.random('emperor-sky'), 0.86);
    const glowR = n(ctx, 'skyGlow', 95, 0, 160);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    const skyPitch = n(ctx, 'skyPitch', 0.9, 0.5, 1.5);
    for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += skyPitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      if (!(t < 0.3 || tier === 0 || (tier === 1 && t < 0.7))) continue;
      const broken = t > 0.5;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => {
        if (solids(p)) return false;
        const r = Math.hypot(p.x - glowAt.x, p.y - glowAt.y) / Math.max(1, glowR);
        const step = pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64];
        if (r < 0.5) return false;
        if (r < 1) return step && (r - 0.5) / 0.5 > ((i * 7 + Math.floor(p.x / 3.2) * 13) % 17) / 17;
        return !broken || step;
      });
    }
    for (const path of bar.paths) buckets.add('bar-carbon', path, true);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(GROUPS, INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !onBar(p), 0.3) });
    parts.push(...cardFrame('IV', 'THE EMPEROR'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
