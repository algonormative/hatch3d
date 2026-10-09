import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, MIN_SPACING, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, halo, hatchMin, layoutLength, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { faceDarkness, facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { thinParallel } from '../../kit/density.ts';
import { hatchedBar } from '../../kit/fills.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { toneField, type Look, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { contourTube } from '../../kit/mannequin/body.ts';
import { HEMS, pinstripeTube, suitFront } from '../../kit/mannequin/suit.ts';
import { silhouettes, type ClothStroke, type Tube } from '../../kit/mannequin/tube.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { colossus, cutTube, frameAt, fromFrame, headCoil, headOf, plinthFronts, seatedSkeleton, toFrame, type Colossus, type Frame } from './figure.ts';

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
 *
 * On a small card the world is the print's (`emperorWorld`, laid out in tabloid's frame) and the card's own camera
 * draws it: rulings, pitches and the paving's joints stay in real millimetres, so more of the far avenue is outlines;
 * halos, the sky's opening and the bar scale with the card; the throne is trimmed to its outline, the suit thinned
 * where its lines crowd (`thin.ts`), and the phrase leaves the art for the band.
 */
/** The card's depth raster at tabloid; on any other page, the format's. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const GROUPS = ['sky', 'ground', 'avenue', 'throne', 'figure', 'helix', 'bar', 'slogan'] as const;
const EYE = 6;
const MID_X = (CARD.x0 + CARD.x1) / 2;
/** The suit in the main pen: value by line density alone. The helix keeps its own inks. */
const SUIT: Look = { cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure' };
/** The ink that tags the suit's cloth on a small card, drawn in carbon all the same. */
const CLOTH_TAG: Ink = 'ultramarine';

/** The card's camera, on the format's page. */
export function emperorCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 2, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the Emperor's world is laid out with. At tabloid it is `emperorCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye: EYE, near: 2, far: 4000 });
}

/**
 * Where the colossus sits and how big it is: the throne's frame origin (under the pelvis) lies
 * `throneX` right of centre, so far away that the plinth's bottom front edge lands `baseDrop` below
 * the horizon, and the figure is scaled so the top of its head reaches `headTop`. Laid out in
 * tabloid's frame: `view` is `worldCamera`, and the three controls are tabloid millimetres.
 */
export function placeColossus(ctx: SketchContext, view: THREE.Camera, yaw: number): { anchor: THREE.Vector3; height: number } {
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad((view as THREE.PerspectiveCamera).fov / 2));
  const drop = n(ctx, 'baseDrop', 10, 3, 40), headTop = n(ctx, 'headTop', 80, 50, 140), offX = n(ctx, 'throneX', 46, 0, 100);
  const at = (Z: number) => new THREE.Vector3(offX * Z / f, 0, -Z);
  const sized = (Z: number) => {
    const anchor = at(Z);
    const top = (h: number) => Math.min(...headCoil(headOf(seatedSkeleton(h, anchor, yaw), h / 24)).map(p => pageOf(view, p, TABLOID_PAGE).y));
    let lo = 1, hi = 20000;
    for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (top(mid) > headTop) lo = mid; else hi = mid; }
    return Math.sqrt(lo * hi);
  };
  const foot = (Z: number) => {
    const h = sized(Z), anchor = at(Z), fr = frameAt(anchor, yaw);
    const p = fromFrame(fr, 0, 0, plinthFronts(seatedSkeleton(h, anchor, yaw), fr, h / 24).bottom);
    return p.z > -2 ? Infinity : pageOf(view, p, TABLOID_PAGE).y;
  };
  let lo = 20, hi = 50000;
  for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (foot(mid) > TABLOID_HORIZON_Y + drop) lo = mid; else hi = mid; }
  const Z = Math.sqrt(lo * hi);
  return { anchor: at(Z), height: sized(Z) };
}

/**
 * The avenue: identical cubes in rows either side of a lane, perfectly aligned along its axis `av`
 * (origin at the plinth's foot, z toward the viewer), from the plinth to under the viewer's feet.
 * A cube that would stand on the plinth is left out. Culled in tabloid's frame: `view` is `worldCamera`.
 */
