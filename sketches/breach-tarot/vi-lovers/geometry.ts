import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { slabGeometry, slabMatrix } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { figureMeshes, figureStrokes, footOf, meeting } from './figures.ts';
import { roundedPocket } from './pocket.ts';
import { shadowOf } from './shadows.ts';
import { Spine, leadStrand, strand, winding, type Ribbon } from './strands.ts';
import { buildTower, calmFacets, coursePattern, type Piece, type Tower } from './towers.ts';

/**
 * VI The Lovers: it wants what you want. Two small figures have each walked out a little way from
 * their own tower and meet in front of the towers, facing each other, reaching, their hands a breath
 * apart. The towers are what each brought: tall slender stacks of deep slab courses at two distances,
 * each leaning toward the other. The far one is the near one's reflection, almost exact: the same
 * courses mirrored, but misregistered (a few courses out of step above a slip, a sideways slide high
 * up, a slight shear), for they brought almost the same thing, which is what the phrase doubts. One
 * thin strand rises from the top of each tower in a smooth arc toward the other; they meet and wind
 * round each other as the double helix, which climbs to the top of the card. A low light from the
 * front and the left throws every long shadow back across the ground; the near tower's shadow runs
 * back to touch the far tower's foot, and the lovers' hands, which do not touch, cast shadows that do.
 * The sky is a light ruling knocked out round what stands in it. The phrase is cut into the towers'
 * course faces word by word: `wants` on the near tower and `want` on the far one sit at mirrored
 * places, slightly off.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 7.2;
/** Hidden-line slack in world units, per family: masonry (the kit's 0.6), thin ribbons, the small figures' tubes. */
const SLACK = { slab: 0.6, helix: 0.12, figure: 0.03 } as const;
/** Depth bands: each gets its own bias, so the slack is the same distance in the world near and far. */
const BAND_EDGES = [18, 24, 27, 30, 34, 39, 45, 53, 62, 75, 95, Infinity];

export function loversCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** A polyline cut into runs of at most `size` points, each sharing its end point with the next. */
function chunk<T>(points: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < points.length - 1; i += size - 1) out.push(points.slice(i, Math.min(points.length, i + size)));
  return out;
}

type Placed = Stroke & { band: number; kind: keyof typeof SLACK };

