import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, halo, hatchMin, layoutLength, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { faceDarkness, facetStrokes, slabEdges, slabGeometry, slabMatrix, solid, type FacetStroke, type Slab } from '../../kit/slabs.ts';
import { helixAlong, narrowStrands } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks, circlePath } from '../../kit/fills.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { horizonCamera, onGround, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * XII The Hanged Man: it is easier to see from here. Not a hanged man but what hanging does: a
 * plumb line. One heavy dark stepped block hangs dead still from the top of the card, precariously:
 * the helix comes down the line wound tight round it and unravels just above the block, so the last
 * stretch holding all that weight is a single bare thread. Its point stops just above the ground;
 * round it a flat hatched ring, the halo turned target, is the card's flat mark. All round it the
 * city leans: Breach towers each tilted its own way, the phrase cut into their faces and leaning
 * with them. The one thing hanging still is the only true vertical on the card. The sky is a ruled
 * night knocked out round all that stands in it; the ground is open paper.
 *
 * On a small card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`plumbWorld`), and the
 * card's own camera draws it: the ring and the halos scale with the card, the sky's ruling keeps its pitch on paper,
 * small slabs are trimmed to their outlines, and the phrase moves to the bottom band.
 */
/** The card's depth raster at tabloid; on any other page, the format's. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 8.3;

/** The card's camera, on the format's page. */
export function plumbCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the card's world is laid out with. At tabloid it is `plumbCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye: EYE, near: 8, far: 4000 });
}

export interface PlumbWorld {
  /** Where the line would meet the ground: the ring's centre. */
  foot: THREE.Vector3;
  /** The top of the bob, where the bare thread ends. */
  bobTop: THREE.Vector3;
  bob: Slab[];
  city: Slab[];
  /** The line's top, far above the card, and where its helix unravels into the bare thread. */
  skyTop: THREE.Vector3;
  unravel: THREE.Vector3;
}

/**
 * The card's world: where the line falls, the bob hung on it, the leaning city and the line's own course. It is laid
 * out in tabloid's frame, with `worldCamera` and tabloid's page millimetres, so every size and fit builds the same
 * world, to the bit; each card's own camera then draws it.
 */
export function plumbWorld(ctx: SketchContext): PlumbWorld {
  const camera = worldCamera(ctx);
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, camera.position.z - p.z);
  // The line hangs down the middle of the card; its foot lands a set distance below the horizon (on the print).
  const foot = onGround(camera, {
    x: TABLOID_PAGE.width / 2 + n(ctx, 'lineX', 0, -0.3, 0.3) * (TABLOID_CARD.x1 - TABLOID_CARD.x0) / 2,
    y: TABLOID_HORIZON_Y + n(ctx, 'footDrop', 112, 15, 140),
  }, TABLOID_PAGE);
  const k = 1 / mmPerUnit(foot);
  const bobH = n(ctx, 'bob', 84, 25, 130) * k, bobW = bobH * n(ctx, 'bobWidth', 0.9, 0.4, 1.3), gap = n(ctx, 'gap', 3, 0.5, 15) * k;
  const bobTop = foot.clone().setY(gap + bobH);
  return {
    foot, bobTop, bob: plumbBob(bobTop, bobH, bobW), city: leaningCity(ctx, camera, foot),
    skyTop: bobTop.clone().setY(bobTop.y + 400), unravel: bobTop.clone().setY(bobTop.y + n(ctx, 'bare', 34, 8, 120) * k),
  };
}

/** The bob: slab courses widest at the top, stepping in to a point, hung from `top`. */
export function plumbBob(top: THREE.Vector3, height: number, width: number): Slab[] {
  const out: Slab[] = [];
  const courses = 8;
  const ch = height / courses;
  for (let i = 0; i < courses; i++) {
    const f = i / (courses - 1);
    // A short neck, broad heavy shoulders, then a taper to the point.
    const w = width * (i === 0 ? 0.28 : f < 0.3 ? 0.8 + 0.7 * f : 1.01 - 0.94 * ((f - 0.3) / 0.7) ** 1.15);
    const sl = solid(top.x, top.y - (i + 0.5) * ch, top.z, Math.max(0.25, w), ch - 0.05, Math.max(0.25, w), out.length, 'stack');
    sl.ry = Math.PI / 4;
    sl.tone = 1.6;
    out.push(sl);
  }
  return out;
}