function avenue(ctx: SketchContext, view: THREE.Camera, av: Frame, length: number, lane: number, c: number, pitch: number, onPlinth: (p: THREE.Vector3) => boolean): Slab[] {
  const cols = Math.round(n(ctx, 'cols', 3, 1, 8));
  const out: Slab[] = [];
  const page = (p: THREE.Vector3) => pageOf(view, p, TABLOID_PAGE);
  for (let z = c / 2 + 0.25 * c; z < length; z += pitch) {
    for (let i = 0; i < cols; i++) for (const side of [-1, 1]) {
      const x = side * (lane + c / 2 + i * pitch);
      const centre = fromFrame(av, x, 0, z);
      if (-centre.z < 9) continue;
      const foot = [-1, 1].flatMap(a => [-1, 1].map(q => fromFrame(av, x + a * c / 2, 0, z + q * c / 2)));
      if (foot.some(onPlinth)) continue;
      // Kept only if some of it is on the card, and none of it runs off the card's foot: the rows may
      // leave by the sides, but no block is cut by the bottom rule.
      if (Math.max(...foot.map(p => page(p).y)) > TABLOID_CARD.y1 - 1) continue;
      const ps = foot.map(p => page(p.setY(c)));
      if (Math.max(...ps.map(p => p.x)) < TABLOID_CARD.x0 || Math.min(...ps.map(p => p.x)) > TABLOID_CARD.x1 || Math.min(...ps.map(p => p.y)) > TABLOID_CARD.y1) continue;
      const sl = solid(centre.x, c / 2, centre.z, c, c, c, out.length, 'stack');
      sl.ry = Math.atan2(av.z.x, av.z.z);
      out.push(sl);
    }
  }
  return out;
}

/** The Emperor's world: the colossus and its throne, the avenue's axis and cubes, and the censor bar's seeded turn. */
export interface EmperorWorld {
  camera: THREE.PerspectiveCamera;
  yaw: number;
  anchor: THREE.Vector3;
  height: number;
  fig: Colossus;
  /** The avenue's axis (origin at the plinth's foot), its length, the lane's half-width, the cube, half a cube, and the cube pitch. */
  av: Frame;
  length: number;
  lane: number;
  c: number;
  b: number;
  pitch: number;
  cubes: Slab[];
  /** The censor bar's turn off true, in radians. */
  tilt: number;
}

/**
 * The Emperor's world, laid out in tabloid's frame with `worldCamera`, so every size and fit builds the same one, to the
 * bit; each card's own camera then draws it.
 */
export function emperorWorld(ctx: SketchContext): EmperorWorld {
  const camera = worldCamera(ctx);
  // The colossus, far off and turned toward the viewer's left.
  const yaw = -THREE.MathUtils.degToRad(n(ctx, 'turn', 36, 0, 60));
  const { anchor, height } = placeColossus(ctx, camera, yaw);
  const fig = colossus(height, anchor, yaw);
  const { frame, base } = fig;
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
  const cubes = avenue(ctx, camera, av, length, lane, c, pitch, onPlinth);
  // The censor bar's turn: an odd seeded angle off true.
  const brng = ctx.random('emperor-censor');
  const tilt = (brng() < 0.5 ? -1 : 1) * (0.06 + 0.2 * n(ctx, 'censorAngle', 0.5, 0, 1) * (0.5 + brng()));
  return { camera, yaw, anchor, height, fig, av, length, lane, c, b, pitch, cubes, tilt };
}

