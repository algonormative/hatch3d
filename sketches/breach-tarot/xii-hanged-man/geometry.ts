import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks, circlePath } from '../../kit/fills.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
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
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 8.3;

export function plumbCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
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
 * its own way off true, clean edged so the lean reads as one long diagonal.
 */
export function leaningCity(ctx: SketchContext, view: THREE.PerspectiveCamera, line: THREE.Vector3): Slab[] {
  const rng = ctx.random('plumb-city'), detail = ctx.random('plumb-courses');
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const halfW = (CARD.x1 - CARD.x0) / 2;
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
    const height = (CARD.y1 - CARD.y0) / f * (view.position.z - z) * (0.55 + 0.6 * rng());
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

export function drawHangedMan(ctx: SketchContext): Part[] {
  const view = plumbCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = TABLOID_PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  // The line hangs down the middle of the card; its foot lands a set distance below the horizon.
  const foot = onGround(view, { x: TABLOID_PAGE.width / 2 + n(ctx, 'lineX', 0, -0.3, 0.3) * (CARD.x1 - CARD.x0) / 2, y: HORIZON_Y + n(ctx, 'footDrop', 112, 15, 140) });
  const k = 1 / mmPerUnit(foot);
  const bobH = n(ctx, 'bob', 84, 25, 130) * k, bobW = bobH * n(ctx, 'bobWidth', 0.9, 0.4, 1.3), gap = n(ctx, 'gap', 3, 0.5, 15) * k;
  const bobTop = foot.clone().setY(gap + bobH);
  const bob = plumbBob(bobTop, bobH, bobW);
  const city = leaningCity(ctx, view, foot);
  const light = new THREE.Vector3(0.55, 0.6, 0.6).normalize();

  // The line: dead straight, true vertical. The twin helix comes down it wound tight and unravels a
  // short way above the block; below that, one bare thread holds all the weight.
  const skyTop = bobTop.clone().setY(bobTop.y + 400);
  const unravel = bobTop.clone().setY(bobTop.y + n(ctx, 'bare', 34, 8, 120) * k);
  const line = helixAlong(ctx, view, new THREE.CatmullRomCurve3([skyTop, unravel.clone().setY(unravel.y + 60), unravel], false, 'centripetal'),
    { radius: n(ctx, 'thread', 0.12, 0.05, 1.2), width: 0.14, pitch: 1.6, spread: 0.02, narrow: 0.02 });
  const plumb: Stroke = { ink: 'carbon', group: 'line', family: 'edge', points: [skyTop, bobTop.clone()] };

  const strokes: Stroke[] = [];
  // The block is lit from behind, so the faces we see fall dark and heavy.
  const backlight = new THREE.Vector3(-0.25, 0.55, -0.8).normalize();
  for (const [group, slabs, l] of [['city', city, light], ['bob', bob, backlight]] as const) for (const sl of slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    for (const st of facetStrokes(sl, l, eye, Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5, FACET_MM_PER_UNIT / mmPerUnit(at))) {
      strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
    }
  }
  for (const h of line.strokes) strokes.push({ ink: h.ink, group: 'line', family: 'membrane', points: h.points });
  strokes.push(plumb);

  const geometries = [...city.map(slabGeometry), ...bob.map(slabGeometry), ...line.meshes];
  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The target: a flat hatched ring round the point where the line would meet the ground.
    const centre = pageOf(view, foot);
    const r = n(ctx, 'ring', 20, 5, 40);
    const ring = circlePath(centre, r, 240);
    const band = 1.5;
    const ringPaths = bandMarks(ring, band, { x0: centre.x - r - 4, x1: centre.x + r + 4, y0: centre.y - r - 4, y1: centre.y + r + 4 }, { pitch: 0.6, angle: Math.PI / 4 });
    const onRing = glyphMask([ring], band + 1.2);
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));

    // The phrase. In the towers: each word cut into a front face of a different tower, leaning with
    // it, staggered from the top of the sky down. Flat: painted on the ground with no foreshortening.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
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
      const top = HORIZON_Y + 10, bottom = CARD.y1 - 6;
      let side = wrng() < 0.5 ? -1 : 1;
      words.forEach((word, i) => {
        const w = measureStrokeText(word, style);
        const yy = top + (bottom - top) * (i + 0.5) / words.length;
        const xx = clamp((CARD.x0 + CARD.x1) / 2 + side * (r + 14 + 70 * wrng()) - w / 2, CARD.x0 + 2, CARD.x1 - w - 2);
        flatPaths.push(...strokeText(word, xx, yy, style));
        side = -side;
      });
    } else {
      const style = { face: settings.face, height: settings.size };
      const used = new Set<string>();
      const towerOf = (sl: Slab) => `${Math.round(sl.rz * 1000)}`;
      words.forEach((word, i) => {
        const target = CARD.y0 + 18 + (HORIZON_Y - CARD.y0 - 40) * i / Math.max(1, words.length - 1);
        // Alternate sides, a tower to a word; when that runs out, any face on either side.
        const pick = (wantLeft: boolean | null, fresh: boolean) => city.filter(sl => !fresh || !used.has(towerOf(sl)))
          .map(sl => ({ sl, at: pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z)) }))
          .filter(({ sl, at }) => (wantLeft === null || (at.x < centre.x) === wantLeft) && at.y > CARD.y0 + 6 && at.y < HORIZON_Y - 6 && at.x > CARD.x0 + 8 && at.x < CARD.x1 - 8 && sl.h > 2)
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
    const onGlyph = glyphMask(glyphPaths, 0.6);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onRing(p) && extra(p), 0.15)) buckets.add(key, piece);
    };
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // The sky: a ruled night, densest at the top and opening toward the horizon, knocked out round
    // everything standing in it, broken in the 64-step rhythm as it thins.
    const pattern = barPattern(ctx.random('plumb-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += 0.62) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      if (!(t < 0.45 || tier === 0 || (tier === 1 && t < 0.75))) continue;
      const broken = t > 0.55;
      add(i % 4 === 0 ? 'sky-ultramarine' : 'sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => !solids(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    // The ring lies on the ground: the block hangs in front of it.
    const onBob = meshCoverage(bob.map(slabGeometry), view, TABLOID_PAGE, 0.8);
    for (const path of ringPaths) for (const inside of clipWindow(path)) for (const piece of keepAlong(inside, p => !onBob(p), 0.12)) buckets.add('ring-carbon', piece);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'city', 'bob', 'line', 'ring', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !onRing(p), 0.3) });
    parts.push(...cardFrame('XII', 'THE HANGED MAN'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
