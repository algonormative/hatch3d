import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, S, TABLOID_CARD, TABLOID_HORIZON_Y, depthRaster, evenlyKept, halo, layoutLength, layoutX, layoutY, scaledCount, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, strandPoint, strandStrokes, type Strand } from '../../kit/helix.ts';
import { clearBands, planSloganAttempts, sloganSettings, type SloganPlan, type SloganSurface } from '../../kit/lettering.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { n } from '../../kit/params.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { atPage, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';

/**
 * XVII The Star: the Tower's debris, reread as a constellation. A night of dense engraved hatch
 * fills the sky; every fallen fragment is a star, a paper shape with a halo cut out of the night,
 * joined to its neighbours by faint dashed lines. At the centre eight cantilevered slabs radiate as
 * the eight-pointed star, and two helix streams pour from it into still water. The water is the
 * card's flat mark: a band of broken ripple hatch in which everything above is reflected, row by row.
 *
 * On a smaller card (`kit/format.ts`) the sky is the same seeded world, scaled with the card. The night's ruling and
 * the water's rows keep their pitch on paper, so there are fewer of them; the debris are thinned to a constellation;
 * a face too narrow to hold apart is drawn as part of its slab's outline; the phrase moves to the band.
 */
const { W, H, MM_X, MM_Y } = depthRaster(559, 864);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.4;

export function starCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 40, 80), eye: [0, EYE, 0], target: [0, EYE, -100], far: 600,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

export interface Sky { star: Slab[]; debris: Slab[]; words: Slab[]; centre: THREE.Vector3 }

/** A page point authored in tabloid's frame, on the format's page. */
const placed = (p: Point): Point => ({ x: layoutX(p.x), y: layoutY(p.y) });
/** A page y back in tabloid's frame (measured from the horizon), for a pattern tuned on tabloid's page. */
const tabloidY = (y: number): number => FORMAT.tabloid ? y : TABLOID_HORIZON_Y + (y - HORIZON_Y) / S;
/** The fewest fragments a smaller card keeps in its sky at the `constellation` default, so the constellation still reads. */
export const CONSTELLATION_FLOOR = 16;

/**
 * The sky's solids. They are placed in tabloid's frame (its page, card and horizon) and carried to the format's
 * page, so the seeded sky is the same world at every size: the same star, the same word fragments, the same
 * debris in the same places, each scaled with the card (`fit: 'height'` crops the sides).
 */
export function sky(ctx: SketchContext, view: THREE.PerspectiveCamera): Sky {
  const rng = ctx.random('star-sky');
  const window = TABLOID_HORIZON_Y - TABLOID_CARD.y0;
  const centre = atPage(view, placed({ x: TABLOID_PAGE.width / 2 + (rng() - 0.5) * 30, y: TABLOID_CARD.y0 + 0.36 * window }), 70);
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
    const p = { x: TABLOID_PAGE.width / 2 + side * (58 + 22 * rng()), y: TABLOID_CARD.y0 + 18 + (i + 0.5) / 6 * (window - 40) };
    const w = atPage(view, placed(p), 55);
    const s = solid(w.x, w.y, w.z, 5.2 + 1.6 * rng(), 1.15, 1.2, 40 + i, 'stack');
    s.rz = (rng() - 0.5) * 0.18; s.ry = (rng() - 0.5) * 0.5; s.rx = (rng() - 0.5) * 0.2;
    s.tone = 0.4;
    words.push(s);
    wordPages.push(p);
  }
  // Debris: the Tower's fragments, small and tumbling, scattered over the sky as stars.
  const count = Math.round(20 + 50 * n(ctx, 'constellation', 0.5, 0, 1));
  const debris: Slab[] = [];
  const starPage = { x: TABLOID_PAGE.width / 2, y: TABLOID_CARD.y0 + 0.36 * window };
  for (let i = 0; i < count; i++) {
    let p: Point;
    let tries = 0;
    do {
      p = { x: TABLOID_CARD.x0 + 6 + rng() * (TABLOID_CARD.x1 - TABLOID_CARD.x0 - 12), y: TABLOID_CARD.y0 + 6 + rng() * (window - 22) };
    } while ((Math.hypot(p.x - starPage.x, p.y - starPage.y) < 95 * size
      // Never in front of a word.
      || wordPages.some(q => Math.abs(p.x - q.x) < 34 && Math.abs(p.y - q.y) < 12)) && ++tries < 40);
    const w = atPage(view, placed(p), 50 + 40 * rng());
    const big = rng() ** 2;
    const s = solid(w.x, w.y, w.z, 0.5 + 2.4 * big, 0.25 + 0.6 * big, 0.4 + 0.9 * big, 20 + i, 'debris');
    s.rx = (rng() - 0.5) * 2.4; s.ry = (rng() - 0.5) * 2.4; s.rz = (rng() - 0.5) * Math.PI;
    s.tone = 0.5;
    debris.push(s);
  }
  return { star, debris, words, centre };
}

