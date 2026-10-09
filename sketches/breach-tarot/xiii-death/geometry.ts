import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, TABLOID_HORIZON_Y, depthRaster, evenlyKept, halo, hatchMin, layoutLength, scaledCount, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { pageExtent, slabEdges, slabGeometry, slabMatrix, slabStrokes, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, narrowStrands, strandPoint, strandStrokes, type Strand } from '../../kit/helix.ts';
import { clearBands, onWordBox, planSlogans, rigidWords, sloganSettings, type SloganPlan, type SloganSurface } from '../../kit/lettering.ts';
import { hatchedDisc, circlePath } from '../../kit/fills.ts';
import type { Family, Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { densify, keepAlong, reduceAtScale } from '../../kit/page.ts';
import { horizonCamera, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { restPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';

/**
 * XIII Death: a singularity on the horizon. The system, a long nave of cathedral slabs, recedes in
 * one-point perspective to a single point on the shared horizon line. Near it, space is pulled in
 * and twisted, and the drawing comes undone with closeness: full hatch at the card's edges, then
 * bare edges, dashes, dots, and a void at the point. The helix rises straight through the point,
 * unbent and fully drawn: the one thing that passes through unchanged.
 *
 * On a smaller card (`kit/format.ts`) the nave and its infall are the same seeded world, scaled with the card. The
 * singularity's marks (the disc, the halo ring, the broken horizon rule) and the radii where the drawing comes undone
 * keep their places and scale their size, so the lens bends the same picture; the dashes, dots and hatch pitches stay
 * in real millimetres, so there are fewer of them. The slabs are outlined as a small card draws them (no back edges,
 * slivers folded into the outline), the infall is thinned in proportion to the card, and the phrase moves to the band.
 */
const { W, H, MM_X, MM_Y } = depthRaster(559, 864);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** The singularity: the vanishing point, on the shared horizon at the card's centre line. */
export const SINGULARITY: Point = { x: PAGE.width / 2, y: HORIZON_Y };
/** The singularity on tabloid's page, where the world's page-picked places are authored. */
const TABLOID_SINGULARITY: Point = { x: TABLOID_PAGE.width / 2, y: TABLOID_HORIZON_Y };
const EYE = 4.2;
/** Where the camera stands down the nave, world units. */
const STAND = 6;
/** The step at which a page path is resampled for the lens to bend: 0.8 mm on the print, scaled with the card. */
const LENS_STEP = layoutLength(0.8);

/** One-point perspective down the nave, shifted so the vanishing point sits on the horizon. */
export function deathCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 64, 40, 90), eye: [0, EYE, STAND], target: [0, EYE, -100], far: 600,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The world camera: `deathCamera` in tabloid's frame (its page, raster and horizon, and its field of view whatever the
 * fit), the same camera at tabloid. The infall and the torn helix are placed on the page through it, so every size and
 * fit builds the same world.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const camera = tabloidFrameCamera({ fov: n(ctx, 'fov', 64, 40, 90), eye: EYE, far: 600, depth: { width: 559, height: 864 } });
  camera.position.z = STAND;
  camera.updateMatrixWorld();
  return camera;
}

