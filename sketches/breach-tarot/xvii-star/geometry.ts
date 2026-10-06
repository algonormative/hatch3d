import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, slabGeometry, slabMatrix, solid, strandPoint, strandStrokes, type Ink, type Slab, type Strand,
} from '../../breach-cathedral-tower/geometry.ts';
import { clearBands, planSlogans, sloganSettings, type SloganSurface } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { n } from '../../kit/params.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { atPage, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import { facetStrokes } from '../xvi-tower/geometry.ts';

/**
 * XVII The Star: the Tower's debris, reread as a constellation. A night of dense engraved hatch
 * fills the sky; every fallen fragment is a star, a paper shape with a halo cut out of the night,
 * joined to its neighbours by faint dashed lines. At the centre eight cantilevered slabs radiate as
 * the eight-pointed star, and two helix streams pour from it into still water. The water is the
 * card's flat mark: a band of broken ripple hatch in which everything above is reflected, row by row.
 */
type Family = 'edge' | 'hatch' | 'membrane' | 'text';
type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };

const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.4;

export function starCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 40, 80), eye: [0, EYE, 0], target: [0, EYE, -100], far: 600,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

export interface Sky { star: Slab[]; debris: Slab[]; words: Slab[]; centre: THREE.Vector3 }

export function sky(ctx: SketchContext, view: THREE.PerspectiveCamera): Sky {
  const rng = ctx.random('star-sky');
  const window = HORIZON_Y - CARD.y0;
  const centre = atPage(view, { x: TABLOID_PAGE.width / 2 + (rng() - 0.5) * 30, y: CARD.y0 + 0.36 * window }, 70);
  // The star: eight slabs radiating in the picture plane, long and short in turn, each a little tipped.
  const star: Slab[] = [];
  const size = 0.45 + 0.4 * n(ctx, 'starSize', 0.5, 0, 1);
  const spin = rng() * Math.PI / 8;
  for (let k = 0; k < 8; k++) {
    const a = spin + k * Math.PI / 4;
    const long = k % 2 === 0;
    const L = (long ? 13 : 7.5) * size, r0 = 1.6 * size;
    const s = solid(centre.x + Math.cos(a) * (r0 + L / 2), centre.y + Math.sin(a) * (r0 + L / 2), centre.z + (rng() - 0.5) * 0.8,
      L, (long ? 1.1 : 0.85) * size, 1.4 * size, k, 'stack');
    s.rz = a; s.rx = (rng() - 0.5) * 0.25; s.ry = (rng() - 0.5) * 0.25;
    s.tone = 0.35;
    star.push(s);
  }
  // A small cube at the hub.
  const hub = solid(centre.x, centre.y, centre.z, 2.2 * size, 2.2 * size, 2.2 * size, 8, 'stack');
  hub.rz = Math.PI / 4 + spin; hub.tone = 0.5;
  star.push(hub);
  // Word fragments: larger, near-upright pieces down both sides, for the phrase.
  const words: Slab[] = [];
  const wordPages: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1;
    const p = { x: TABLOID_PAGE.width / 2 + side * (58 + 22 * rng()), y: CARD.y0 + 18 + (i + 0.5) / 6 * (window - 40) };
    const w = atPage(view, p, 55);
    const s = solid(w.x, w.y, w.z, 5.2 + 1.6 * rng(), 1.15, 1.2, 40 + i, 'stack');
    s.rz = (rng() - 0.5) * 0.18; s.ry = (rng() - 0.5) * 0.5; s.rx = (rng() - 0.5) * 0.2;
    s.tone = 0.4;
    words.push(s);
    wordPages.push(p);
  }
  // Debris: the Tower's fragments, small and tumbling, scattered over the sky as stars.
  const count = Math.round(20 + 50 * n(ctx, 'constellation', 0.5, 0, 1));
  const debris: Slab[] = [];
  const starPage = { x: TABLOID_PAGE.width / 2, y: CARD.y0 + 0.36 * window };
  for (let i = 0; i < count; i++) {
    let p: Point;
    let tries = 0;
    do {
      p = { x: CARD.x0 + 6 + rng() * (CARD.x1 - CARD.x0 - 12), y: CARD.y0 + 6 + rng() * (window - 22) };
    } while ((Math.hypot(p.x - starPage.x, p.y - starPage.y) < 95 * size
      // Never in front of a word.
      || wordPages.some(q => Math.abs(p.x - q.x) < 34 && Math.abs(p.y - q.y) < 12)) && ++tries < 40);
    const w = atPage(view, p, 50 + 40 * rng());
    const big = rng() ** 2;
    const s = solid(w.x, w.y, w.z, 0.5 + 2.4 * big, 0.25 + 0.6 * big, 0.4 + 0.9 * big, 20 + i, 'debris');
    s.rx = (rng() - 0.5) * 2.4; s.ry = (rng() - 0.5) * 2.4; s.rz = (rng() - 0.5) * Math.PI;
    s.tone = 0.5;
    debris.push(s);
  }
  return { star, debris, words, centre };
}