export function drawLovers(ctx: SketchContext): Part[] {
  const view = loversCamera(ctx);
  const eye = view.position.clone();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  /** The world point `d` units in front of the eye that lands at page position (px, py). */
  const at = (px: number, py: number, d: number) => new THREE.Vector3((px - TABLOID_PAGE.width / 2) * d / f, EYE + (HORIZON_Y - py) * d / f, -d);
  const bandOf = (p: THREE.Vector3) => Math.max(0, BAND_EDGES.findIndex((edge, i) => eye.z - p.z >= edge && eye.z - p.z < BAND_EDGES[i + 1]));

  // The pattern both towers are cut from, and how they stand: turned toward each other, each leaning toward the other.
  const count = Math.round(n(ctx, 'courses', 12, 8, 24));
  const skip = Math.round(n(ctx, 'skip', 2, 0, 6));
  const breakAt = Math.round(n(ctx, 'breakAt', 0.55, 0.2, 0.9) * count);
  const pattern = coursePattern(ctx.random('lovers-courses'), count + skip, n(ctx, 'width', 5.2, 3.5, 12));
  const yaw = THREE.MathUtils.degToRad(n(ctx, 'yaw', 8, 8, 45));
  const lean = THREE.MathUtils.degToRad(n(ctx, 'lean', 5, 0, 12));
  const heightAt = (top: number, base: THREE.Vector3) => EYE + (HORIZON_Y - top) * (eye.z - base.z) / f;
  const nearTop = n(ctx, 'nearTop', 175, 60, 220), farRatio = n(ctx, 'farRatio', 1, 0.6, 1.3);

  // One low light from the left and a little in front throws every shadow back across the ground and to the right.
  const lightAz = THREE.MathUtils.degToRad(n(ctx, 'lightAz', 48, 0, 60)), lightEl = THREE.MathUtils.degToRad(n(ctx, 'lightEl', 34, 15, 70));
  const light = new THREE.Vector3(-Math.sin(lightAz) * Math.cos(lightEl), Math.sin(lightEl), Math.cos(lightAz) * Math.cos(lightEl));

  // The lovers float in the air and meet in the middle, facing along a line that runs a little away from the eye, their
  // fingertips a breath apart along the light. Each has its tower behind it, out along that line and a step back from it,
  // so each floats just in front of its tower's inner edge and leans out into the gap between.
  const figDepth = n(ctx, 'figDepth', 26, 18, 45);
  const unitMm = f / figDepth;
  const centre = at(n(ctx, 'figX', 144, 90, 190), 0, figDepth);
  centre.y = 0;
  const line = THREE.MathUtils.radToDeg(THREE.MathUtils.degToRad(n(ctx, 'line', 22, 0, 45)));
  const turn = n(ctx, 'figTurn', 10, 0, 40);
  const heightLeft = n(ctx, 'figHeight', 60, 35, 70) / unitMm;
  const lovers = meeting({
    heights: [heightLeft, heightLeft * n(ctx, 'farFigure', 0.93, 0.7, 1.1)],
    yaws: [90 + line - turn, -(90 - line) - turn],
    reach: n(ctx, 'figReach', 80, 30, 120), lean: n(ctx, 'figLean', 20, 0, 40), gap: n(ctx, 'handGap', 5, 2, 15) / unitMm, light, centre,
    pelvisAt: n(ctx, 'floatAt', 0.3, 0.2, 0.7) * heightAt(nearTop, centre),
  });
  const a = footOf(lovers.left), b = footOf(lovers.right);
  const along = b.clone().sub(a).normalize();
  const back = new THREE.Vector3(-along.z, 0, along.x);
  if (back.z > 0) back.negate();
  const toTower = n(ctx, 'figToTower', 3.1, 0, 6), front = n(ctx, 'figFront', 2, 0.5, 6);
  const nearBase = a.clone().addScaledVector(along, -toTower).addScaledVector(back, front);
  const farBase = b.clone().addScaledVector(along, toTower).addScaledVector(back, front);
  const nearHeight = heightAt(nearTop, nearBase);
  const near = buildTower({
    id: 'near', base: nearBase, yaw: -yaw, lean: -lean, height: nearHeight, courses: pattern.slice(0, count), mirror: 1, shear: 0, slide: 0, slideFrom: 1e9,
  });
  // The far twin: the courses mirrored, but above the slip `skip` courses further along the pattern, the stack sheared and slid.
  const far = buildTower({
    id: 'far', base: farBase, yaw, lean, height: nearHeight * farRatio,
    courses: pattern.slice(0, count).map((_, i) => pattern[i >= breakAt ? i + skip : i]), mirror: -1,
    shear: n(ctx, 'shear', -0.03, -0.2, 0.2), slide: n(ctx, 'slide', 0.5, -3, 3), slideFrom: breakAt,
  });

  // The strands: one from each tower top, in one smooth arc, meeting, then winding together up the card. Built larger, then scaled back.
  const S = n(ctx, 'helixScale', 8, 4, 40);
  const bigView = view.clone();
  bigView.position.multiplyScalar(S); bigView.near *= S; bigView.far *= S;
  bigView.updateProjectionMatrix(); bigView.updateMatrixWorld(true);
  const meetX = n(ctx, 'meetX', 125, 100, 180), meetDepth = n(ctx, 'meetDepth', 28, 20, 90), tailX = n(ctx, 'tailX', 115, 90, 190);
  const meet = at(meetX, n(ctx, 'meetY', 108, 60, 150), meetDepth);
  const tail = new THREE.CatmullRomCurve3([meet.clone(), at((meetX + tailX) / 2, 72, meetDepth + 0.5), at(tailX, 0, meetDepth + 1)], false, 'centripetal');
  const tau = tail.getTangentAt(0);
  const arm = THREE.MathUtils.degToRad(n(ctx, 'armAngle', 42, 30, 80));
  // Each lead-in leaves its roof at `armAngle` above the horizontal, toward the other tower, and bends one way only into the tail's direction.
  const lead = (top: THREE.Vector3) => {
    const from = top.clone().add(new THREE.Vector3(0, 0.05, 0)), reach = from.distanceTo(meet);
    const toward = new THREE.Vector3(meet.x - from.x, 0, meet.z - from.z).normalize();
    const start = toward.multiplyScalar(Math.cos(arm)).add(new THREE.Vector3(0, Math.sin(arm), 0));
    return new THREE.CubicBezierCurve3(from, from.clone().addScaledVector(start, reach * 0.45), meet.clone().addScaledVector(tau, -reach * 0.4), meet.clone());
  };
  const leadA = lead(near.top), leadB = lead(far.top);
  const spineA = new Spine(leadA, tail, S), spineB = new Spine(leadB, tail, S);
  const ribbon: Ribbon = {
    radius: n(ctx, 'helixR', 1.9, 0.5, 4) * S, width: n(ctx, 'ribbon', 0.12, 0.08, 1.5) * S, pitch: n(ctx, 'pitch', 3.2, 1.5, 12) * S,
    open: n(ctx, 'open', 2.0, 0.5, 12) * S, flare: n(ctx, 'flare', 2.0, 0.5, 12) * S, slim: n(ctx, 'slim', 0, 0, 1),
  };
  // Phase: each strand has wound its own number of turns by the meeting point; turn the second so the two sit as in the full helix beyond it.
  const strandA = strand(ctx, bigView, spineA, 0, ribbon, 0, S);
  const strandB = strand(ctx, bigView, spineB, 1, ribbon, -(winding(spineB, ribbon).joinTurns - winding(spineA, ribbon).joinTurns), S);
  // Each strand's lead-in, from its tower top to the meeting point, a thin ribbon on its own smooth arc.
  const leadWidth = n(ctx, 'leadWidth', 0.1, 0.02, 0.4) * S;
  const leadRibbonA = leadStrand(ctx, bigView, new Spine(leadA, null, S), 0, leadWidth, S);
  const leadRibbonB = leadStrand(ctx, bigView, new Spine(leadB, null, S), 1, leadWidth, S);

  const lit = (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.9 * (1 - Math.max(0, normal.dot(light))) ** 1.3 + 0.04, 0, 1);
  const env = { forward, density: 0.4, dark: lit, screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; } };

  const placed: Placed[] = [];
  for (const tower of [near, far]) for (const { sl } of tower.pieces) {
    const centre = new THREE.Vector3(sl.x, sl.y, sl.z);
    const band = bandOf(centre);
    for (const st of calmFacets(sl, light, eye, Math.max(sl.w, sl.h) * mmPerUnit(centre) < 1.5, FACET_MM_PER_UNIT / mmPerUnit(centre), n(ctx, 'calm', 0.4, 0, 1))) {
      placed.push({ ink: st.ink, group: tower.id, family: st.family, points: st.points, band, kind: 'slab' });
    }
  }
  for (const s of [strandA, strandB, leadRibbonA, leadRibbonB]) for (const st of s.strokes) for (const piece of chunk(st.points, 12)) {
    placed.push({ ...st, points: piece, band: bandOf(piece[Math.floor(piece.length / 2)]), kind: 'helix' });
  }
  for (const [side, lover] of [['left', lovers.left], ['right', lovers.right]] as const) for (const st of figureStrokes(lover, env)) {
    // Each lover draws into parts of its own, so the page can tell the two apart.
    placed.push({ ...st, group: st.group === 'figure-edge' ? `${side}-edge` : side, band: bandOf(st.points[Math.floor(st.points.length / 2)]), kind: 'figure' });
  }

  const slabGeos = [...near.pieces, ...far.pieces].map(p => slabGeometry(p.sl));
  const leftGeos = figureMeshes(lovers.left), rightGeos = figureMeshes(lovers.right);
  const figureGeos = [...leftGeos, ...rightGeos];
  const geometries = [...slabGeos, strandA.mesh, strandB.mesh, leadRibbonA.mesh, leadRibbonB.mesh, ...figureGeos];
  const shadowGeos = [shadowOf(slabGeos, light), shadowOf(leftGeos, light), shadowOf(rightGeos, light)];
  try {
    fitDepthRange(view, geometries);
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    const nearP = view.near, farP = view.far;
    const biasOf = (band: number, slack: number) => {
      const lo = BAND_EDGES[band], hi = Number.isFinite(BAND_EDGES[band + 1]) ? BAND_EDGES[band + 1] : lo * 1.2;
      const d = Math.sqrt(lo * hi);
      return Math.max(3e-5, slack * nearP * farP / ((farP - nearP) * d * d));
    };
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));
    // Each lover's own clear pocket of paper: nothing of the towers or the sky comes near its lines.
    const loverPocket = roundedPocket(figureGeos, view, n(ctx, 'pocket', 3, 0.5, 8));

    // The phrase, one word to a face, from the near tower across to the far one. `wants` and `want` sit at mirrored places.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('lovers-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], band: number) => {
      let total = 0, seen = 0;
      const count2 = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H, bias: biasOf(band, SLACK.slab) }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count2(false, k => { total += k; });
      count2(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    // Which word goes on which tower, at what fraction of its height, and how far along its face (-1 left edge .. +1 right edge, in the tower's own frame).
    const wantsAcross = 0.35;
    const plan: Record<string, { tower: Tower; height: number; across: number }> = {
      it: { tower: near, height: 0.9, across: -0.4 },
      wants: { tower: near, height: 0.72, across: wantsAcross },
      what: { tower: far, height: 0.88, across: 0.3 },
      you: { tower: far, height: 0.8, across: -0.2 },
      want: { tower: far, height: 0.68, across: -wantsAcross + 0.12 },
    };
    const used = new Set<string>();
    words.forEach(word => {
      const spec = plan[word];
      if (!spec) return;
      const jitter = (wrng() - 0.5) * 0.02;
      // Courses near the wanted height, the palest first (a word shows best where the hatch is calm), then the rest by height.
      const off = (p: Piece) => Math.abs(p.centre - spec.height - jitter);
      const options = spec.tower.pieces.filter(p => p.sl.h > 0.5).sort((a, b) => (off(a) < 0.09 ? a.sl.tone : 2 + off(a)) - (off(b) < 0.09 ? b.sl.tone : 2 + off(b)));
      for (const p of options) {
        if (used.has(`${spec.tower.id}${p.course}`)) continue;
        const sl = p.sl;
        const centre = new THREE.Vector3(sl.x, sl.y, sl.z);
        const unit = 1 / mmPerUnit(centre);
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        if (ww > sl.w - 0.9 * unit * 2 || hh > sl.h - 0.4) continue;
        const x0 = -ww / 2 + spec.across * (sl.w - ww - 0.9 * unit * 2) / 2, y0 = hh / 2;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(slabMatrix(sl))));
        if (!visible(word3, bandOf(centre)) || word3.some(path => path.some(q => loverPocket(pageOf(view, q))))) continue;
        textStrokes.push(...word3);
        used.add(`${spec.tower.id}${p.course}`);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.9);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    for (let band = 0; band < BAND_EDGES.length - 1; band++) for (const kind of Object.keys(SLACK) as (keyof typeof SLACK)[]) {
      const mine = placed.filter(s => s.band === band && s.kind === kind);
      if (!mine.length) continue;
      projectStrokes(mine, { view, depth: depthBuffer, width: W, height: H, bias: biasOf(band, SLACK[kind]) }, {
        // Slivers of a tower's lines that the courses in front, or a lover's pocket, cut up are dropped.
        begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), kind === 'slab' ? p => !loverPocket(p) : undefined, kind === 'slab' ? 2 : undefined); },
      });
    }

    // The shadows: thrown back across the ground, hatched flat on the sheet. A tower's shadow is a lighter tone (one family, a
    // sparse second) and keeps clear of the lovers and of the towers; each lover's own, darker and crossed, starts at its feet.
    const spread = n(ctx, 'shadowSpread', 0.8, 0, 2);
    const towerShade = meshCoverage([shadowGeos[0]], view, TABLOID_PAGE, 0, 4);
    const leftShade = meshCoverage([shadowGeos[1]], view, TABLOID_PAGE, spread, 4), rightShade = meshCoverage([shadowGeos[2]], view, TABLOID_PAGE, spread, 4);
    const loverShade = (p: Point) => leftShade(p) || rightShade(p);
    const standing = meshCoverage(slabGeos, view, TABLOID_PAGE, 0.5, 4);
    const onLover = meshCoverage(figureGeos, view, TABLOID_PAGE, 0.7, 4);
    const tilt = THREE.MathUtils.degToRad(n(ctx, 'shadowAngle', 62, 20, 85)), step = n(ctx, 'shadowPitch', 0.55, 0.4, 2);
    // Scraps of a tower's shadow cut off by a lover's shadow, a few millimetres long, are dropped.
    const hatch = (key: string, shortest: number, families: readonly (readonly [number, number])[], keep: (p: Point) => boolean) => {
      for (const [angle, pitch] of families) {
        const cx = Math.cos(angle), cy = -Math.sin(angle), nx = -cy, ny = cx;
        const span = Math.hypot(CARD.x1 - CARD.x0, CARD.y1 - CARD.y0);
        const mid = { x: (CARD.x0 + CARD.x1) / 2, y: (CARD.y0 + CARD.y1) / 2 };
        for (let o = -span / 2; o < span / 2; o += pitch) {
          const line: Point[] = [{ x: mid.x + nx * o - cx * span, y: mid.y + ny * o - cy * span }, { x: mid.x + nx * o + cx * span, y: mid.y + ny * o + cy * span }];
          for (const inside of clipWindow(line, { x0: CARD.x0, x1: CARD.x1, y0: HORIZON_Y + 0.8, y1: CARD.y1 })) {
            for (const piece of keepAlong(inside, keep, 0.2)) buckets.add(key, piece, false, shortest);
          }
        }
      }
    };
    const cross = tilt - THREE.MathUtils.degToRad(100);
    hatch('shadow-carbon', 3.5, [[tilt, step], [cross, step * 3]], p => towerShade(p) && !loverShade(p) && !standing(p) && !loverPocket(p));
    // Each lover's own shadow in its own part; where the two overlap the left one draws it.
    hatch('shadow-left-carbon', 1.5, [[tilt, step], [cross, step * 1.5]], p => leftShade(p) && !standing(p) && !onLover(p));
    hatch('shadow-right-carbon', 1.5, [[tilt, step], [cross, step * 1.5]], p => rightShade(p) && !leftShade(p) && !standing(p) && !onLover(p));

    // The sky: a light ruling, thinning and breaking as it comes down to the horizon, knocked out round everything standing in it.
    const reach = n(ctx, 'sky', 0.9, 0, 1);
    const pitch = n(ctx, 'skyPitch', 1.5, 0.8, 5);
    const rhythm = barPattern(ctx.random('lovers-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    if (reach > 0) for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += pitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
      const limit = [0.95, 0.72, 0.5, 0.28][tier];
      if (t > limit * reach * 1.6) continue;
      const broken = t > 0.3 * limit;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p) && !loverPocket(p) && (!broken || rhythm[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'shadow', 'shadow-left', 'shadow-right', 'near', 'far', 'left', 'left-edge', 'right', 'right-edge', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !loverPocket(p), 0.3) });
    parts.push(...cardFrame('VI', 'THE LOVERS'));
    return parts;
  } finally {
    for (const geo of [...geometries, ...shadowGeos]) geo.dispose();
  }
}