/** A sleeve or trouser cut at the cuff or hem, for the depth pass: its surface and a disc closing the end. */
function cutMeshes(t: Tube): THREE.BufferGeometry[] {
  const segs = t.facets >= 3 ? t.facets * 4 : 32;
  return [t.mesh(96, segs), buildSurfaceMesh((u, v) => t.centre(1).lerp(t.point(1, v), u), {}, 2, segs)];
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
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);

  // The world, the same at every size and fit; this card's camera draws it.
  const world = emperorWorld(ctx);
  const { anchor, fig, av, length, lane, c, b, pitch, cubes } = world;
  const { k, head, body } = fig;
  // Page millimetres per world unit on the print, for measures that decide what the print would draw.
  const fPrint = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2));
  const printMmPerUnit = (p: THREE.Vector3) => fPrint / Math.max(1, eye.z - p.z);
  const slabs = [...fig.throne, ...cubes];
  const nFigure = fig.throne.length;
  const groupOf = (i: number) => (i < nFigure ? 'throne' : 'avenue');

  // The head: the helix wound into an egg-shaped coil, in its own inks.
  const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
    { radius: 0.12 * k, width: 0.5 * k, pitch: 9 * k, spread: 0.1 * k, narrow: 0.08 * k, density: 0.45, interruption: 0.1 });

  // The light is the head: an aura whose value falls off with distance from it (the kit's field,
  // read at canon scale so its reach and breakup suit a figure this size).
  const aura = toneField(ctx, head.centre.clone().divideScalar(k), { noiseKey: 'emperor-aura' });
  const dark = (p: THREE.Vector3, nrm: THREE.Vector3) => aura(p.clone().divideScalar(k), nrm);
  const env = { forward, density: n(ctx, 'density', 0.45, 0, 1), dark, screen: (p: THREE.Vector3) => pageOf(view, p) };

  const strokes: Stroke[] = [];
  // On a small card the suit's cloth (its stripes and rings) is told from its edges (the planes, seams, hems,
  // cuffs, lapels and the outline) by a tag ink, all drawn in carbon, so the page pass can thin whatever crowds
  // an edge (see `figureRank`). At tabloid the suit is drawn as it always was.
  const look: Look = FORMAT.tabloid ? SUIT : { ...SUIT, cloth: CLOTH_TAG, accent: CLOTH_TAG };
  const figureRank = new Map<Stroke, number>();
  const push = (list: ClothStroke[], group: string, outline = false) => {
    for (const st of list) {
      if (look === SUIT) { strokes.push({ ink: st.ink, group, family: st.family ?? 'hatch', points: st.points }); continue; }
      const cloth = st.ink === CLOTH_TAG;
      const stroke: Stroke = { ink: 'carbon', group, family: cloth ? 'hatch' : 'edge', points: st.points };
      figureRank.set(stroke, outline ? 0 : cloth ? 2 : 1);
      strokes.push(stroke);
    }
  };
  // The suit: pinstripes along each piece, the jacket's lapels and tie, cuffs at the wrists and hems
  // above the shoes. The sleeves and trousers end there; the hands and shoes are planes, drawn with
  // the slabs below.
  const limbs = body.limbs.map(t => cutTube(t, fig.stops.get(t.id)!));
  push(pinstripeTube(body.trunk, env, HEMS.trunk, look), 'figure');
  push(suitFront(body.trunk, env, look), 'figure');
  for (const t of body.limbs) {
    const stop = fig.stops.get(t.id)!;
    if (t.id.startsWith('leg')) push(pinstripeTube(t, env, { seams: [0, 0.5], hems: [stop - 0.004], creases: [0.25], stop }, look), 'figure');
    else push(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, look), 'figure');
  }
  // The hands and shoes: one form each, ringed by the light like the limbs, the shoes a shade darker.
  const shoeEnv = { ...env, dark: (p: THREE.Vector3, nrm: THREE.Vector3) => Math.min(1, dark(p, nrm) + 0.25) };
  // Rings and plane edges stop where the blunt end begins, which closes with one edge round it; past
  // that only the outline shows, so the toe and fingertips read flat, not as a star of converging edges.
  const blunt = (t: Tube, e: ToneEnv) => {
    const u = 1 - t.caps[1] / t.length;
    push(contourTube(cutTube(t, u), e, look, 0.22 * k), 'figure');
    push([{ ink: 'carbon', group: 'figure', points: Array.from({ length: 73 }, (_, i) => t.point(u, i / 72, 0.004)) }], 'figure');
  };
  for (const t of fig.hands) blunt(t, env);
  for (const t of fig.shoes) blunt(t, shoeEnv);
  for (const t of [body.trunk, ...limbs, ...fig.hands, ...fig.shoes]) push(silhouettes(t, env, { ink: 'carbon', group: 'figure' }), 'figure', true);
  for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  // Slabs (throne, cubes): the raking hatch lit from the head, quieter the nearer they stand to it;
  // small far cubes only outlined, and the big near ones kept to rings and one field. The hatch's
  // spacing is on-sheet millimetres, so a cube too small on the sheet to hold it is outlined there:
  // on a small card more of the avenue is outlines. Off tabloid the throne is trimmed (kit/slabs.ts): no
  // back edges, and the slivers a low eye sees (the treads, the steps' ends) folded into its outline. The
  // cubes are not: folded, a far cube's sliver top leaves its upright edges standing short of its outline,
  // and the rows read as rails; whole, they read as the print's blocks.
  const facet = n(ctx, 'facet', 12, 6, 18);
  const outlineBelow = Math.max(n(ctx, 'outlineBelow', 5, 0, 20), MIN_FEATURE);
  const trim = { view };
  /** Slab `i`'s strokes at its current tone (replacing any it had). */
  const hatch = (i: number, replace = false) => {
    if (replace) for (let j = strokes.length - 1; j >= 0; j--) if (strokes[j].owner === i) strokes.splice(j, 1);
    const sl = slabs[i], at = new THREE.Vector3(sl.x, sl.y, sl.z), mpu = mmPerUnit(at), cube = i >= nFigure;
    const small = Math.max(sl.w, sl.h) * mpu < (cube ? outlineBelow : 1.5);
    const spacing = cube ? n(ctx, 'avenueFacet', 22, 6, 40) : facet;
    for (const st of facetStrokes(sl, head.centre.clone().sub(at).normalize(), eye, small, spacing / mpu, cube ? undefined : trim)) {
      strokes.push({ ink: 'carbon', group: groupOf(i), family: st.family, points: st.points, owner: i });
    }
  };
  for (const [i, sl] of slabs.entries()) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const toHead = head.centre.clone().sub(at).normalize();
    const cube = i >= nFigure;
    sl.tone = (2.4 * dark(at, toHead) - 1.1) * (cube ? n(ctx, 'avenueTone', 0.35, 0, 1) : 1);
    // The near cubes the print calms, measured on the print.
    if (cube && sl.w * printMmPerUnit(at) > n(ctx, 'calmAbove', 22, 5, 100)) sl.tone = Math.min(sl.tone, 0.12);
    hatch(i);
  }

  const trunkMesh = body.trunk.mesh(96, body.trunk.facets >= 3 ? body.trunk.facets * 4 : 32);
  const ends = [...fig.hands, ...fig.shoes].map(t => t.mesh(120, t.facets * 4));
  const geometries = [...slabs.map(slabGeometry), trunkMesh, ...limbs.flatMap(cutMeshes), ...ends, ...helix.meshes, skull(head)];
  // Small blocks hide their own back edges only if the depth range fits the scene.
  fitDepthRange(view, geometries);
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(geometries, view, PAGE, halo(n(ctx, 'knockout', 1.1, 0.3, 3)));
    const glowAt = pageOf(view, head.centre);

    // The censor bar: flat on the sheet across the eyes, at an odd seeded angle, knocking out what it covers.
    // It scales with the head, its inner rule and the hatch's inset with it; the hatch keeps its pitch. On a
    // small card the rule's band is narrower than the smallest feature, and the bar is its outline and hatch (`narrow`).
    const eyes = pageOf(view, head.centre.clone().addScaledVector(head.face, 0.9 * head.r).addScaledVector(head.axis, 0.12 * head.r));
    const headMm = 2 * head.r * mmPerUnit(head.centre);
    const rule = layoutLength(1.1);
    const bar = hatchedBar({ cx: eyes.x, cy: eyes.y, l: 1.75 * headMm, h: 0.36 * headMm }, world.tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]],
      rule, tolerance(layoutLength(1.6)), MIN_FEATURE);
    const onBar = inQuad(bar.quad, halo(1.4));

    // The phrase: a word at a time cut into a face of the throne or of a cube that turns toward you,
    // staggered down the card on alternating sides, each wholly in view inside a padded frame.
    const settings = sloganSettings(ctx);
    // Where the format sets the phrase in the band, under the card's name, the art carries no words.
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
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
    // A throne face whose hatch would be crossed (too dark to read a word in) is left out; a cube that
    // takes a word is re-hatched calm, in rings and one field, so the word reads.
    // The seat (the first throne slab) is left out too: its front stands between the legs, behind the feet.
    const faces = [...fig.throne.slice(1), ...cubes].flatMap(sl => [0, 1, 2, 3].map(q => {
      const m = slabMatrix(sl).multiply(new THREE.Matrix4().makeRotationY(q * Math.PI / 2));
      const fw = q % 2 ? sl.d : sl.w, half = q % 2 ? sl.w / 2 : sl.d / 2;
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(m);
      const centre = new THREE.Vector3(0, 0, half).applyMatrix4(m);
      const light = head.centre.clone().sub(new THREE.Vector3(sl.x, sl.y, sl.z)).normalize();
      return { sl, m, fw, fh: sl.h, half, facing: normal.dot(eye.clone().sub(centre).normalize()), centre, d: faceDarkness(normal, light, sl.tone) };
    })).filter(fc => cubes.includes(fc.sl) ? fc.facing > 0.1 : fc.facing > 0.3 && fc.d < 0.62).map(fc => {
      const ps = [-1, 1].flatMap(x => [-1, 1].map(y => pageOf(view, new THREE.Vector3(x * fc.fw / 2, y * fc.fh / 2, fc.half).applyMatrix4(fc.m))));
      return { ...fc, box: { x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) } };
    }).filter(fc => fc.box.x1 > CARD.x0 + layoutLength(12) && fc.box.x0 < CARD.x1 - layoutLength(12) && fc.box.y1 > CARD.y0 + layoutLength(5) && fc.box.y0 < CARD.y1 - layoutLength(5));
    const placed: Point[] = [];
    const used = new Set<Slab>();
    type Face = (typeof faces)[number];
    /** A word's size in a face's own plane: wider as the face turns away from the eye. */
    const sized = (fc: Face, word: string) => {
      const unit = 1 / mmPerUnit(fc.centre);
      return { unit, ww: measureStrokeText(word, style) * unit / Math.max(0.1, fc.facing), hh: style.height * unit };
    };
    const fits = (fc: Face, word: string, room: number) => {
      const { ww, hh } = sized(fc, word);
      return ww <= fc.fw - 2 * room * hh && hh <= fc.fh - 2 * room * hh;
    };
    /** Place a word near `target`, within `reach` of it (in tabloid millimetres, as are the offsets below). */
    const tryWord = (word: string, target: number, side: number, reach: number, room = 1.2): boolean => {
      // Only faces the word fits on, on blocks with no word yet, ranked by how near they lie to its height.
      const pick = faces.filter(fc => !used.has(fc.sl) && fits(fc, word, room))
        .filter(({ box }) => side === 0 || (side < 0 ? box.x0 < MID_X - layoutLength(8) : box.x1 > MID_X + layoutLength(8)))
        .map(fc => ({ fc, score: Math.max(0, fc.box.y0 - target, target - fc.box.y1) + layoutLength(25) * wrng() }))
        .sort((p, q) => p.score - q.score).slice(0, reach > 100 ? 80 : 18).map(({ fc }) => fc);
      for (const fc of pick) {
        const { unit, ww, hh } = sized(fc, word);
        const margin2 = room * hh;
        const sx = ww / measureStrokeText(word, style);
        for (let attempt = 0; attempt < 60; attempt++) {
          const x0 = -ww / 2 + (wrng() - 0.5) * (fc.fw - ww - 2 * margin2), y0 = hh / 2 + (wrng() - 0.5) * (fc.fh - hh - 2 * margin2);
          const centre = pageOf(view, new THREE.Vector3(x0 + ww / 2, y0 - hh / 2, fc.half).applyMatrix4(fc.m));
          const half = measureStrokeText(word, style) / 2;
          const edge = layoutLength(5);
          if (centre.x - half < CARD.x0 + edge || centre.x + half > CARD.x1 - edge || centre.y < CARD.y0 + edge || centre.y > CARD.y1 - edge) continue;
          if (Math.abs(centre.x - MID_X) < layoutLength(12) || (side !== 0 && (centre.x - MID_X) * side < 0) || Math.abs(centre.y - target) > layoutLength(reach)) continue;
          if (placed.some(p => Math.hypot(p.x - centre.x, p.y - centre.y) < layoutLength(32)) || onBar(centre)) continue;
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * sx, y0 - q.y * unit, fc.half + 0.02).applyMatrix4(fc.m)));
          // A frame round the word must be in view too, so no word sits tight against an edge in front of it.
          const pad = 0.5 * hh;
          const frameLine = [[x0 - pad, y0 + pad], [x0 + ww + pad, y0 + pad], [x0 + ww + pad, y0 - hh - pad], [x0 - pad, y0 - hh - pad], [x0 - pad, y0 + pad]]
            .map(([x, y]) => new THREE.Vector3(x, y, fc.half + 0.02).applyMatrix4(fc.m));
          if (!visible(word3) || !visible([frameLine], 0.995)) continue;
          textStrokes.push(...word3);
          placed.push(centre);
          used.add(fc.sl);
          return true;
        }
      }
      return false;
    };
    const yTop = HORIZON_Y - layoutLength(70), yBottom = CARD.y1 - layoutLength(14);
    let side = wrng() < 0.5 ? -1 : 1;
    words.forEach((word, i) => {
      const target = yTop + (yBottom - yTop) * (words.length > 1 ? i / (words.length - 1) : 0.5);
      // Its own side near its own height first, then its own side anywhere, then either side, and last
      // with less paper round it.
      if (!tryWord(word, target, side, 40) && !tryWord(word, target, side, 110) && !tryWord(word, target, 0, 170)) tryWord(word, target, 0, 120, 0.6);
      side = -side;
    });
    for (const sl of used) if (cubes.includes(sl) && sl.tone > 0.12) { sl.tone = 0.12; hatch(slabs.indexOf(sl), true); }
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const cl of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(cl), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.6));

    const buckets = new PartBuckets(0.4);
    /** A run's pieces inside the window and clear of the words and the bar (and of whatever `keep` refuses). */
    const pieces = (run: Point[], keep: (p: Point) => boolean = () => true) => clipWindow(run).flatMap(inside => keepAlong(inside, p => !onGlyph(p) && !onBar(p) && keep(p), 0.15));
    const add = (key: string, run: Point[], keep?: (p: Point) => boolean, min?: number) => {
      for (const piece of pieces(run, keep)) buckets.add(key, piece, false, min);
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
    // The coil keeps to its own ribbons: the pulse ticks the helix strews past its edges read as scraps at this size.
    const onCoil = meshCoverage(helix.meshes, view, PAGE, 0.3);
    // On a small card the figure's pieces wait for `thinParallel`, ranked: the outline, then the planes and seams, then the cloth.
    const figurePieces: { key: string; piece: Point[]; min?: number; rank: number }[] = [];
    const receive = (st: Stroke) => (runs2: { x: number; y: number }[][]) => {
      // Off tabloid a piece of hatch shorter than the smallest feature is a speck, and is dropped (`hatchMin`).
      const key = `${st.group}-${st.ink}`, min = hatchMin(st.family), rank = figureRank.get(st);
      for (const run of runs2) {
        const page = scalePoints(run, MM_X, MM_Y);
        if (rank === undefined) add(key, page, st.group === 'helix' ? onCoil : undefined, min);
        else for (const piece of pieces(page)) figurePieces.push({ key, piece, min, rank });
      }
    };
    for (const [i, mine] of bySlab) {
      const sl = slabs[i];
      const tol = Math.max(0.12, Math.min(0.5 * Math.max(1, k / 4), 0.25 * Math.min(sl.w, sl.h, sl.d)));
      projectStrokes(mine, { view, depth, width: W, height: H, bias: biasAt(tol, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, { begin: receive });
    }
    const figureAt = head.centre.clone().lerp(anchor, 0.5);
    projectStrokes(rest, { view, depth, width: W, height: H, bias: biasAt(n(ctx, 'figureSlack', 0.45, 0.05, 2) * k, eye.distanceTo(figureAt)) }, { begin: receive });
    // A limb on a small card is a few millimetres across: its planes, the pinstripe beside each plane edge and the
    // outline crowd into one band of ink. Where a line runs beside one that ranks above it, closer than the pens
    // hold apart, that stretch of it is left out.
    if (figurePieces.length) {
      const order = figurePieces.map((_, i) => i).sort((a, b) => figurePieces[a].rank - figurePieces[b].rank || a - b);
      const thinned = thinParallel(order.map(i => figurePieces[i].piece), MIN_SPACING);
      const kept: Point[][][] = [];
      order.forEach((i, j) => { kept[i] = thinned[j]; });
      figurePieces.forEach(({ key, min }, i) => { for (const piece of kept[i]) buckets.add(key, piece, false, min); });
    }

    // The paving: joints half a cube apart in the avenue's grid, from the plinth's foot to under the
    // viewer's feet. As they crowd into the distance they drop out in halves (every second, fourth,
    // eighth joint carries on), so the grid keeps an even weight; knocked out round all that stands.
    const gapMm = tolerance(n(ctx, 'groundGap', 3.2, 1.5, 8));
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
    // The opening round the head scales with the card; the ruling's pitch and its breaks stay in real millimetres.
    const glowR = layoutLength(n(ctx, 'skyGlow', 95, 0, 160));
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    const skyPitch = tolerance(n(ctx, 'skyPitch', 0.9, 0.5, 1.5));
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
    // What shows of the horizon (off tabloid an empty one is no part; the print keeps its part).
    const horizon = keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !onBar(p), 0.3);
    if (horizon.length || FORMAT.tabloid) parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: horizon });
    parts.push(...cardFrame('IV', 'THE EMPEROR', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