/** Two helix streams pour from below the star down into the water. */
function streams(ctx: SketchContext, centre: THREE.Vector3): Strand[] {
  const spread = 2.2 + 2 * n(ctx, 'streams', 0.5, 0, 1);
  return helixStrands({ ...ctx, params: { helixTurns: 3.2, shellTwist: 0.3, ...ctx.params } }).map(s => ({
    ...s, x: centre.x + (s.id === 'a' ? -spread : spread), y: 0, z: centre.z + 2,
    y0: 0, y1: centre.y - 3, radius: 0.75, depth: 1, width: 0.55, swell: 0, centre: 0,
  }));
}

/** Night: engraved hatch over the sky, knocked out round everything that shines. */
function night(ctx: SketchContext, covered: (p: Point) => boolean): Point[][][] {
  const pitch = 1.25 - 0.45 * n(ctx, 'night', 0.5, 0, 1);
  const out: Point[][][] = [[], []];
  const families: [number, number, number][] = [[0.07, pitch, 0], [-1.05, pitch * 1.7, 1]];
  for (const [angle, step, which] of families) {
    const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    const span = Math.hypot(CARD.x1 - CARD.x0, HORIZON_Y - CARD.y0);
    const cx = (CARD.x0 + CARD.x1) / 2, cy = (CARD.y0 + HORIZON_Y) / 2;
    let index = 0;
    for (let o = -span; o < span; o += step, index++) {
      // The second family deepens the night toward the top; its lines end at staggered heights.
      const reach = CARD.y0 + (HORIZON_Y - CARD.y0) * (0.25 + 0.5 * ((index * 0.6180339887) % 1));
      const line = [{ x: cx + nx * o - dx * span, y: cy + ny * o - dy * span }, { x: cx + nx * o + dx * span, y: cy + ny * o + dy * span }];
      for (const piece of clipWindow(line, { ...CARD, y1: HORIZON_Y - 1.5 })) {
        // The second family deepens the night toward the top of the sky only.
        out[which].push(...keepAlong(piece, p => !covered(p) && (which === 0 || p.y < reach), 0.25));
      }
    }
  }
  return out;
}

/**
 * The glitter path: a column of light on dark water under the star, like a low sun's. Each water row
 * is a straight dark line broken only where the path crosses it; the path widens toward the viewer,
 * its edge ragged row by row, and short sparkle dashes float inside it, thinning toward its edges.
 */
export function glitter(ctx: SketchContext, cx: number, streamsX: number[]): { rows: Point[][]; sparkle: Point[][]; refraction: Point[][] } {
  const rng = ctx.random('star-glitter');
  const width = 0.6 + 0.8 * n(ctx, 'glitter', 0.5, 0, 1);
  const rows: Point[][] = [], sparkle: Point[][] = [], refraction: Point[][] = [];
  const depthOf = (y: number) => (y - HORIZON_Y) / (CARD.y1 - HORIZON_Y);
  let k = 0;
  for (let y = HORIZON_Y + 1.1; y < CARD.y1 - 0.6; y += 0.85 + 2.2 * depthOf(y) ** 1.5, k++) {
    const d = depthOf(y);
    // The path's centre drifts a little, as a reflection does on moving water.
    const c = cx + 2.4 * Math.sin(k * 0.37) * (0.3 + d);
    const half = width * (4 + 38 * d ** 0.9) * (0.65 + 0.55 * rng());
    const left: Point[] = [{ x: CARD.x0, y }, { x: Math.max(CARD.x0, c - half), y }];
    const right: Point[] = [{ x: Math.min(CARD.x1, c + half), y }, { x: CARD.x1, y }];
    for (const r of [left, right]) if (r[1].x - r[0].x > 0.5) rows.push(r);
    // Sparkle inside the path: short dashes, more near its spine, every row but sparser low down.
    const count = Math.round((2 + 5 * d) * width);
    for (let j = 0; j < count; j++) {
      const u = (rng() * 2 - 1) * (rng() ** 0.6);
      const len = 0.8 + (1.2 + 6 * d) * rng() * (1 - 0.6 * Math.abs(u));
      const x = c + u * (half - len / 2);
      if (Math.abs(u) > 0.15 || rng() < 0.6) sparkle.push([{ x: x - len / 2, y }, { x: x + len / 2, y }]);
    }
  }
  // The streams continue below the surface, refracted: slow wavering lines that fade with depth.
  for (const sx of streamsX) {
    const pts: Point[] = [];
    for (let y = HORIZON_Y + 1.5; y < HORIZON_Y + (CARD.y1 - HORIZON_Y) * 0.55; y += 0.5) {
      const d = depthOf(y);
      pts.push({ x: sx + (sx - cx) * 0.6 * d + 2.2 * Math.sin(y * 0.28) * (0.3 + 1.6 * d), y });
    }
    refraction.push(...keepAlong(pts, (p, at) => at % (2 + 9 * depthOf(p.y)) < 2 - 0.8 * depthOf(p.y), 0.2));
  }
  return { rows, sparkle, refraction };
}