/** The nave: paired piers with inward cantilevers in the Breach Cathedral grammar, lintels, paving. */
export function nave(ctx: SketchContext): Slab[] {
  const rng = ctx.random('death-nave');
  const out: Slab[] = [];
  const add = (x: number, y: number, z: number, w: number, h: number, d: number, role: Slab['role'] = 'stack') => {
    const s = solid(x, y, z, w, h, d, out.length, role);
    out.push(s);
    return s;
  };
  const bays = Math.round(n(ctx, 'bays', 26, 14, 36));
  const half = 6.4 + 1.6 * n(ctx, 'width', 0.5, 0, 1);
  for (let k = 0; k < bays; k++) {
    const z = -4 - 7 * k - (rng() - 0.5) * 1.2;
    for (const side of [-1, 1]) {
      add(side * half, 7.4, z, 0.95, 15, 0.95, 'pier');
      // Cantilevers reach inward from the piers at a few seeded heights.
      for (const y of [1.9, 4.9, 8.2, 11.4]) {
        if (rng() < 0.42) continue;
        const reach = 2.2 + 3.4 * rng() * (0.6 + 0.6 * n(ctx, 'reach', 0.5, 0, 1));
        add(side * (half - 0.4 - reach / 2), y + (rng() - 0.5) * 0.5, z + (rng() - 0.5) * 1.6, reach, 0.42 + 0.3 * rng(), 1.2 + 1.2 * rng());
      }
    }
    // Lintels only from the third bay on: a near one would lie along the card's top rule.
    if (k % 3 === 1 && k > 2) add(0, 14.9, z, 2 * half + 1, 0.6, 0.9, 'pier');
    // Paving: five strips per bay, a gap between each.
    for (let c = -2; c <= 2; c++) add(c * 2.45, -0.18, z - 3.5, 2.2, 0.28, 6.4, 'pier');
  }
  // Closer slabs carry more weight: the value runs dark at the card's edges, to paper at the point.
  for (const s of out) s.tone = clamp(1.3 - 0.011 * Math.hypot(s.x, s.y - EYE, s.z - 6), 0.25, 1.25);
  // The paving is the quietest surface: it should lead the eye in, not fill the foot of the card.
  for (const s of out) if (s.y < 0) s.tone = 0.2;
  return out;
}

/**
 * Infall: fragments torn from the nave on a spiral toward the point, chosen on the page and set back
 * into the world along the camera ray, so the lens then sweeps them in. Stretched along the swirl.
 * The page is tabloid's and `view` is `worldCamera`, so every size and fit seeds the same fragments.
 */
export function infall(ctx: SketchContext, view: THREE.PerspectiveCamera): Slab[] {
  const amount = n(ctx, 'infall', 0.5, 0, 1);
  const rng = ctx.random('death-infall');
  const count = Math.round(60 * amount);
  const out: Slab[] = [];
  const start = rng() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const f = i / Math.max(1, count - 1);
    // Two arms of a logarithmic spiral, from the card's edge in toward the halo.
    const arm = i % 2 ? Math.PI : 0;
    const a = start + arm + 2.6 * f + (rng() - 0.5) * 0.5;
    const rho = 128 * Math.exp(-1.15 * f) + (rng() - 0.5) * 10;
    const page = { x: TABLOID_SINGULARITY.x + rho * Math.cos(a), y: TABLOID_SINGULARITY.y + rho * Math.sin(a) * 1.15 };
    const ndc = new THREE.Vector3(page.x / TABLOID_PAGE.width * 2 - 1, -(page.y / TABLOID_PAGE.height * 2 - 1), 0.5).unproject(view);
    const dir = ndc.sub(view.position).normalize();
    const p = view.position.clone().addScaledVector(dir, 14 + 46 * rng());
    const size = 0.35 + 1.1 * (1 - f) * rng();
    const s = solid(p.x, p.y, p.z, size * (1.6 + 2.4 * rng()), size * (0.25 + 0.3 * rng()), size * (0.4 + 0.6 * rng()), 300 + i, 'debris');
    s.rx = (rng() - 0.5) * 1.6; s.ry = (rng() - 0.5) * 2.2; s.rz = a + Math.PI / 2 + (rng() - 0.5) * 0.8;
    s.tone = 0.55;
    out.push(s);
  }
  return out;
}

/** The fewest infall fragments a smaller card keeps, as a share of those seeded, so the two arms of the spiral still read. */
export const INFALL_FLOOR = 0.4;

/**
 * The infall a card draws: every fragment at tabloid. The fragments are loose blocks whose size scales with the card,
 * so a smaller card keeps them in proportion to its scale (`scaledCount` by length, never under `INFALL_FLOOR` of
 * them), as an even spread over their seeded order, less those smaller on paper than `MIN_FEATURE`. The seeded
 * fragments themselves never change.
 */
export function shownInfall(fragments: Slab[], view: THREE.Camera): Slab[] {
  const target = scaledCount(fragments.length, Math.round(INFALL_FLOOR * fragments.length), 'length');
  if (target >= fragments.length && !MIN_FEATURE) return fragments;
  const keep = target / fragments.length;
  return fragments.filter((s, i) => evenlyKept(i, keep) && pageExtent(view, s).size >= MIN_FEATURE);
}