/**
 * The crooked city: a few tall towers of thin slab courses, each standing on the horizon and leaning
 * its own way off true, clean edged so the lean reads as one long diagonal. Laid out in tabloid's frame:
 * `view` is `worldCamera` (see `plumbWorld`).
 */
export function leaningCity(ctx: SketchContext, view: THREE.PerspectiveCamera, line: THREE.Vector3): Slab[] {
  const rng = ctx.random('plumb-city'), detail = ctx.random('plumb-courses');
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const halfW = (TABLOID_CARD.x1 - TABLOID_CARD.x0) / 2;
  const maxLean = THREE.MathUtils.degToRad(n(ctx, 'lean', 18, 3, 30));
  const out: Slab[] = [];
  const count = Math.round(n(ctx, 'towers', 6, 2, 14));
  // Slots across the card, the middle one left empty for the line.
  const slots = Array.from({ length: count }, (_, i) => {
    const u = (i + 0.5) / count * 2 - 1;
    return Math.sign(u) * (0.22 + 0.78 * Math.abs(u));
  });
  for (const [i, u] of slots.entries()) {
    const z = line.z - 90 - 220 * rng();
    const reach = halfW / f * (view.position.z - z);
    const x = line.x + u * reach * (0.95 + 0.1 * rng());
    const height = (TABLOID_CARD.y1 - TABLOID_CARD.y0) / f * (view.position.z - z) * (0.55 + 0.6 * rng());
    // Lean in the picture plane, alternating in sense, never true; a little toward or away too.
    const roll = (i % 2 ? -1 : 1) * (rng() < 0.3 ? -1 : 1) * maxLean * (0.35 + 0.65 * rng());
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * maxLean * 0.4, (rng() - 0.5) * 0.5, roll, 'XYZ'));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    let w = 7 + 7 * rng();
    const d = 6 + 4 * rng(), course = 2.6 + 1.2 * rng();
    // The placement stream keeps its old pace (one draw per even course), so a seed's layout holds
    // while the courses themselves come from their own stream.
    for (let y = 0; y < height; y += course) rng();
    for (let y = 0; y < height;) {
      // Courses of uneven depth; now and then a deep one, a step in or out, a slip sideways.
      const h = detail() < 0.18 ? 5 + 4 * detail() : 2.2 + 2.2 * detail();
      if (detail() < 0.2) w = clamp(w + (detail() - 0.5) * 6, 5, 16);
      const slip = (detail() - 0.5) * 1.2;
      const c = new THREE.Vector3(x, 0, z).addScaledVector(axis, y + h / 2).addScaledVector(side, slip);
      // A course split in two blocks, with a gap, sometimes.
      const split = detail() < 0.25 ? 0.3 + 0.4 * detail() : 0;
      const pieces = split ? [[-w / 2 + w * split / 2, w * split - 0.4], [w * split / 2, w * (1 - split) - 0.4]] : [[0, w]];
      for (const [off, pw] of pieces) {
        const pc = c.clone().addScaledVector(side, off);
        const sl = solid(pc.x, pc.y, pc.z, pw, h - 0.12, d, out.length, 'stack');
        sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
        sl.tone = 0.55 + 0.45 * detail();
        out.push(sl);
      }
      y += h;
    }
  }
  return out;
}

/** The pitch, in millimetres on paper, of the raking-light hatch's contour rings on its darkest faces (0.075 × 8.3). */
const RULE_MM = 0.62;
/** The faces of a slab in its own frame: each face's centre, and its two half-extents (as in `facetStrokes`). */
const slabFaces = (s: Slab): [THREE.Vector3, THREE.Vector3, THREE.Vector3][] => {
  const hx = s.w / 2, hy = s.h / 2, hz = s.d / 2;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  return [
    [v(0, 0, hz), v(hx, 0, 0), v(0, hy, 0)], [v(0, 0, -hz), v(-hx, 0, 0), v(0, hy, 0)],
    [v(hx, 0, 0), v(0, 0, -hz), v(0, hy, 0)], [v(-hx, 0, 0), v(0, 0, hz), v(0, hy, 0)],
    [v(0, hy, 0), v(hx, 0, 0), v(0, 0, -hz)], [v(0, -hy, 0), v(hx, 0, 0), v(0, 0, hz)],
  ];
};