export function drawStar(ctx: SketchContext): Part[] {
  const view = starCamera(ctx);
  const { star, debris, words, centre } = sky(ctx, view);
  const strands = streams(ctx, centre);
  const solids = [...star, ...debris, ...words];
  const light = new THREE.Vector3(0.2, 0.3, 1).normalize();
  const strokes: Stroke[] = solids.flatMap((s, owner) => facetStrokes(s, light, view.position, s.role === 'debris')
    .map(st => ({ ...st, group: owner < star.length ? 'star' : 'pieces', owner })));
  const density = 0.55;
  for (const s of strands) for (const st of strandStrokes(s, density, 0.32, ctx, view)) strokes.push({ ink: st.ink, group: 'helix', family: 'membrane', points: st.points });
  // The reflection: every sky stroke mirrored in the water plane.
  const geometries = solids.map(slabGeometry);
  const helixMeshes = strands.map(s => buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  geometries.push(...helixMeshes);
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const surfaces: SloganSurface[] = words.map((s, i) => ({ id: star.length + debris.length + i, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d }));
    const env = { view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: HORIZON_Y / MM_Y } };
    let slogans = planSlogans(ctx, surfaces, env);
    for (let k = 1; k < 8 && slogans.placed.length === 0 && sloganSettings(ctx).count > 0; k++) slogans = planSlogans(ctx, surfaces, env, `slogan-${k}`);
    const lettered = new Set(slogans.knockouts.keys());
    const sky = strokes.filter(st => !(st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon'));
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) sky.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) sky.push({ ink: 'lettering', group: 'title', family: 'text', points });
    const all = sky;
    const buckets = new PartBuckets(0.4);
    const add = (key: string, path: Point[], text: boolean) => buckets.add(key, path, text);
    const removeHidden = ctx.params.occlusion !== false;
    projectStrokes(all, { view, depth, width: W, height: H }, {
      hidden: stroke => removeHidden && stroke.family !== 'text',
      pieces: (c, stroke) => {
        const bands = stroke.owner === undefined || stroke.group === 'water' ? undefined : slogans.knockouts.get(stroke.owner);
        return bands ? clearBands(c, bands, MM_Y) : [c];
      },
      begin: stroke => {
        const text = stroke.family === 'text';
        const key = `${stroke.group}-${stroke.ink}`;
        return runs => {
          for (const run of runs) {
            for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y), { ...CARD, y1: HORIZON_Y - 0.5 })) add(key, inside, text);
          }
        };
      },
    });
    // The night, knocked out with a paper halo round every shining thing and every word.
    const halo = 1.6 + 1.6 * n(ctx, 'halo', 0.5, 0, 1);
    const shine = meshCoverage(geometries, view, TABLOID_PAGE, halo);
    const bands = [...slogans.knockouts.values()].flat().map(q => q.map(c => ({ x: c.x * MM_X, y: c.y * MM_Y })));
    const inBand = (p: Point) => bands.some(q => {
      let inside = false;
      for (let a = 0, b = q.length - 1; a < q.length; b = a++) {
        if ((q[a].y > p.y) !== (q[b].y > p.y) && p.x < (q[b].x - q[a].x) * (p.y - q[a].y) / (q[b].y - q[a].y) + q[a].x) inside = !inside;
      }
      return inside;
    });
    const [nightA, nightB] = night(ctx, p => shine(p) || inBand(p));
    for (const p of nightA) add('night-carbon', p, false);
    for (const p of nightB) add('night-ultramarine', p, false);
    // The constellation: faint dashed lines from each fragment to its nearest neighbour, stopping at the halos.
    const slabPage = (s: Slab) => pageOf(view, new THREE.Vector3(s.x, s.y, s.z));
    const nodes = [...debris, ...words].map(slabPage).filter(p => p.y < HORIZON_Y - 4);
    const drawnPairs = new Set<string>();
    nodes.forEach((p, i) => {
      let best = -1, dist = Infinity;
      nodes.forEach((q, j) => { const d = Math.hypot(p.x - q.x, p.y - q.y); if (j !== i && d < dist) { dist = d; best = j; } });
      const pair = [Math.min(i, best), Math.max(i, best)].join(':');
      if (best < 0 || dist > 46 || drawnPairs.has(pair)) return;
      drawnPairs.add(pair);
      const q = nodes[best];
      for (const piece of keepAlong([p, q], (x, at) => !shine(x) && at % 2.2 < 1.1, 0.2)) add('constellation-acid', piece, false);
    });
    // The water: dark rows parted by the star's glitter path, and the streams refracted below the surface.
    const starX = slabPage(star[star.length - 1]).x;
    const streamX = strands.map(st => slabPage(solid(st.x, 0, st.z, 0, 0, 0, 0, 'stub')).x);
    const sea = glitter(ctx, starX, streamX);
    sea.rows.forEach((p, i) => add(i % 5 === 2 ? 'water-carbon' : 'water-ultramarine', p, false));
    for (const p of sea.sparkle) add('glitter-acid', p, false);
    for (const p of sea.refraction) add('glitter-vermilion', p, false);
    const parts = buckets.toParts(['night', 'constellation', 'star', 'pieces', 'helix', 'water', 'glitter', 'slogan', 'title'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: [[{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }]] });
    parts.push(...cardFrame('XVII', 'THE STAR'));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