/**
 * Radii on the page, in millimetres from the singularity, where each register gives way. `core` is
 * the event horizon: a solid hatched disc, the darkest mark on the card, that nothing returns from.
 * They are the singularity's flat marks: authored on tabloid and scaled with the card, the halo
 * between the disc and the Einstein radius never under the halo floor.
 */
export interface Undoing { core: number; void: number; dots: number; dashes: number; edges: number }

export function undoing(ctx: SketchContext): Undoing {
  const k = 0.6 + 0.8 * n(ctx, 'undoing', 0.5, 0, 1);
  const core = layoutLength(6 + 14 * n(ctx, 'core', 0.5, 0, 1));
  // The halo's edge is the Einstein radius: subtle, a few millimetres of paper round the disc. (At tabloid the sum keeps
  // the print's order of operations, to the bit.)
  const lensing = n(ctx, 'lensing', 0.5, 0, 1);
  const ring = FORMAT.tabloid ? core + 3 + 6 * lensing : core + halo(3 + 6 * lensing);
  return { core, void: ring, dots: ring + layoutLength(16 * k), dashes: ring + layoutLength(36 * k), edges: ring + layoutLength(70 * k) };
}

/**
 * Lensing, kept subtle. Light passing the hole bends outward: every drawn point at page radius β
 * is seen at the primary radius (β + √(β² + 4θ²)) / 2, so nothing primary falls inside the Einstein
 * radius θ (the edge of the paper halo). A faint, broken secondary image appears on the far side at
 * (√(β² + 4θ²) − β) / 2, squeezed between the disc and θ. Frame dragging adds a gentle swirl.
 */
export interface Lens { einstein: number; primary: (p: Point) => Point; secondary: (p: Point) => Point | null }

export function lens(ctx: SketchContext, u: Undoing): Lens {
  const swirl = 4 * n(ctx, 'swirl', 0.5, 0, 1);
  const reach = layoutLength(80);
  const t = u.void;
  // The secondary image keeps a knockout halo off the disc.
  const rim = u.core + halo(0.6);
  const polar = (p: Point) => ({ r: Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y), a: Math.atan2(p.y - SINGULARITY.y, p.x - SINGULARITY.x) });
  const at = (r: number, a: number): Point => ({ x: SINGULARITY.x + r * Math.cos(a), y: SINGULARITY.y + r * Math.sin(a) });
  return {
    einstein: t,
    primary: p => {
      const { r, a } = polar(p);
      const r2 = (r + Math.sqrt(r * r + 4 * t * t)) / 2;
      return at(r2, a + swirl * Math.exp(-r2 / reach));
    },
    secondary: p => {
      const { r, a } = polar(p);
      const r2 = (Math.sqrt(r * r + 4 * t * t) - r) / 2;
      return r2 > rim ? at(r2, a + Math.PI - swirl * Math.exp(-r2 / reach)) : null;
    },
  };
}

/**
 * Edges: solid out to the dashes ring, construction dashes, then dots, then nothing at the point.
 * The pull crowds lines inward, so inside the dashes ring each line also has its own `rank` in
 * [0, 1) and survives only where rank is below a share that falls to zero at the void: density
 * thins smoothly toward the point instead of knotting there.
 */
export function unrenderEdge(path: Point[], u: Undoing, rank = 0): Point[][] {
  return keepAlong(path, (p, at) => {
    const r = Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y);
    if (r >= u.dashes) return true;
    if (rank >= Math.max(0, (r - u.void) / (u.dashes - u.void)) ** 1.6) return false;
    if (r >= u.dots) {
      const f = (u.dashes - r) / (u.dashes - u.dots);
      const period = 1.4 + 2.4 * f;
      return at % period < period * (0.62 - 0.25 * f);
    }
    if (r >= u.void) {
      const f = (u.dots - r) / (u.dots - u.void);
      return at % (2.2 + 4 * f) < 0.5;
    }
    return false;
  });
}

/** Hatch survives only beyond the edges ring: weight belongs to the periphery. */
export function unrenderHatch(path: Point[], u: Undoing): Point[][] {
  return keepAlong(path, p => Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y) >= u.edges);
}

export type HelixMode = 'world' | 'apart' | 'torn';

