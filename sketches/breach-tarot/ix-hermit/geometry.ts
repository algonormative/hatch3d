import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_SPACING, PAGE, PHRASE, S, halo, hatchMin, layoutLength, tolerance } from '../../kit/format.ts';
import { thinParallel } from '../../kit/density.ts';
import { facetStrokes, slabGeometry, slabMatrix } from '../../kit/slabs.ts';
import { narrowStrands } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { n, smooth } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, fineDepth, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import type { Skeleton } from '../../kit/mannequin/skeleton.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { buildLantern, hermitFigure, hermitSkeleton, lanternFrame, lanternHand, lanternMeshes } from './hermit.ts';
import { lantern as lanternLight } from './light.ts';
import { networkLights, networkRows, ruling, type Lit } from './night.ts';
import { H, MM_X, MM_Y, W, buildPeak, hermitCamera, scaleOf, worldScale, type Peak, type Scale } from './peak.ts';

/**
 * IX The Hermit: there is no signal up here. Going offline. A night of ruled lines fills the card,
 * knocked out in one circle round a lantern: a hermit has climbed a mountain of rough slabs above the
 * network he left, and sees by his own small light, the helix coiled in a lantern frame, the one colour
 * on the card. Inside the circle the paper is bright and the slabs are drawn crisply; outside it the
 * peak is only hinted, by dashed edges and a rule that turns to follow the slope. Far off along the
 * horizon the network is a thin band of tiny lit dashes. The phrase is cut into slab faces up the climb.
 *
 * On a small card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`hermitWorld`), and the
 * card's own camera draws it: the light's pool, the peak's hint and the halos scale with the card; the night's ruling,
 * the plain's rows and the hatch keep their pitch on paper; the city's lit points keep their size and thin to the
 * print's density; small slabs are trimmed to their outlines, the helix's narrow strands drawn as lines; and the phrase
 * moves to the bottom band.
 */
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/**
 * How far from the lamp the mountain keeps its outline hint (full out to this and a little past, then dashes that thin): where
 * the first pass's light ended. Layout, in tabloid millimetres (`layoutLength`).
 */
const HINT_R = 36.8;
/** How many times finer each way the hermit's and the lantern's depth test is on a small card (`fineDepth`). */
const FIGURE_OVERSAMPLE = 4;
/**
 * The order a small card thins the summit's marks in (`thinParallel`): what ranks first keeps its line where two run
 * closer than the pens hold apart. The hermit's outline, then the lantern's frame, the hood's opening, the cloak's
 * folds, the rings and the hood's hollow, then the slabs' edges and last their hatch.
 */
const RANK = { outline: 0, lantern: 1, rim: 2, fold: 3, ring: 4, hollow: 5, slabEdge: 6, slabHatch: 7 } as const;

export interface HermitWorld {
  /** The world's scale: `worldCamera` on tabloid's page. */
  sc: Scale;
  peak: Peak;
  /** The hermit's height, world units, and where he stands on the capstone. */
  figH: number;
  stand: THREE.Vector3;
  skeleton: Skeleton;
  /** The city's lit points, on tabloid's page. */
  lights: Lit[];
}

/**
 * The card's world: the mountain, where the hermit stands and how he holds himself, and the city's lit points. It is laid
 * out in tabloid's frame (`worldScale`, tabloid's page millimetres), so every size and fit builds the print's world, to
 * the bit; each card's own camera then draws it.
 */
export function hermitWorld(ctx: SketchContext): HermitWorld {
  const sc = worldScale(ctx);
  const peak = buildPeak(ctx, sc);
  // The hermit stands near the front lip of the capstone, a little toward its left end.
  const figH = n(ctx, 'figure', 33, 22, 40) / sc.mmPerUnit(peak.summit);
  const cap = peak.capstone;
  const stand = peak.summit.clone().addScaledVector(peak.along, -0.12 * cap.w / 2).addScaledVector(peak.across, cap.d / 2 - 0.22 * figH);
  return { sc, peak, figH, stand, skeleton: hermitSkeleton(ctx, stand, figH), lights: networkLights(ctx, sc) };
}

