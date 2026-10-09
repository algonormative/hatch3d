import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { thinRanked, type RankedPiece } from '../../kit/density.ts';
import {
  FORMAT, MIN_FEATURE, MIN_SPACING, PAGE, PHRASE, TABLOID_RASTER, depthRaster, evenlyKept, halo, hatchMin, layoutLength, maskRes, printFine, scaledCount, sceneMin,
  tabloidY, tolerance,
} from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, pageExtent, slabFaceNormal, slabGeometry, slabMatrix, type Slab } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, fineEnv, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { BOX, fragments, plain, seams, type Vault } from './plain.ts';
import { trumpet, type Trumpet } from './trumpet.ts';

/**
 * XX Judgement: nothing was ever really deleted. The archive wakes. A plain of stone boxes, part
 * cemetery and part server floor, turned on the diagonal and running away to the horizon; every lid
 * is lifting at once, wide open near and only cracking far. The helix is the trumpet: it comes in
 * from near a top corner as a thin cord and flares down into a bell over the plain. The phrase is cut
 * into the undersides of the lifted lids, a word to a lid, scattered. No figures: the dead are the
 * records. The sky is lightly ruled and knocked out round the horn.
 *
 * On a smaller card (`kit/format.ts`) the world is the print's, laid out in tabloid's frame (`judgementWorld`): the same
 * plain, its lids let down where the print's are, the same horn and the same sheets rising, and the card's own camera
 * draws it. The boxes are hatched where the print's are, their hatch keeping its pitch on paper, and their outlines
 * trimmed; the sheets are thinned to the card's share of them; the horn's laminations and ribs keep their spacing on
 * paper, and its cord, too narrow there for two edges, is drawn by its lines; the sky's ruling holds its pitch, the
 * halos scale, the hidden-line test runs as finely as the print's, and the phrase goes to the bottom band.
 */
/**
 * How many times finer each way the hidden-line test runs on a small card (`printFine`): a pixel of the card's raster
 * spans several times the world a tabloid pixel does, and the boxes' walls and the horn's ribbons fray against it.
 */
const FINE = printFine();
/** The card's depth raster at tabloid; on any other page, the format's, with room for the finer one. */
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, FINE);
/** The knockout masks' pixels per millimetre: 3 on the print, as fine in the world on a smaller card (`maskRes`). */
const MASK_RES = maskRes();
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
const SLAB_SLACK = 0.2, HELIX_SLACK = 0.5;
const LIGHT = new THREE.Vector3(-0.12, 0.7, 0.68).normalize();

/** The card's camera, on the format's page. */
export function judgementCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 56, 36, 75), eye: [0, n(ctx, 'eye', 8, 3, 14), 0], target: [0, n(ctx, 'eye', 8, 3, 14), -100], near: 8, far: 1500,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one the
 * card's world is laid out with. At tabloid it is `judgementCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 56, 36, 75), eye: n(ctx, 'eye', 8, 3, 14), near: 8, far: 1500 });
}

/** Split long polylines so each piece sits in one depth band. */
function chunk(points: THREE.Vector3[], max = 20): THREE.Vector3[][] {
  if (points.length <= max + 2) return [points];
  const out: THREE.Vector3[][] = [];
  for (let i = 0; i < points.length - 1; i += max) out.push(points.slice(i, Math.min(points.length, i + max + 1)));
  return out;
}

/** A solid tube along the horn's axis: what the sky is knocked out round. */
function hornTube(horn: Trumpet): THREE.BufferGeometry {
  const frames = horn.curve.computeFrenetFrames(400, false);
  return buildSurfaceMesh((u, v) => {
    const s = u * horn.mouthU, k = Math.min(400, Math.round(s * 400));
    const a = v * Math.PI * 2, r = horn.radiusAt(s) * 0.95;
    return horn.curve.getPointAt(s).addScaledVector(frames.normals[k], Math.cos(a) * r).addScaledVector(frames.binormals[k], Math.sin(a) * r);
  }, {}, 160, 16);
}

/** Smallest gap between a point and the horn's body, in world units (negative inside). */
function gapToHorn(horn: Trumpet, p: THREE.Vector3, samples: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < samples.length; i++) best = Math.min(best, p.distanceTo(samples[i]) - horn.radiusAt(i / (samples.length - 1) * horn.mouthU) * 1.1);
  return best;
}