/**
 * The helix as a vertical column in the nave: on the line through the point, or set off to one side. `view` is
 * `worldCamera`: the torn column's place is picked on tabloid's page.
 */
export function column(ctx: SketchContext, view: THREE.PerspectiveCamera, mode: HelixMode): Strand[] {
  // Torn stands well off to one side, where the pull can reach its ends without swallowing its middle.
  const offset = mode === 'torn' ? -64 : 0;
  let x = 0;
  if (offset !== 0) {
    const ndc = new THREE.Vector3((TABLOID_SINGULARITY.x + offset) / TABLOID_PAGE.width * 2 - 1, -(TABLOID_SINGULARITY.y / TABLOID_PAGE.height * 2 - 1), 0.5).unproject(view);
    const dir = ndc.sub(view.position).normalize();
    x = view.position.x + dir.x * (36 / -dir.z);
  }
  const slim = mode === 'apart' ? 0.85 : 1;
  // Apart rises from the point rather than standing across it: its tapered foot overlaps the top of
  // the event horizon, so the disc still reads at first glance and the helix seems to envelop it.
  const foot = mode === 'apart' ? EYE - 0.35 : -0.2;
  return helixStrands({ ...ctx, params: { helixTurns: 2.4, ...ctx.params } }).map(s => ({
    ...s, x, y: 0, z: -30, y0: foot + (s.id === 'b' ? 0.6 : 0), y1: 21 - (s.id === 'b' ? 1.4 : 0),
    radius: n(ctx, 'helixRadius', 1.9, 1, 3.4) * slim * (s.id === 'b' ? 0.94 : 1), depth: 1,
    width: n(ctx, 'shellWidth', 0.7, 0.4, 1.8) * slim * (s.id === 'b' ? 0.9 : 1), swell: 0,
  }));
}

/**
 * A coarse page bitmap of the helix's silhouette, so a separate helix can stand in front of all. Its cells are a quarter
 * millimetre on paper at any size, as fine as a small card's depth raster: cells scaled with the card (`4 / S` px per mm)
 * moved 1.4 mm of ink on a 70 × 120 card, and added 3,000 points.
 */
function coverage(geometries: THREE.BufferGeometry[], view: THREE.Camera): (p: Point) => boolean {
  const res = 4, gw = Math.ceil(PAGE.width * res), gh = Math.ceil(PAGE.height * res);
  const grid = new Uint8Array(gw * gh);
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position'), index = g.getIndex();
    const tri = index ? index.count / 3 : pos.count / 3;
    const page = (k: number) => { v.fromBufferAttribute(pos, k).project(view); return { x: (v.x * 0.5 + 0.5) * gw, y: (-v.y * 0.5 + 0.5) * gh }; };
    for (let t = 0; t < tri; t++) {
      const [a, b, c] = [0, 1, 2].map(j => page(index ? index.getX(t * 3 + j) : t * 3 + j));
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(gw - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(gh - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) grid[y * gw + x] = 1;
      }
    }
  }
  return p => {
    const x = Math.floor(p.x * res), y = Math.floor(p.y * res);
    return x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x] === 1;
  };
}