export function drawHermit(ctx: SketchContext): Part[] {
  const view = hermitCamera(ctx);
  const eye = view.position.clone();
  // This card's paper; the world's own scale is `world.sc`.
  const sc = scaleOf(view);
  const world = hermitWorld(ctx);
  const { peak, figH, stand, skeleton } = world;
  const rng = ctx.random('hermit-night');
  const table = Array.from({ length: 64 }, () => rng());
  const hint = layoutLength(HINT_R);
  const lantern = buildLantern(ctx, view, world.sc, lanternHand(skeleton));
  const figure = hermitFigure(ctx, view, skeleton, lantern.centre, stand);
  const lamp = pageOf(view, lantern.centre);
  // The lantern's light, the only light on the card: a small clear core round the flame and a pool that hangs lower, on the
  // summit stones, with an uneven edge. Hatch keeps to the lit part; the peak's outline hint runs on as before.
  const light = lanternLight(ctx, lamp, pageOf(view, peak.summit));

  // The slabs, each drawn in the raking hatch with the lantern as its light. Those far from the lamp
  // keep only their outlines, as do those under 1.5 mm on this card's paper. Off tabloid every outline is trimmed
  // (kit/slabs.ts): no back edges, and faces narrower than the smallest feature folded into it.
  const slabs = peak.slabs;
  const strokes: Stroke[] = [];
  slabs.forEach((sl, owner) => {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const onPage = pageOf(view, at);
    const dist = Math.hypot(onPage.x - lamp.x, onPage.y - lamp.y);
    sl.tone = 0.08 + 1.1 * smooth(0.4 * hint, 2.2 * hint, dist);
    const light = lantern.centre.clone().sub(at).normalize();
    // The summit stones are plain: outlines only, a rough slab and not a moulding.
    const outline = dist > hint + layoutLength(16) || Math.max(sl.w, sl.h) * sc.mmPerUnit(at) < 1.5 || sl === peak.capstone || sl === peak.chunk;
    for (const st of facetStrokes(sl, light, eye, outline, FACET_MM_PER_UNIT / sc.mmPerUnit(at), { view })) {
      strokes.push({ ink: 'carbon', group: 'peak', family: st.family, points: st.points, owner });
    }
  });
  const slabGeos = slabs.map(slabGeometry);
  const lanternGeos = lanternMeshes(lantern);
  const geometries = [...slabGeos, ...figure.meshes, ...lanternGeos];
  try {
    fitDepthRange(view, geometries);
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);

    // Page masks: everything that stands, the mountain alone, and a pocket of clear paper round the hermit and his lantern.
    // They are drawn at the print's resolution in the world (3 pixels per tabloid millimetre, `3 / S` here), so a small
    // card's staff, a tenth of a millimetre across, still clears its pocket.
    const res = 3 / S;
    const standing = meshCoverage(geometries, view, PAGE, halo(n(ctx, 'knockout', 0.8, 0.2, 2)), res);
    const peakCover = meshCoverage(slabGeos, view, PAGE, 0, res);
    const pocket = meshCoverage([...figure.meshes, ...lanternGeos], view, PAGE, halo(n(ctx, 'pocket', 1.3, 0.3, 3)), res);

    // The phrase, up the climb: each word cut into the front face of a slab, from the faint foot of the
    // mountain to the summit, the last of them inside the lit circle; or, where the format sets it in the band,
    // under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size };
    const wrng = ctx.random('hermit-words');
    const summitPage = pageOf(view, peak.summit);
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const run of runs) addTo(run.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.98;
    };
    const used = new Set<number>();
    const climb = [130, 95, 62, 36, 14, 0];
    words.forEach((word, i) => {
      const t = climb[Math.min(climb.length - 1, climb.length - words.length + i)] ?? 0;
      const target = { x: summitPage.x - layoutLength(t) + layoutLength((wrng() - 0.5) * 6), y: summitPage.y + layoutLength(0.75 * t) + layoutLength(8) + layoutLength((wrng() - 0.5) * 6) };
      const ranked = slabs.map((sl, idx) => {
        const front = new THREE.Vector3(0, 0, sl.d / 2).applyMatrix4(slabMatrix(sl));
        const at = pageOf(view, front);
        return { sl, idx, at, score: Math.hypot(at.x - target.x, at.y - target.y) };
      }).filter(c => !used.has(c.idx) && c.at.y > CARD.y0 + layoutLength(4) && c.at.y < CARD.y1 - layoutLength(4) && c.at.x > CARD.x0 + layoutLength(6) && c.at.x < CARD.x1 - layoutLength(6))
        .sort((a, b) => a.score - b.score).slice(0, 40);
      for (const { sl, idx } of ranked) {
        const m = slabMatrix(sl);
        const unit = 1 / sc.mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        if (ww > sl.w - 0.8 || hh > sl.h - 0.4) continue;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 0.8), y0 = hh / 2;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3)) continue;
        textStrokes.push(...word3);
        used.add(idx);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.7));

    // Every ordinary path goes through the reducer at the card's scale (`reduceAtScale`: the print's reducer at tabloid),
    // so a small card's hermit and lantern keep their curves.
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    // On a small card the summit's marks (the hermit, the lantern's frame, the slabs) wait for `thinParallel`, ranked
    // (`RANK`): where one runs beside a mark that ranks above it, closer than the pens hold apart, that stretch of it is
    // left out. At tabloid every mark goes straight to its part.
    const pending: { key: string; piece: Point[]; min?: number; rank: number }[] | undefined = FORMAT.tabloid ? undefined : [];
    const add = (key: string, run: Point[], keep: (p: Point, at: number) => boolean = () => true, min?: number, rank?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, (p, at) => !onGlyph(p) && keep(p, at), 0.15)) {
        if (pending && rank !== undefined) pending.push({ key, piece, min, rank });
        else buckets.add(key, piece, false, min);
      }
    };
    const hash = (i: number) => table[((i * 5) % 64 + 64) % 64];

    // The mountain, slab by slab. Hatch stays inside the lit circle (its edge ragged); outlines run on
    // outside it as dashes that shorten and thin with distance from the lamp (the dashes' period is on paper, their
    // reach scales with the card). Off tabloid a scrap of a face's hatch shorter than the smallest feature is a speck,
    // and dropped (`hatchMin`).
    const bySlab = new Map<number, { st: Stroke; id: number }[]>();
    strokes.forEach((st, id) => bySlab.set(st.owner!, [...(bySlab.get(st.owner!) ?? []), { st, id }]));
    const slack = n(ctx, 'slabSlack', 0.6, 0.1, 2);
    for (const [owner, mine] of bySlab) {
      const sl = slabs[owner];
      const ids = mine.map(m => m.id);
      projectStrokes(mine.map(m => m.st), { view, depth, width: W, height: H, bias: biasAt(slack, eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z))) }, {
        begin: (st, index) => runs => {
          const id = ids[index];
          for (const run of runs) add('peak-carbon', scalePoints(run, MM_X, MM_Y), (p, at) => {
            if (pocket(p)) return false;
            const r = Math.hypot(p.x - lamp.x, p.y - lamp.y);
            if (st.family === 'hatch') return light.dark(p) < 0.5 + 0.35 * hash(id);
            if (r < hint + layoutLength(6)) return true;
            // Dashes shorten with distance and give out altogether before they shrink to ticks; a slab
            // with a word cut into it keeps a faint outline, so the word still sits on a face.
            const frac = Math.max(1 - (r - hint - layoutLength(6)) / (hint * 2.4), used.has(owner) ? 0.45 : 0);
            return frac >= 0.3 && at % 3.6 < 3.6 * frac;
          }, hatchMin(st.family), st.family === 'hatch' ? RANK.slabHatch : RANK.slabEdge);
        },
      });
    }

    // The hermit and his lantern are a few millimetres tall on a small card: there they are hidden-line tested against a
    // depth pass `FIGURE_OVERSAMPLE` times finer each way (`fineDepth`), so their edges hold; at tabloid, the card's own.
    const fine = FORMAT.tabloid ? { env: { view, depth, width: W, height: H }, mmX: MM_X, mmY: MM_Y }
      : fineDepth(geometries, view, { W, H, MM_X, MM_Y }, FIGURE_OVERSAMPLE);
    // The hermit, in plain carbon, with the slack the figure cards use. Off tabloid a scrap of his rings or of the hood's
    // hollow shorter than the smallest feature is a speck, and dropped.
    const k = figH / 24;
    const figureSlack = n(ctx, 'figureSlack', 1.2, 0.1, 3) * k;
    projectStrokes(figure.strokes, { ...fine.env, bias: biasAt(figureSlack, eye.distanceTo(stand)) }, {
      begin: (st, i) => runs => {
        const role = figure.roles[i], min = role === 'ring' || role === 'hollow' ? hatchMin(st.family) : undefined;
        for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, fine.mmX, fine.mmY), undefined, min, RANK[role]);
      },
    });

    // The lantern: frame in carbon, helix in its own inks.
    const lanternSlack = n(ctx, 'lanternSlack', 0.15, 0.03, 1);
    const lanternD = eye.distanceTo(lantern.centre);
    const frame = lanternFrame(lantern, new THREE.Vector3(0, 1, 0), eye, view);
    projectStrokes(frame, { ...fine.env, bias: biasAt(lanternSlack, lanternD) }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, fine.mmX, fine.mmY), undefined, undefined, RANK.lantern); },
    });
    // A strand narrower on this card's paper than the smallest feature is drawn as its line (`narrowStrands`; none at tabloid).
    projectStrokes(narrowStrands(lantern.strokes, view).map(h => ({ ink: h.ink, group: 'helix', points: h.points })), { ...fine.env, bias: biasAt(lanternSlack, lanternD) }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, fine.mmX, fine.mmY), undefined, 0.15); },
    });
    if (pending?.length) {
      const order = pending.map((_, i) => i).sort((a, b) => pending[a].rank - pending[b].rank || a - b);
      const thinned = thinParallel(order.map(i => pending[i].piece), MIN_SPACING);
      const kept: Point[][][] = [];
      order.forEach((i, j) => { kept[i] = thinned[j]; });
      pending.forEach(({ key, min }, i) => { for (const piece of kept[i]) buckets.add(key, piece, false, min); });
    }

    // The night. Darkness is the card's gradient: black at the top, opening toward the horizon where the
    // network glows. Round the lantern it falls to nothing in a soft falloff, so the ruling thins and
    // breaks toward the light. The ruling is a tone: its pitch, and its breaks, hold on paper.
    const bandTop = HORIZON_Y - tolerance(layoutLength(1.6));
    const night = n(ctx, 'night', 1, 0.3, 1.4);
    const pitch = tolerance(n(ctx, 'nightPitch', 0.65, 0.5, 1.4));
    ruling({
      angle: 0, pitch, table, emit: path => buckets.add('night-carbon', path),
      dark: p => night * (1 - 0.92 * smooth(0.3, 1, (p.y - CARD.y0) / (HORIZON_Y - CARD.y0))) * light.dark(p),
      keep: p => p.y < bandTop && !standing(p) && !pocket(p) && !onGlyph(p),
    });
    // On the mountain the ruling turns to follow the slope, lighter near the lantern and darker toward the foot.
    const slope = THREE.MathUtils.degToRad(n(ctx, 'slope', -38, -80, -5));
    const peakDark = n(ctx, 'peakRule', 0.42, 0.2, 1);
    ruling({
      angle: slope, pitch, table, emit: path => buckets.add('slope-carbon', path),
      dark: p => light.dark(p) * (peakDark - 0.12 + 0.28 * smooth(hint, 3.2 * hint, Math.hypot(p.x - lamp.x, p.y - lamp.y))),
      keep: p => peakCover(p) && !pocket(p) && !onGlyph(p),
    });
    // The network the hermit left: the plain below the horizon, ruled in rows with the lit lots cut out of them,
    // behind everything that stands.
    for (const row of networkRows(ctx, world.lights)) {
      let x: number = CARD.x0;
      const pieces: [number, number][] = [];
      for (const [a, b] of row.gaps) { if (a > x) pieces.push([x, a]); x = b; }
      if (x < CARD.x1) pieces.push([x, CARD.x1]);
      for (const [a, b] of pieces) add('ground-carbon', [{ x: a, y: row.y }, { x: b, y: row.y }], p => !standing(p), 0.3);
    }

    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['night', 'slope', 'ground', 'peak', 'figure', 'lantern', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !standing(p), 0.3) });
    parts.push(...cardFrame('IX', 'THE HERMIT', { phrase: settings }));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