/** A slab's bounding box on the page: its centre and its larger side, in millimetres. */
export function pageExtent(view: THREE.Camera, s: Slab): { x: number; y: number; size: number } {
  const m = slabMatrix(s);
  const xs: number[] = [], ys: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const p = pageOf(view, new THREE.Vector3(x * s.w / 2, y * s.h / 2, z * s.d / 2).applyMatrix4(m));
    xs.push(p.x); ys.push(p.y);
  }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
}

/** The fragments the sky seeds at the `constellation` control's default. */
const SEEDED_DEFAULT = 45;

/**
 * The debris a card draws: every fragment the sky seeded, at tabloid. The fragments are a density, so where the
 * format's count of them (`scaledCount`, by the art window's area, never under a floor of `CONSTELLATION_FLOOR` at
 * the control's default, in proportion to it otherwise) is below the seeded number, the sky keeps that share of its
 * fragments as an even spread over their seeded order (so a smaller card keeps a subset of what a larger one shows),
 * less those smaller on paper than `MIN_FEATURE` or outside the sky. The seeded sky itself never changes.
 */
export function shownDebris(debris: Slab[], view: THREE.Camera): Slab[] {
  const target = scaledCount(debris.length, Math.round(CONSTELLATION_FLOOR * debris.length / SEEDED_DEFAULT));
  if (target >= debris.length) return debris;
  const keep = target / debris.length;
  return debris.filter((s, i) => {
    if (!evenlyKept(i, keep)) return false;
    const e = pageExtent(view, s);
    return e.size >= MIN_FEATURE && e.x > CARD.x0 && e.x < CARD.x1 && e.y > CARD.y0 && e.y < HORIZON_Y;
  });
}

/**
 * A slab's twelve edges, each pushed a hair outward so the depth test keeps it, less the inner edges of any face
 * that sees the eye but is narrower on paper than `MIN_FEATURE`. Such a sliver (an arm's shaded side, seen nearly
 * edge-on) is drawn as part of its slab's outline instead of as two strokes closer than the pen can hold apart.
 * With `hidden`, the edges between two faces turned away are left out too: the depth test hides them, except
 * within a pixel or two of the outline, where on a small card they would double it.
 */
export function slabEdges(s: Slab, view: THREE.Camera, hidden = true): THREE.Vector3[][] {
  const m = slabMatrix(s);
  const half = [s.w / 2, s.h / 2, s.d / 2];
  const e = 0.006;
  const local = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  const others = (a: number) => [0, 1, 2].filter(b => b !== a);
  // A face is an axis and a side; its corners run round it.
  const corners = (a: number, side: number) => {
    const [i, j] = others(a);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const c = [0, 0, 0]; c[a] = side * half[a]; c[i] = u * half[i]; c[j] = v * half[j]; return local(c); });
  };
  const seen = (a: number, side: number) => {
    const c = [0, 0, 0], o = [0, 0, 0];
    c[a] = side * half[a]; o[a] = side * (half[a] + 1);
    const centre = local(c);
    return view.position.clone().sub(centre).dot(local(o).sub(centre)) > 0;
  };
  const narrow = (a: number, side: number) => {
    const q = corners(a, side).map(p => pageOf(view, p));
    let area = 0, longest = 0;
    for (let k = 0; k < 4; k++) {
      const p0 = q[k], p1 = q[(k + 1) % 4];
      area += p0.x * p1.y - p1.x * p0.y;
      longest = Math.max(longest, Math.hypot(p1.x - p0.x, p1.y - p0.y));
    }
    return Math.abs(area) / 2 / longest < MIN_FEATURE;
  };
  const edges: THREE.Vector3[][] = [];
  for (let k = 0; k < 3; k++) {
    const [i, j] = others(k);
    for (const si of [-1, 1]) for (const sj of [-1, 1]) {
      const a = seen(i, si), b = seen(j, sj);
      if (a && b && (narrow(i, si) || narrow(j, sj))) continue;
      if (hidden && !a && !b) continue;
      const end = (sk: number) => { const c = [0, 0, 0]; c[k] = sk * half[k]; c[i] = si * (half[i] + e); c[j] = sj * (half[j] + e); return local(c); };
      edges.push([end(-1), end(1)]);
    }
  }
  return edges;
}