export interface JudgementWorld {
  horn: Trumpet;
  vaults: Vault[];
  /** The sheets rising from the open boxes, in the order they were made. */
  bits: Slab[];
  /** A solid tube along the horn: what the sky is knocked out round. */
  tube: THREE.BufferGeometry;
}

/**
 * The card's world: the horn, the plain of boxes (less any in the bell) and the sheets rising between them. It is laid
 * out in tabloid's frame, with `worldCamera` and tabloid's page, so every size and fit builds the same world, to the bit;
 * `view`, the card's own camera, only spaces the horn's lines on its paper (`trumpet`).
 */
export function judgementWorld(ctx: SketchContext, view: THREE.PerspectiveCamera): JudgementWorld {
  const world = worldCamera(ctx);
  const horn = trumpet(ctx, world, view);
  const samples = Array.from({ length: 121 }, (_, i) => horn.curve.getPointAt(i / 120 * horn.mouthU));
  // Nothing may stand in the bell: a vault whose lid would touch the horn is left out.
  const clearOfHorn = (v: Vault) => vaultPoints(v).every(p => gapToHorn(horn, p, samples) > 2);
  const vaults = plain(ctx, world, clearOfHorn);

  // Fragments rise between the plain and the bell: never in front of the horn on the sheet.
  const tube = hornTube(horn);
  const onBell = meshCoverage([tube], world, TABLOID_PAGE, 4);
  // ...and always against clear paper: a fragment that crossed a lid's outline would look pinned to it.
  const plainGeos = vaults.flatMap(v => [...v.tray, v.lid]).map(slabGeometry);
  const onPlain = meshCoverage(plainGeos, world, TABLOID_PAGE, 2.5);
  for (const g of plainGeos) g.dispose();
  const onSheet = (p: THREE.Vector3) => pageOf(world, p, TABLOID_PAGE);
  const bits = fragments(ctx, world, vaults, horn.mouth.centre, p => gapToHorn(horn, p, samples) > 3 && !onBell(onSheet(p)) && !onPlain(onSheet(p)));
  return { horn, vaults, bits, tube };
}

/** The fewest rising sheets a smaller card keeps, so the column still rises toward the bell. */
export const SHEETS_FLOOR = 10;

/**
 * The rising sheets a card draws: all of them on the print. They are a density whose pieces scale with the card, so a
 * smaller one keeps its share by length (`scaledCount(…, 'length')`, never under `SHEETS_FLOOR`) as an even spread over
 * the order they were made (a smaller card keeps a subset of a larger one's), less any smaller on its paper than the
 * smallest feature. The world itself never changes.
 */
export function shownSheets(bits: Slab[], view: THREE.Camera): Slab[] {
  const target = scaledCount(bits.length, Math.min(bits.length, SHEETS_FLOOR), 'length');
  if (target >= bits.length) return bits;
  return bits.filter((sl, i) => evenlyKept(i, target / bits.length) && pageExtent(view, sl).size >= MIN_FEATURE);
}