/**
 * A small card's dark slab faces, ruled. A course of the bob is a few millimetres tall on a 70 × 120 card, where the
 * raking-light hatch (`facetStrokes`, its rings a fraction of the face deep at a pitch held on paper) fits one ring and
 * leaves the middle paper: the heavy block would print light. Each face that sees the eye, is dark enough that the
 * print crosses its hatch, and is no narrower on paper than the smallest feature, is ruled along its length instead,
 * inside its outline, lines `step` world units apart or a little more (carbon and ultramarine by turns, the print's
 * ring and field inks), so the bob keeps its weight. A card calls it only off tabloid.
 */
function ruledFaces(s: Slab, light: THREE.Vector3, view: THREE.Camera, step: number): FacetStroke[] {
  const m = slabMatrix(s), rot = new THREE.Matrix4().extractRotation(m);
  const out: FacetStroke[] = [];
  for (const [c0, U0, V0] of slabFaces(s)) {
    const normal = c0.clone().normalize().applyMatrix4(rot);
    const centre = c0.clone().applyMatrix4(m).addScaledVector(normal, 0.006);
    if (view.position.clone().sub(centre).dot(normal) <= 0 || faceDarkness(normal, light, s.tone) <= 0.62) continue;
    // Along the face's longer side, across its shorter.
    const [along, across] = U0.length() >= V0.length() ? [U0, V0] : [V0, U0];
    const half = across.length(), long = along.length();
    const A = along.clone().normalize().applyMatrix4(rot), B = across.clone().normalize().applyMatrix4(rot);
    const at = (u: number, v: number) => centre.clone().addScaledVector(A, u).addScaledVector(B, v);
    const p = pageOf(view, at(0, -half)), q = pageOf(view, at(0, half));
    if (Math.hypot(q.x - p.x, q.y - p.y) < MIN_FEATURE) continue;
    const lines = Math.floor(2 * half / step) - 1;
    const gap = 2 * half / (lines + 1);
    if (lines < 1 || long <= gap) continue;
    for (let j = 0; j < lines; j++) {
      const v = -half + (j + 1) * gap;
      out.push({ ink: j % 2 ? 'ultramarine' : 'carbon', group: 'system', family: 'hatch', points: [at(-long + gap, v), at(long - gap, v)] });
    }
  }
  return out;
}

/**
 * A bob course's outline on a small card: the trimmed outline (`slabEdges`), its top drawn by the top face's near edges
 * alone, where its side faces meet it. Seen from just above, the top faces are slivers on a small card, and their far
 * edges flicker in and out of the depth test (a pixel there is a long step of depth along a face so nearly edge-on) and
 * print as dashes. A course the one above overhangs (`covered`) shows its top only through the hair's gap between them,
 * a quarter of a millimetre at 70 × 120, where its near edges would double the joint, dashed: there the joint is the
 * upper course's edge alone.
 */
function courseOutline(s: Slab, view: THREE.Camera, covered: boolean): THREE.Vector3[][] {
  const m = slabMatrix(s), inverse = m.clone().invert(), rot = new THREE.Matrix4().extractRotation(m);
  const hx = s.w / 2, hy = s.h / 2, hz = s.d / 2, e = 0.006;
  const onTop = (edge: THREE.Vector3[]) => edge.every(p => Math.abs(p.clone().applyMatrix4(inverse).y - hy) < 0.02);
  const edges = slabEdges(s, view).filter(edge => !onTop(edge));
  if (covered) return edges;
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  // Whether the side face whose outward normal is `normal` (in the slab's frame) sees the eye.
  const sees = (normal: THREE.Vector3, half: number) => {
    const n3 = normal.clone().applyMatrix4(rot);
    return view.position.clone().sub(P(normal.x * half, 0, normal.z * half)).dot(n3) > 0;
  };
  for (const side of [-1, 1]) {
    if (sees(new THREE.Vector3(0, 0, side), hz)) edges.push([P(-hx, hy + e, side * (hz + e)), P(hx, hy + e, side * (hz + e))]);
    if (sees(new THREE.Vector3(side, 0, 0), hx)) edges.push([P(side * (hx + e), hy + e, -hz), P(side * (hx + e), hy + e, hz)]);
  }
  return edges;
}