/** Two helix streams pour from below the star down into the water. */
function streams(ctx: SketchContext, centre: THREE.Vector3): Strand[] {
  const spread = 2.2 + 2 * n(ctx, 'streams', 0.5, 0, 1);
  return helixStrands({ ...ctx, params: { helixTurns: 3.2, shellTwist: 0.3, ...ctx.params } }).map(s => ({
    ...s, x: centre.x + (s.id === 'a' ? -spread : spread), y: 0, z: centre.z + 2,
    y0: 0, y1: centre.y - 3, radius: 0.75, depth: 1, width: 0.55, swell: 0, centre: 0,
  }));
}

/** Night: engraved hatch over the sky, knocked out round everything that shines. Its ruling is a tone, kept on paper. */
function night(ctx: SketchContext, covered: (p: Point) => boolean): Point[][][] {
  const pitch = tolerance(1.25 - 0.45 * n(ctx, 'night', 0.5, 0, 1));
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
      for (const piece of clipWindow(line, { ...CARD, y1: HORIZON_Y - halo(1.5) })) {
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
  // The rows are a tone: their pitch, opening toward the viewer, is kept on paper, so a smaller card has fewer.
  for (let y = HORIZON_Y + 1.1; y < CARD.y1 - 0.6; y += tolerance(0.85 + 2.2 * depthOf(y) ** 1.5), k++) {
    const d = depthOf(y);
    // The path's centre drifts a little, as a reflection does on moving water.
    const c = cx + layoutLength(2.4) * Math.sin(k * 0.37) * (0.3 + d);
    // Its width is layout: it narrows with the card, while the rows keep their pitch on paper.
    const half = layoutLength(width * (4 + 38 * d ** 0.9) * (0.65 + 0.55 * rng()));
    const left: Point[] = [{ x: CARD.x0, y }, { x: Math.max(CARD.x0, c - half), y }];
    const right: Point[] = [{ x: Math.min(CARD.x1, c + half), y }, { x: CARD.x1, y }];
    for (const r of [left, right]) if (r[1].x - r[0].x > 0.5) rows.push(r);
    // Sparkle inside the path: short dashes, more near its spine, every row but sparser low down. As many to a row
    // as the path's width holds (at least one), each at least 0.8 mm long, longer toward the viewer with the card.
    const count = Math.round(scaledCount((2 + 5 * d) * width, 1, 'length'));
    for (let j = 0; j < count; j++) {
      const u = (rng() * 2 - 1) * (rng() ** 0.6);
      const len = 0.8 + layoutLength((1.2 + 6 * d) * rng() * (1 - 0.6 * Math.abs(u)));
      const x = c + u * (half - len / 2);
      if (Math.abs(u) > 0.15 || rng() < 0.6) sparkle.push([{ x: x - len / 2, y }, { x: x + len / 2, y }]);
    }
  }
  // The streams continue below the surface, refracted: slow wavering lines that fade with depth. The waver is
  // layout, its wavelength measured in tabloid's frame; the dashes keep their length on paper.
  for (const sx of streamsX) {
    const pts: Point[] = [];
    for (let y = HORIZON_Y + 1.5; y < HORIZON_Y + (CARD.y1 - HORIZON_Y) * 0.55; y += 0.5) {
      const d = depthOf(y);
      pts.push({ x: sx + (sx - cx) * 0.6 * d + layoutLength(2.2) * Math.sin(tabloidY(y) * 0.28) * (0.3 + 1.6 * d), y });
    }
    refraction.push(...keepAlong(pts, (p, at) => at % (2 + 9 * depthOf(p.y)) < 2 - 0.8 * depthOf(p.y), 0.2));
  }
  return { rows, sparkle, refraction };
}

export function drawStar(ctx: SketchContext): Part[] {
  const view = starCamera(ctx);
  const { star, debris: seeded, words, centre } = sky(ctx, view);
  const debris = shownDebris(seeded, view);
  const strands = streams(ctx, centre);
  const solids = [...star, ...debris, ...words];
  const light = new THREE.Vector3(0.2, 0.3, 1).normalize();
  // Each solid in the raking-light hatch; off tabloid, its outline drawn without the slivers a smaller card makes.
  const facets = (s: Slab) => {
    const all = facetStrokes(s, light, view.position, s.role === 'debris');
    return FORMAT.tabloid ? all : [
      ...slabEdges(s, view, ctx.params.occlusion !== false).map(points => ({ ink: 'carbon' as const, family: 'edge' as const, points })),
      ...all.filter(st => st.family !== 'edge'),
    ];
  };
  const strokes: Stroke[] = solids.flatMap((s, owner) => facets(s).map(st => ({ ink: st.ink, family: st.family, points: st.points, group: owner < star.length ? 'star' : 'pieces', owner })));
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
    // The phrase, lettered on the word fragments; or, where the format sets it in the band, under the card's name
    // instead. The fragments that carry it on the print stay as pale there. The title goes with the phrase: none then.
    const settings = sloganSettings(ctx);
    const slogans: SloganPlan = PHRASE === 'art'
      ? planSloganAttempts(ctx, env, Array.from({ length: 8 }, (_, k) => ({ surfaces: () => surfaces, salt: k === 0 ? undefined : `slogan-${k}` })))
      : { strokes: [], strokeCaps: [], knockouts: new Map(), placed: [], titleStrokes: [], titleCap: 0 };
    const lettered = new Set(PHRASE === 'art' ? slogans.knockouts.keys() : surfaces.map(s => s.id));
    const sky = strokes.filter(st => !(st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon'));
    const pen = settings.pen as Ink;
    for (const points of slogans.strokes) sky.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) sky.push({ ink: 'lettering', group: 'title', family: 'text', points });
    const all = sky;
    const buckets = new PartBuckets(0.4);
    const add = (key: string, path: Point[], text: boolean, min?: number) => buckets.add(key, path, text, min);
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
        // What a face's hatch leaves shorter than the smallest feature is a speck, not shading: dropped (none at tabloid).
        const min = stroke.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined;
        return runs => {
          for (const run of runs) {
            for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y), { ...CARD, y1: HORIZON_Y - halo(0.5) })) add(key, inside, text, min);
          }
        };
      },
    });
    // The night, knocked out with a paper halo round every shining thing and every word.
    const clearance = halo(1.6 + 1.6 * n(ctx, 'halo', 0.5, 0, 1));
    const shine = meshCoverage(geometries, view, PAGE, clearance);
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
    const nodes = [...debris, ...words].map(slabPage).filter(p => p.y < HORIZON_Y - layoutLength(4));
    const drawnPairs = new Set<string>();
    nodes.forEach((p, i) => {
      let best = -1, dist = Infinity;
      nodes.forEach((q, j) => { const d = Math.hypot(p.x - q.x, p.y - q.y); if (j !== i && d < dist) { dist = d; best = j; } });
      const pair = [Math.min(i, best), Math.max(i, best)].join(':');
      if (best < 0 || dist > layoutLength(46) || drawnPairs.has(pair)) return;
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
    parts.push(...cardFrame('XVII', 'THE STAR', { phrase: settings }));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