export function drawDeath(ctx: SketchContext): Part[] {
  const view = deathCamera(ctx);
  // The world is laid out in tabloid's frame and drawn with the card's own camera (the same camera at tabloid).
  const world = worldCamera(ctx);
  const mode: HelixMode = ctx.params.helixMode === 'world' || ctx.params.helixMode === 'torn' ? ctx.params.helixMode : 'apart';
  const architecture = [...nave(ctx), ...shownInfall(infall(ctx, world), view)];
  const strands = column(ctx, world, mode);
  const density = n(ctx, 'hatchDensity', 0.62, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 1);
  const beatRng = ctx.random('death-rests');
  const beats = restPattern(beatRng, interruption);
  const removeHidden = ctx.params.occlusion !== false;
  // The first six strokes of every solid are its outline edges; the rest is hatch. A small card outlines each solid as
  // `slabEdges` does instead (no back edges, a face narrower on paper than the smallest feature folded into the
  // outline): `slabStrokes` has no trim of its own.
  const strokes: Stroke[] = architecture.flatMap((s, owner) => {
    const made = slabStrokes(s, density, beats[(s.beat * 7) % 64])
      .map((stroke, k): Stroke => ({ ink: stroke.ink, group: 'system', family: k < 6 ? 'edge' : 'hatch', points: stroke.points, owner }));
    if (FORMAT.tabloid) return made;
    const outline = slabEdges(s, view, removeHidden).map((points): Stroke => ({ ink: 'carbon', group: 'system', family: 'edge', points, owner }));
    return [...outline, ...made.slice(6)];
  });
  for (const s of strands) {
    // A strand narrower on the card than the smallest feature is drawn by its line (none at tabloid).
    for (const stroke of narrowStrands(strandStrokes(s, density, interruption, ctx, view), view)) {
      strokes.push({ ink: stroke.ink, group: 'helix', family: 'membrane', points: stroke.points });
    }
  }
  const geometries = architecture.map(slabGeometry);
  const helixMeshes = strands.map(s => buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  geometries.push(...helixMeshes);
  const u = undoing(ctx);
  const bend = lens(ctx, u);
  // A fixed rank per source stroke (golden-ratio sequence): which lines give out first near the point.
  const rankOf = (i: number) => (i * 0.6180339887) % 1;
  const radius = (p: Point) => Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y);
  // How far out the faint secondary image is drawn from: 70 mm on the print, scaled with the card.
  const ghostReach = layoutLength(70);
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // Where the helix ends lie on the page, for the torn mode's measure of how far along it a point is.
    const ends = strands.flatMap(s => [strandPoint(s, 0, 0), strandPoint(s, 1, 0)]).map(p => (-p.clone().project(view).y * 0.5 + 0.5) * PAGE.height);
    const mid = (Math.min(...ends) + Math.max(...ends)) / 2, half = (Math.max(...ends) - Math.min(...ends)) / 2;
    const endness = (p: Point) => smooth(0.62, 1.05, Math.abs(p.y - mid) / half);
    // The phrase lives where the drawing still holds: on near faces, well out from the point. Where the format sets it
    // in the band, under the card's name, the art carries no words (and so no title).
    const settings = sloganSettings(ctx);
    const surfaces: SloganSurface[] = [];
    if (PHRASE === 'art') architecture.forEach((s, id) => {
      const p = pageOf(view, new THREE.Vector3(s.x, s.y, s.z + s.d / 2));
      const inset = layoutLength(10), drop = layoutLength(8);
      const inside = p.x > CARD.x0 + inset && p.x < CARD.x1 - inset && p.y > CARD.y0 + drop && p.y < CARD.y1 - drop;
      if (s.role === 'stack' && inside && radius(p) > u.edges + layoutLength(12)) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const slogans: SloganPlan = PHRASE === 'art'
      ? planSlogans(ctx, surfaces, {
        view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
        art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y },
      })
      : { strokes: [], strokeCaps: [], knockouts: new Map(), placed: [], titleStrokes: [], titleCap: 0 };
    const pen = settings.pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    const drawn: { key: string; path: Point[]; family: Family }[] = [];
    const words: { key: string; path: Point[] }[] = [];
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      hidden: () => removeHidden,
      pieces: (c, stroke) => {
        const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
        return bands ? clearBands(c, bands, MM_Y) : [c];
      },
      begin: (stroke, index) => {
        const key = `${stroke.group}-${stroke.ink}`;
        const rank = rankOf(index);
        return runs => { for (const run of runs) {
          const mm = scalePoints(run, MM_X, MM_Y);
          if (stroke.family === 'text') { words.push({ key, path: mm }); continue; }
          const lensed = stroke.family !== 'membrane' || mode === 'world';
          if (stroke.family === 'membrane' && mode === 'torn') {
            // Whole through the middle; toward each end it is pulled in and shredded.
            const torn = densify(mm, LENS_STEP).map(p => { const e = endness(p) ** 1.4; const q = bend.primary(p); return { x: p.x + (q.x - p.x) * e * 1.6, y: p.y + (q.y - p.y) * e * 1.6 }; });
            for (const inside of clipWindow(torn)) {
              for (const path of keepAlong(inside, (p, at) => {
                const e = endness(p);
                if (radius(p) < u.void) return false;
                if (e < 0.08) return true;
                if (rank > 1 - 0.7 * e) return false;
                const period = 3 + 7 * e;
                return at % period < period * (1 - 0.55 * e);
              })) drawn.push({ key, path, family: 'membrane' });
            }
            continue;
          }
          const primary = lensed ? densify(mm, LENS_STEP).map(bend.primary) : mm;
          for (const inside of clipWindow(primary)) {
            const kept = stroke.family === 'hatch' ? unrenderHatch(inside, u)
              : stroke.family === 'edge' || (stroke.family === 'membrane' && mode === 'world') ? unrenderEdge(inside, u, rank)
              : [inside];
            for (const path of kept) drawn.push({ key, path, family: stroke.family });
          }
          // The faint secondary image: a few outline edges near the line of sight, broken and sparse.
          if ((stroke.family === 'edge' || (stroke.family === 'membrane' && mode === 'world')) && rank < 0.16) {
            const ghost = densify(mm, LENS_STEP).filter(p => radius(p) < ghostReach).map(p => bend.secondary(p));
            let ghostRun: Point[] = [];
            const flush = () => {
              for (const path of keepAlong(ghostRun, (_, at) => at % 2.4 < 1.3)) drawn.push({ key, path, family: 'edge' });
              ghostRun = [];
            };
            for (const p of ghost) { if (p) ghostRun.push(p); else flush(); }
            flush();
          }
        } };
      },
    });
    const edge = layoutLength(3);
    const lettering = rigidWords(words, bend.primary, { x0: CARD.x0 + edge, x1: CARD.x1 - edge, y0: CARD.y0 + edge, y1: CARD.y1 - edge });
    for (const w of lettering.words) for (const path of clipWindow(w.path)) drawn.push({ key: w.key, path, family: 'text' });
    const onWord = (p: Point) => onWordBox(lettering.boxes, p);
    // A separate helix stands in front of everything, the singularity's own marks included.
    const front = mode === 'apart' ? coverage(helixMeshes, view) : null;
    // Curves keep their shape on a small card: the reducer's thresholds scale with it (`simplify` at tabloid).
    const buckets = new PartBuckets(undefined, { reduce: reduceAtScale });
    const add = (key: string, path: Point[], family: Family | 'flat') => {
      const clear = (p: Point) => (!front || family === 'membrane' || !front(p)) && (family === 'text' || family === 'flat' || !onWord(p));
      const kept = front || lettering.boxes.length ? keepAlong(path, clear, 0.25) : [path];
      // A piece of a face's hatch shorter than the smallest feature is a speck on a small card.
      const floor = hatchMin(family) ?? (family === 'text' ? 0.05 : family === 'edge' ? 0.35 : 0.5);
      for (const piece of kept) buckets.add(key, piece, family === 'text' || family === 'flat', floor);
    };
    for (const d of drawn) add(d.key, d.path, d.family);
    // The flat marks: the horizon rule, unbent, broken at the point; the event horizon, a disc hatched
    // solid in two crossing families; and one thin ring at the Einstein radius, the halo's edge.
    const gap = u.void + halo(2), rule = tolerance(0.9);
    const disc = hatchedDisc(SINGULARITY, u.core, [[Math.PI / 4, 0.55], [-Math.PI / 4, 0.8]]);
    for (const path of [...disc, circlePath(SINGULARITY, bend.einstein)]) add('singularity-carbon', path, 'flat');
    for (const path of [
      [{ x: CARD.x0, y: HORIZON_Y }, { x: SINGULARITY.x - gap, y: HORIZON_Y }],
      [{ x: SINGULARITY.x + gap, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }],
      [{ x: CARD.x0, y: HORIZON_Y + rule }, { x: SINGULARITY.x - gap, y: HORIZON_Y + rule }],
      [{ x: SINGULARITY.x + gap, y: HORIZON_Y + rule }, { x: CARD.x1, y: HORIZON_Y + rule }],
    ]) add('threshold-carbon', path, 'flat');
    const parts = buckets.toParts(['system', 'helix', 'slogan', 'title'], INKS);
    for (const id of ['singularity-carbon', 'threshold-carbon']) parts.push({ id, pen: 'carbon', paths: buckets.get(id) ?? [] });
    parts.push(...cardFrame('XIII', 'DEATH', { phrase: settings }));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
