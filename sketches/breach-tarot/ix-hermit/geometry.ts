import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n, smooth } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { buildLantern, hermitFigure, hermitSkeleton, lanternFrame, lanternHand, lanternMeshes } from './hermit.ts';
import { lantern as lanternLight } from './light.ts';
import { networkRows, ruling } from './night.ts';
import { H, MM_X, MM_Y, W, buildPeak, hermitCamera, scaleOf } from './peak.ts';

/**
 * IX The Hermit: there is no signal up here. Going offline. A night of ruled lines fills the card,
 * knocked out in one circle round a lantern: a hermit has climbed a mountain of rough slabs above the
 * network he left, and sees by his own small light, the helix coiled in a lantern frame, the one colour
 * on the card. Inside the circle the paper is bright and the slabs are drawn crisply; outside it the
 * peak is only hinted, by dashed edges and a rule that turns to follow the slope. Far off along the
 * horizon the network is a thin band of tiny lit dashes. The phrase is cut into slab faces up the climb.
 */
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/** How far from the lamp the mountain keeps its outline hint (full out to this and a little past, then dashes that thin): where the first pass's light ended. */
const HINT_R = 36.8;

export function drawHermit(ctx: SketchContext): Part[] {
  const view = hermitCamera(ctx);
  const eye = view.position.clone();
  const sc = scaleOf(view);
  const peak = buildPeak(ctx, sc);
  const rng = ctx.random('hermit-night');
  const table = Array.from({ length: 64 }, () => rng());

  // The hermit stands near the front lip of the capstone, a little toward its left end.
  const figH = n(ctx, 'figure', 33, 22, 40) / sc.mmPerUnit(peak.summit);
  const cap = peak.capstone;
  const stand = peak.summit.clone().addScaledVector(peak.along, -0.12 * cap.w / 2).addScaledVector(peak.across, cap.d / 2 - 0.22 * figH);
  const skeleton = hermitSkeleton(ctx, stand, figH);
  const lantern = buildLantern(ctx, view, sc, lanternHand(skeleton));
  const figure = hermitFigure(ctx, view, skeleton, lantern.centre, stand);
  const lamp = pageOf(view, lantern.centre);
  // The lantern's light, the only light on the card: a small clear core round the flame and a pool that hangs lower, on the
  // summit stones, with an uneven edge. Hatch keeps to the lit part; the peak's outline hint runs on as before.
  const light = lanternLight(ctx, lamp, pageOf(view, peak.summit));

  // The slabs, each drawn in the raking hatch with the lantern as its light. Those far from the lamp
  // keep only their outlines.
  const slabs = peak.slabs;
  const strokes: Stroke[] = [];
  slabs.forEach((sl, owner) => {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const onPage = pageOf(view, at);
    const dist = Math.hypot(onPage.x - lamp.x, onPage.y - lamp.y);
    sl.tone = 0.08 + 1.1 * smooth(0.4 * HINT_R, 2.2 * HINT_R, dist);
    const light = lantern.centre.clone().sub(at).normalize();
    // The summit stones are plain: outlines only, a rough slab and not a moulding.
    const outline = dist > HINT_R + 16 || Math.max(sl.w, sl.h) * sc.mmPerUnit(at) < 1.5 || sl === peak.capstone || sl === peak.chunk;
    for (const st of facetStrokes(sl, light, eye, outline, FACET_MM_PER_UNIT / sc.mmPerUnit(at))) {
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
    const standing = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 0.8, 0.2, 2));
    const peakCover = meshCoverage(slabGeos, view, TABLOID_PAGE, 0);
    const pocket = meshCoverage([...figure.meshes, ...lanternGeos], view, TABLOID_PAGE, n(ctx, 'pocket', 1.3, 0.3, 3));

    // The phrase, up the climb: each word cut into the front face of a slab, from the faint foot of the
    // mountain to the summit, the last of them inside the lit circle.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
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
      const target = { x: summitPage.x - t + (wrng() - 0.5) * 6, y: summitPage.y + 0.75 * t + 8 + (wrng() - 0.5) * 6 };
      const ranked = slabs.map((sl, idx) => {
        const front = new THREE.Vector3(0, 0, sl.d / 2).applyMatrix4(slabMatrix(sl));
        const at = pageOf(view, front);
        return { sl, idx, at, score: Math.hypot(at.x - target.x, at.y - target.y) };
      }).filter(c => !used.has(c.idx) && c.at.y > CARD.y0 + 4 && c.at.y < CARD.y1 - 4 && c.at.x > CARD.x0 + 6 && c.at.x < CARD.x1 - 6)
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
    const onGlyph = glyphMask(glyphPaths, 0.7);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], keep: (p: Point, at: number) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, (p, at) => !onGlyph(p) && keep(p, at), 0.15)) buckets.add(key, piece, false, min);
    };
    const hash = (i: number) => table[((i * 5) % 64 + 64) % 64];

    // The mountain, slab by slab. Hatch stays inside the lit circle (its edge ragged); outlines run on
    // outside it as dashes that shorten and thin with distance from the lamp.
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
            if (r < HINT_R + 6) return true;
            // Dashes shorten with distance and give out altogether before they shrink to ticks; a slab
            // with a word cut into it keeps a faint outline, so the word still sits on a face.
            const frac = Math.max(1 - (r - HINT_R - 6) / (HINT_R * 2.4), used.has(owner) ? 0.45 : 0);
            return frac >= 0.3 && at % 3.6 < 3.6 * frac;
          });
        },
      });
    }

    // The hermit, in plain carbon, with the slack the figure cards use.
    const k = figH / 24;
    const figureSlack = n(ctx, 'figureSlack', 1.2, 0.1, 3) * k;
    projectStrokes(figure.strokes, { view, depth, width: W, height: H, bias: biasAt(figureSlack, eye.distanceTo(stand)) }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });

    // The lantern: frame in carbon, helix in its own inks.
    const lanternSlack = n(ctx, 'lanternSlack', 0.15, 0.03, 1);
    const lanternD = eye.distanceTo(lantern.centre);
    const frame = lanternFrame(lantern, new THREE.Vector3(0, 1, 0), eye);
    projectStrokes(frame, { view, depth, width: W, height: H, bias: biasAt(lanternSlack, lanternD) }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    projectStrokes(lantern.strokes.map(h => ({ ink: h.ink, group: 'helix', points: h.points })), { view, depth, width: W, height: H, bias: biasAt(lanternSlack, lanternD) }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), undefined, 0.15); },
    });

    // The night. Darkness is the card's gradient: black at the top, opening toward the horizon where the
    // network glows. Round the lantern it falls to nothing in a soft falloff, so the ruling thins and
    // breaks toward the light.
    const bandTop = HORIZON_Y - 1.6;
    const night = n(ctx, 'night', 1, 0.3, 1.4);
    const pitch = n(ctx, 'nightPitch', 0.65, 0.5, 1.4);
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
      dark: p => light.dark(p) * (peakDark - 0.12 + 0.28 * smooth(HINT_R, 3.2 * HINT_R, Math.hypot(p.x - lamp.x, p.y - lamp.y))),
      keep: p => peakCover(p) && !pocket(p) && !onGlyph(p),
    });
    // The network the hermit left: the plain below the horizon, ruled in rows with the lit lots cut out of them,
    // behind everything that stands.
    for (const row of networkRows(ctx, sc)) {
      let x: number = CARD.x0;
      const pieces: [number, number][] = [];
      for (const [a, b] of row.gaps) { if (a > x) pieces.push([x, a]); x = b; }
      if (x < CARD.x1) pieces.push([x, CARD.x1]);
      for (const [a, b] of pieces) add('ground-carbon', [{ x: a, y: row.y }, { x: b, y: row.y }], p => !standing(p), 0.3);
    }

    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['night', 'slope', 'ground', 'peak', 'figure', 'lantern', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !standing(p), 0.3) });
    parts.push(...cardFrame('IX', 'THE HERMIT'));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