export function drawJudgement(ctx: SketchContext): Part[] {
  const view = judgementCamera(ctx);
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const depthOf = (p: THREE.Vector3) => Math.max(1, eye.z - p.z);
  const mmPerUnit = (p: THREE.Vector3) => f / depthOf(p);

  // The world, the same at every size; this card's camera draws it.
  const { horn, vaults, bits, tube } = judgementWorld(ctx, view);
  const slabs: { sl: Slab; group: 'tray' | 'lid' | 'fragment' }[] = [];
  for (const v of vaults) {
    for (const sl of v.tray) slabs.push({ sl, group: 'tray' });
    slabs.push({ sl: v.lid, group: 'lid' });
  }
  for (const sl of shownSheets(bits, view)) slabs.push({ sl, group: 'fragment' });

  const strokes: Stroke[] = [];
  // A box shorter than `detail` on the print is drawn in outline: on a smaller card the same boxes (`layoutLength`), since
  // their hatch keeps its pitch on paper and thins on its own as they shrink.
  const outlineBelow = layoutLength(n(ctx, 'detail', 14, 4, 40));
  const hatchSpacing = n(ctx, 'hatch', 1.6, 0.5, 3), grazing = n(ctx, 'grazing', 0.12, 0, 0.5);
  for (const { sl, group } of slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const outline = group === 'fragment' || BOXLEN * mmPerUnit(at) < outlineBelow;
    // Lids are hatched in carbon at a calmer density than the trays: no blue or violet fields on their faces. Off tabloid
    // the outline is trimmed (kit/slabs.ts): no back edges, and faces narrower than the smallest feature folded into it.
    const lid = group === 'lid';
    const raw = facetStrokes(sl, LIGHT, eye, outline, hatchSpacing * (lid ? 1.8 : 1) * FACET_MM_PER_UNIT / mmPerUnit(at), { view });
    // A face seen almost edge-on squeezes its rings into a sliver the pen cannot separate, so hatch on faces turned this
    // far from the eye (cosine of the angle to the line of sight) is dropped.
    const rot = new THREE.Matrix4().extractRotation(slabMatrix(sl));
    const minCos = lid ? grazing * 1.7 : grazing;
    for (const st of raw) {
      if (st.family === 'hatch' && !(slabFaceNormal(st.face!).applyMatrix4(rot).dot(eye.clone().sub(st.points[0]).normalize()) >= minCos)) continue;
      // Off tabloid a lid's hatch keeps its pitch on paper, so the family that crosses it on the darkest faces (violet) is two
      // or three short strokes there, which read as marks across the field, not as tone: a lid keeps the one family.
      if (lid && !FORMAT.tabloid && st.family === 'hatch' && st.ink === 'violet') continue;
      strokes.push({ ink: lid ? 'carbon' : st.ink, group, family: st.family, points: st.points });
    }
  }
  for (const h of horn.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });
  for (const points of seams(ctx)) strokes.push({ ink: 'carbon', group: 'ground', family: 'edge', points });
  // A cracking lid leaves a thin dark slit: a few close carbon lines across the opening, just above the near wall.
  for (const v of vaults) {
    if (v.open > THREE.MathUtils.degToRad(n(ctx, 'slitBelow', 28, 0, 60)) || v.hinge !== 'far') continue;
    const { w, l, wall, high, over, gap } = BOX;
    const ll = l + 2 * over, zIn = l / 2 - wall / 2;
    const top = high + gap + (zIn + ll / 2) * Math.tan(v.open) - 0.12;
    const at0 = new THREE.Vector3(v.x, high, v.z);
    const mm = mmPerUnit(at0);
    // Lines 0.6 mm apart on the paper: a slit under that is one line.
    const count = Math.min(14, Math.round((top - high) * mm / tolerance(0.6)));
    for (let k = 0; k < count; k++) {
      const y = high + 0.05 + (top - high - 0.05) * (count === 1 ? 0.5 : k / (count - 1));
      const place = (x: number) => new THREE.Vector3(x, y, zIn).applyAxisAngle(new THREE.Vector3(0, 1, 0), v.yaw).add(new THREE.Vector3(v.x, 0, v.z));
      strokes.push({ ink: 'carbon', group: 'tray', family: 'hatch', points: [place(-w / 2 + wall + 0.05), place(w / 2 - wall - 0.05)] });
    }
  }

  const solidGeos = slabs.map(({ sl }) => slabGeometry(sl));
  const geometries = [...solidGeos, ...horn.meshes];
  const fragmentGeos = slabs.filter(x => x.group === 'fragment').map(({ sl }) => slabGeometry(sl));
  try {
    fitDepthRange(view, geometries);
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The boxes and the horn are tested against a depth pass `FINE` times finer each way (`fineEnv`); at tabloid, the card's own.
    const fine = fineEnv(geometries, view, { view, depth, width: W, height: H }, { W, H, MM_X, MM_Y }, FINE);
    const nearP = view.near, farP = view.far;
    const biasAt = (d: number, slack: number) => Math.max(3e-5, slack * nearP * farP / ((farP - nearP) * d * d));
    // The halos are the print's, scaled with the card and never under half a millimetre (`halo`).
    const solids = meshCoverage([...geometries, tube], view, PAGE, halo(n(ctx, 'knockout', 1.4, 0.3, 3)), MASK_RES);
    // Paper round each fragment, so what is behind it does not show through.
    const onFragment = meshCoverage(fragmentGeos, view, PAGE, halo(0.9), MASK_RES);

    // The phrase: a word to a lid, cut into the underside as it lifts. Where the format sets it in the band, the art
    // carries no words.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('judgement-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], bias: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H, bias }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    const undersides = vaults.filter(v => v.open > THREE.MathUtils.degToRad(18)).map(v => {
      const m = slabMatrix(v.lid);
      const rot = new THREE.Matrix4().extractRotation(m);
      const normal = new THREE.Vector3(0, -1, 0).applyMatrix4(rot);
      const centre = new THREE.Vector3(0, -v.lid.h / 2 - 0.03, 0).applyMatrix4(m);
      const facing = eye.clone().sub(centre).normalize().dot(normal);
      return { v, m, rot, normal, centre, facing, at: pageOf(view, centre) };
    }).filter(c => c.facing > 0.3 && c.at.x > CARD.x0 - layoutLength(20) && c.at.x < CARD.x1 + layoutLength(20) && c.at.y > CARD.y0 + layoutLength(8) && c.at.y < CARD.y1 + layoutLength(40));
    const used = new Set<number>();
    // Where each word goes in the field's depth and across the card: some on near lids, some far, left and
    // right in turn, so the eye has to hunt for them. Their y is tabloid's page.
    const homes: { lo: number; hi: number; side: -1 | 0 | 1; y: number }[] = [
      { lo: 24, hi: 46, side: -1, y: 320 }, { lo: 55, hi: 85, side: 1, y: 262 }, { lo: 46, hi: 64, side: -1, y: 244 }, { lo: 24, hi: 46, side: 1, y: 292 }, { lo: 40, hi: 62, side: 0, y: 268 },
    ];
    const midX = (CARD.x0 + CARD.x1) / 2;
    words.forEach((word, i) => {
      const home = homes[i % homes.length];
      const ranked = undersides.filter(c => !used.has(c.v.id))
        .map(c => {
          const d = depthOf(c.centre);
          const off = d < home.lo ? home.lo - d : d > home.hi ? d - home.hi : 0;
          const wrong = home.side !== 0 && Math.sign(c.at.x - midX) !== home.side;
          return { c, k: off + (wrong ? 18 : 0) + 0.12 * Math.abs(tabloidY(c.at.y) - home.y) + 4 * wrng() };
        })
        .sort((a, b) => a.k - b.k).map(x => x.c);
      const wmm = measureStrokeText(word, style);
      for (const c of ranked) {
        const unit = 1 / mmPerUnit(c.centre);
        const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)].map(a => a.applyMatrix4(c.rot));
        const half = [c.v.lid.w / 2, c.v.lid.d / 2];
        // Reading direction: a lid axis (either way) that runs rightward on the page, with up the way the face's normal turns it.
        const frames: { r: THREE.Vector3; u: THREE.Vector3; hr: number; hu: number; score: number }[] = [];
        for (const [ai, ax] of axes.entries()) for (const sg of [1, -1]) {
          const r = ax.clone().multiplyScalar(sg);
          const u = new THREE.Vector3().crossVectors(c.normal, r).normalize();
          const pr = pageOf(view, c.centre.clone().add(r)), pc = pageOf(view, c.centre), pu = pageOf(view, c.centre.clone().add(u));
          const dr = { x: pr.x - pc.x, y: pr.y - pc.y }, du = { x: pu.x - pc.x, y: pu.y - pc.y };
          const score = Math.min(dr.x / (Math.hypot(dr.x, dr.y) || 1), -du.y / (Math.hypot(du.x, du.y) || 1));
          frames.push({ r, u, hr: half[ai], hu: half[1 - ai], score });
        }
        const fr = frames.sort((a, b) => b.score - a.score)[0];
        if (fr.score < 0.35) continue;
        const ww = wmm * unit, hh = style.height * unit;
        if (ww > fr.hr * 2 - 1.2 || hh > fr.hu * 2 - 1.0) continue;
        const origin = c.centre.clone().addScaledVector(c.normal, 0.03);
        let placed: THREE.Vector3[][] | null = null;
        for (let attempt = 0; attempt < 8 && !placed; attempt++) {
          const dx = (wrng() - 0.5) * (fr.hr * 2 - ww - 1.2), dy = (wrng() - 0.5) * (fr.hu * 2 - hh - 1.0);
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => origin.clone()
            .addScaledVector(fr.r, dx - ww / 2 + q.x * unit).addScaledVector(fr.u, dy + hh / 2 - q.y * unit)));
          const m5 = layoutLength(5);
          const inCard = word3.every(path => path.every(q => { const g = pageOf(view, q); return g.x > CARD.x0 + m5 && g.x < CARD.x1 - m5 && g.y > CARD.y0 + m5 && g.y < CARD.y1 - m5; }));
          if (inCard && visible(word3, biasAt(depthOf(c.centre), SLAB_SLACK))) placed = word3;
        }
        if (!placed) continue;
        const word3 = placed;
        textStrokes.push(...word3);
        used.add(c.v.id);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.6));
    // Paths are reduced at the card's scale (`reduceAtScale`): at tabloid's stride the horn's rings turn into polygons on a
    // small card.
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    const kept = (run: Point[], extra: (p: Point) => boolean = () => true) => clipWindow(run).flatMap(inside => keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15));
    const add = (key: string, run: Point[], extra?: (p: Point) => boolean, min?: number) => {
      for (const piece of kept(run, extra)) buckets.add(key, piece, false, min);
    };
    // Short fragments of the helix's lines, where ribbons overlap and hide each other, read as stray ticks: dropped. The
    // shortest kept is the print's, scaled with the card (`sceneMin`). A scrap of a box's hatch shorter than the smallest
    // feature is a speck, and dropped off tabloid (`hatchMin`).
    const helixMin = sceneMin(n(ctx, 'helixFragment', 5, 0.4, 12));
    // Each stroke is tested at its own depth: strokes are split into pieces and banded by distance.
    const bands = new Map<string, { list: Stroke[]; d: number; slack: number; band: number }>();
    for (const st of strokes) for (const piece of (st.group === 'helix' ? chunk(st.points) : [st.points])) {
      const mid = piece[Math.floor(piece.length / 2)];
      const d = depthOf(mid), band = Math.round(Math.log(d) / Math.log(1.12));
      const key = `${st.group}|${band}`;
      if (!bands.has(key)) bands.set(key, { list: [], d: Math.exp(band * Math.log(1.12)), slack: st.group === 'helix' ? HELIX_SLACK : SLAB_SLACK, band });
      bands.get(key)!.list.push({ ...st, points: piece });
    }
    // Off tabloid the plain's lines are thinned on the card's paper before they go in (`thinRanked`): the far rows close up
    // there, and a line running beside a nearer one closer than the pens hold apart is left out where it does; a box's
    // outline before its hatch, the boxes before the seams in the paving. The print keeps all it has.
    const pending: (RankedPiece & { key: string; min?: number })[] = [];
    const thinned = (group: string) => !FORMAT.tabloid && (group === 'tray' || group === 'lid' || group === 'ground');
    for (const { list, d, slack, band } of bands.values()) {
      projectStrokes(list, { ...fine.env, bias: biasAt(d, slack) }, {
        begin: st => runs => {
          const key = `${st.group}-${st.ink}`, min = st.group === 'helix' ? helixMin : hatchMin(st.family);
          const extra = st.group === 'fragment' ? undefined : (p: Point) => !onFragment(p);
          const rank = st.group === 'ground' ? 1e4 + band : 2 * band + (st.family === 'hatch' ? 1 : 0);
          for (const run of runs) {
            const page = scalePoints(run, fine.mmX, fine.mmY);
            if (thinned(st.group)) for (const piece of kept(page, extra)) pending.push({ piece, rank, key, min });
            else add(key, page, extra, min);
          }
        },
      });
    }
    for (const { item, runs } of thinRanked(pending, MIN_SPACING)) for (const piece of runs) buckets.add(item.key, piece, false, item.min);

    // The sky: lightly ruled, closest at the top and opening to the horizon, knocked out round all that stands in it. Its
    // pitch, its first line's gap below the band and its dashes hold on paper; it stops short of the horizon by the print's gap, scaled.
    const pattern = barPattern(ctx.random('judgement-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - layoutLength(1), pitch = tolerance(n(ctx, 'skyPitch', 2.4, 0.8, 6));
    for (let y = skyTop + tolerance(0.3), i = 0; y < skyBottom; i++) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const broken = t > 0.45;
      const row = i;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => !solids(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + row) % 64]));
      y += pitch * (1 + 2.6 * t * t);
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'ground', 'tray', 'lid', 'fragment', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('XX', 'JUDGEMENT', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of [...geometries, ...fragmentGeos, tube]) geo.dispose();
  }
}

const BOXLEN = 7.8;

/** The corners of every slab of a vault. */
function vaultPoints(v: Vault): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const s of [...v.tray, v.lid]) {
    const m = slabMatrix(s);
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) out.push(new THREE.Vector3(a * s.w / 2, b * s.h / 2, c * s.d / 2).applyMatrix4(m));
  }
  return out;
}