export function drawHangedMan(ctx: SketchContext): Part[] {
  const view = plumbCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  // The world, the same at every size; this card's camera draws it.
  const { foot, bobTop, bob, city, skyTop, unravel } = plumbWorld(ctx);
  const light = new THREE.Vector3(0.55, 0.6, 0.6).normalize();

  // The line: dead straight, true vertical. The twin helix comes down it wound tight and unravels a
  // short way above the block; below that, one bare thread holds all the weight. Its lamination is
  // spaced on this card's paper, so it takes this card's camera.
  const line = helixAlong(ctx, view, new THREE.CatmullRomCurve3([skyTop, unravel.clone().setY(unravel.y + 60), unravel], false, 'centripetal'),
    { radius: n(ctx, 'thread', 0.12, 0.05, 1.2), width: 0.14, pitch: 1.6, spread: 0.02, narrow: 0.02 });
  const plumb: Stroke = { ink: 'carbon', group: 'line', family: 'edge', points: [skyTop, bobTop.clone()] };

  const strokes: Stroke[] = [];
  // The block is lit from behind, so the faces we see fall dark and heavy.
  const backlight = new THREE.Vector3(-0.25, 0.55, -0.8).normalize();
  // Under 1.5 mm on this card's paper a slab is an outline. Off tabloid every outline is trimmed (kit/slabs.ts): no back
  // edges, and faces narrower than the smallest feature folded into it, so the courses don't double their edges. There
  // the bob is its courses' outlines (`courseOutline`) and its dark faces ruled (`ruledFaces`), where the raking-light
  // hatch would leave them paper.
  for (const [group, slabs, l] of [['city', city, light], ['bob', bob, backlight]] as const) for (const sl of slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    if (group === 'bob' && !FORMAT.tabloid) {
      const covered = sl.beat > 0 && slabs[sl.beat - 1].w >= sl.w;
      for (const points of courseOutline(sl, view, covered)) strokes.push({ ink: 'carbon', group, family: 'edge', points });
      for (const st of ruledFaces(sl, l, view, RULE_MM / mmPerUnit(at))) strokes.push({ ...st, group });
      continue;
    }
    for (const st of facetStrokes(sl, l, eye, Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5, FACET_MM_PER_UNIT / mmPerUnit(at), { view })) {
      strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
    }
  }
  // The line's helix strands, each drawn as one line where its ribbon is narrower on this card's paper than the smallest
  // feature (none at tabloid). A strand's edges run a fifth of a millimetre apart on a 70 × 120 card and would print as
  // one blot, so they become one line down the ribbon's middle, and everything else the helix draws is kept.
  const inWindow = (p: Point) => p.y > CARD.y0 && p.y < CARD.y1;
  for (const h of narrowStrands(line.strokes, view, { measure: 'widest', counts: inWindow, keep: 'rest' })) strokes.push({ ink: h.ink, group: 'line', family: 'membrane', points: h.points });
  strokes.push(plumb);

  const geometries = [...city.map(slabGeometry), ...bob.map(slabGeometry), ...line.meshes];
  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The target: a flat hatched ring round the point where the line would meet the ground. A flat mark, sized with
    // the card; a band narrower than the smallest feature is drawn as its centreline.
    const centre = pageOf(view, foot);
    const r = layoutLength(n(ctx, 'ring', 20, 5, 40));
    const ring = circlePath(centre, r, 240);
    const band = layoutLength(1.5), pad = layoutLength(4);
    const ringPaths = bandMarks(ring, band, { x0: centre.x - r - pad, x1: centre.x + r + pad, y0: centre.y - r - pad, y1: centre.y + r + pad },
      { pitch: tolerance(0.6), angle: Math.PI / 4, narrow: MIN_FEATURE });
    const onRing = glyphMask([ring], band + halo(1.2));
    const solids = meshCoverage(geometries, view, PAGE, halo(n(ctx, 'knockout', 1.1, 0.3, 3)));

    // The phrase. In the towers: each word cut into a front face of a different tower, leaning with
    // it, staggered from the top of the sky down. Flat: painted on the ground with no foreshortening. Or, where the
    // format sets it in the band, under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('plumb-words');
    const textStrokes: THREE.Vector3[][] = [];
    const flatPaths: Point[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    if (ctx.params.phrasePlace === 'flat') {
      const style = { face: settings.face, height: settings.size + 0.4 };
      const top = HORIZON_Y + layoutLength(10), bottom = CARD.y1 - layoutLength(6);
      let side = wrng() < 0.5 ? -1 : 1;
      words.forEach((word, i) => {
        const w = measureStrokeText(word, style);
        const yy = top + (bottom - top) * (i + 0.5) / words.length;
        const xx = clamp((CARD.x0 + CARD.x1) / 2 + side * (r + layoutLength(14) + layoutLength(70 * wrng())) - w / 2, CARD.x0 + layoutLength(2), CARD.x1 - w - layoutLength(2));
        flatPaths.push(...strokeText(word, xx, yy, style));
        side = -side;
      });
    } else {
      const style = { face: settings.face, height: settings.size };
      const used = new Set<string>();
      const towerOf = (sl: Slab) => `${Math.round(sl.rz * 1000)}`;
      words.forEach((word, i) => {
        const target = CARD.y0 + layoutLength(18) + (HORIZON_Y - CARD.y0 - layoutLength(40)) * i / Math.max(1, words.length - 1);
        // Alternate sides, a tower to a word; when that runs out, any face on either side.
        const pick = (wantLeft: boolean | null, fresh: boolean) => city.filter(sl => !fresh || !used.has(towerOf(sl)))
          .map(sl => ({ sl, at: pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z)) }))
          .filter(({ sl, at }) => (wantLeft === null || (at.x < centre.x) === wantLeft) && at.y > CARD.y0 + layoutLength(6) && at.y < HORIZON_Y - layoutLength(6)
            && at.x > CARD.x0 + layoutLength(8) && at.x < CARD.x1 - layoutLength(8) && sl.h > 2)
          .sort((a, b) => Math.abs(a.at.y - target) - Math.abs(b.at.y - target)).slice(0, 40);
        for (const { sl } of [...pick(i % 2 === 0, true), ...pick(null, false)]) {
          const m = slabMatrix(sl);
          const unit = 1 / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
          const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
          if (ww > sl.w - 0.8 || hh > sl.h - 0.4) continue;
          const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 0.8), y0 = hh / 2;
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q2 => new THREE.Vector3(x0 + q2.x * unit, y0 - q2.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
          if (!visible(word3)) continue;
          textStrokes.push(...word3);
          used.add(towerOf(sl));
          break;
        }
      });
    }
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    glyphPaths.push(...flatPaths);
    const onGlyph = glyphMask(glyphPaths, halo(0.6));
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onRing(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    // Off tabloid a scrap of a face's hatch shorter than the smallest feature is a speck, and dropped (`hatchMin`; the print keeps all).
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), undefined, hatchMin(st.family)); },
    });
    // The sky: a ruled night, densest at the top and opening toward the horizon, knocked out round
    // everything standing in it, broken in the 64-step rhythm as it thins. The ruling and its breaks keep their
    // millimetres on paper, so a small card keeps the print's tones in fewer rules.
    const pattern = barPattern(ctx.random('plumb-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - layoutLength(1);
    for (let y = skyTop + tolerance(0.3), i = 0; y < skyBottom; i++, y += tolerance(0.62)) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      if (!(t < 0.45 || tier === 0 || (tier === 1 && t < 0.75))) continue;
      const broken = t > 0.55;
      add(i % 4 === 0 ? 'sky-ultramarine' : 'sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => !solids(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    // The ring lies on the ground: the block hangs in front of it.
    const onBob = meshCoverage(bob.map(slabGeometry), view, PAGE, halo(0.8));
    for (const path of ringPaths) for (const inside of clipWindow(path)) for (const piece of keepAlong(inside, p => !onBob(p), 0.12)) buckets.add('ring-carbon', piece);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'city', 'bob', 'line', 'ring', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !onRing(p), 0.3) });
    parts.push(...cardFrame('XII', 'THE HANGED MAN', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
