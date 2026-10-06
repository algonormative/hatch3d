import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, simplify, slabGeometry, slabMatrix, slabStrokes, solid, strandPoint, strandStrokes, type Ink, type Slab, type Strand,
} from '../../breach-cathedral-tower/geometry.ts';
import { clearBands, planSlogans, sloganSettings, type SloganSurface } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * XIII Death: a singularity on the horizon. The system, a long nave of cathedral slabs, recedes in
 * one-point perspective to a single point on the shared horizon line. Near it, space is pulled in
 * and twisted, and the drawing comes undone with closeness: full hatch at the card's edges, then
 * bare edges, dashes, dots, and a void at the point. The helix rises straight through the point,
 * unbent and fully drawn: the one thing that passes through unchanged.
 */
type Family = 'edge' | 'hatch' | 'membrane' | 'text';
type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };

const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** The singularity: the vanishing point, on the shared horizon at the card's centre line. */
export const SINGULARITY: Point = { x: TABLOID_PAGE.width / 2, y: HORIZON_Y };
const EYE = 4.2;

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** One-point perspective down the nave, shifted so the vanishing point sits on the horizon. */
export function deathCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(n(ctx, 'fov', 64, 40, 90), W / H, 0.5, 600);
  view.position.set(0, EYE, 6);
  view.lookAt(0, EYE, -100);
  view.setViewOffset(W, H, 0, -(HORIZON_Y - TABLOID_PAGE.height / 2) / MM_Y, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

/** The nave: paired piers with inward cantilevers in the Breach Cathedral grammar, lintels, paving. */
function nave(ctx: SketchContext): Slab[] {
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

/** Radii on the page, in millimetres from the singularity, where each register gives way. */
export interface Undoing { void: number; dots: number; dashes: number; edges: number }

export function undoing(ctx: SketchContext): Undoing {
  const k = 0.6 + 0.8 * n(ctx, 'undoing', 0.5, 0, 1);
  return { void: 5 * k, dots: 18 * k, dashes: 38 * k, edges: 72 * k };
}

/** The pull: drawn space near the point is drawn inward and twisted, like matter round a black hole. */
export function lens(ctx: SketchContext): (p: Point) => Point {
  const pull = 0.8 * n(ctx, 'pull', 0.5, 0, 1);
  const swirl = 2.8 * n(ctx, 'swirl', 0.5, 0, 1);
  const reach = 55;
  return p => {
    const dx = p.x - SINGULARITY.x, dy = p.y - SINGULARITY.y;
    const r = Math.hypot(dx, dy);
    if (r < 1e-9) return p;
    const f = Math.exp(-r / reach);
    const r2 = r * (1 - Math.min(0.9, pull) * f), a = Math.atan2(dy, dx) + swirl * f;
    return { x: SINGULARITY.x + r2 * Math.cos(a), y: SINGULARITY.y + r2 * Math.sin(a) };
  };
}

/** Split a page path into short steps and keep the ones a test allows, carrying arclength. */
function keepAlong(path: Point[], keep: (p: Point, at: number) => boolean, step = 0.15): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  let s = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (keep({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, s + len * (t0 + t1) / 2)) {
        if (!run.length) run.push(p0);
        run.push(p1);
      } else flush();
    }
    s += len;
  }
  flush();
  return out;
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

/** Resample so the lens can bend straight segments. */
function densify(path: Point[], step = 0.8): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}

/** The helix, re-seated as a vertical column standing in the nave on the line through the point. */
function column(ctx: SketchContext): Strand[] {
  return helixStrands({ ...ctx, params: { helixTurns: 2.4, ...ctx.params } }).map(s => ({
    ...s, x: 0, y: 0, z: -30, y0: -0.2 + (s.id === 'b' ? 0.6 : 0), y1: 21 - (s.id === 'b' ? 1.4 : 0),
    radius: n(ctx, 'helixRadius', 1.9, 1, 3.4) * (s.id === 'b' ? 0.94 : 1), depth: 1,
    width: n(ctx, 'shellWidth', 0.7, 0.4, 1.8) * (s.id === 'b' ? 0.9 : 1), swell: 0,
  }));
}

export function drawDeath(ctx: SketchContext): Part[] {
  const view = deathCamera(ctx);
  const architecture = nave(ctx);
  const strands = column(ctx);
  const density = n(ctx, 'hatchDensity', 0.62, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 1);
  const beatRng = ctx.random('death-rests');
  const beats = Array.from({ length: 64 }, () => beatRng() < interruption);
  // The first six strokes of every solid are its outline edges; the rest is hatch.
  const strokes: Stroke[] = architecture.flatMap((s, owner) => slabStrokes(s, density, beats[(s.beat * 7) % 64])
    .map((stroke, k): Stroke => ({ ink: stroke.ink, group: 'system', family: k < 6 ? 'edge' : 'hatch', points: stroke.points, owner })));
  for (const s of strands) {
    for (const stroke of strandStrokes(s, density, interruption, ctx, view)) {
      strokes.push({ ink: stroke.ink, group: 'helix', family: 'membrane', points: stroke.points });
    }
  }
  const geometries = architecture.map(slabGeometry);
  for (const s of strands) geometries.push(buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  const u = undoing(ctx);
  const bend = lens(ctx);
  // A fixed rank per source stroke (golden-ratio sequence): which lines give out first near the point.
  const rankOf = (i: number) => (i * 0.6180339887) % 1;
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The phrase lives where the drawing still holds: on near faces, well out from the point.
    const surfaces: SloganSurface[] = [];
    architecture.forEach((s, id) => {
      const c = new THREE.Vector3(s.x, s.y, s.z + s.d / 2).project(view);
      const p = { x: (c.x * 0.5 + 0.5) * TABLOID_PAGE.width, y: (-c.y * 0.5 + 0.5) * TABLOID_PAGE.height };
      const inside = p.x > CARD.x0 + 6 && p.x < CARD.x1 - 6 && p.y > CARD.y0 + 6 && p.y < CARD.y1 - 6;
      if (s.role === 'stack' && inside && Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y) > u.edges + 12) {
        surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
      }
    });
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y },
    });
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    const projection = projectPolylinesClipped(strokes.map(s => s.points), view, W, H);
    const buckets = new Map<string, Point[][]>();
    const removeHidden = ctx.params.occlusion !== false;
    for (let i = 0; i < projection.polylines.length; i++) {
      const stroke = strokes[projection.sourceIndices[i]];
      const key = `${stroke.group}-${stroke.ink}`;
      const text = stroke.family === 'text';
      const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
      const pieces = clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, MM_Y) : [c]);
      for (const clipped of pieces) {
        const dense = densifyProjectedPolyline(clipped);
        const runs = removeHidden ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        for (const run of runs) {
          const mm = run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
          // The helix passes through unbent; everything else, lettering included, feels the pull.
          const bent = stroke.family === 'membrane' ? mm : densify(mm).map(bend);
          for (const inside of clipWindow(bent)) {
            const kept = stroke.family === 'hatch' ? unrenderHatch(inside, u)
              : stroke.family === 'edge' ? unrenderEdge(inside, u, rankOf(projection.sourceIndices[i]))
              // The helix threads the ring: unbent and whole, it simply passes through the void.
              : stroke.family === 'membrane' ? keepAlong(inside, p => Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y) > u.void + 1.2)
              : [inside];
            for (const path of kept) {
              const reduced = text ? path : simplify(path);
              let length = 0;
              for (let j = 1; j < reduced.length; j++) length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
              const floor = text ? 0.05 : stroke.family === 'edge' ? 0.35 : 0.5;
              if (reduced.length > 1 && length > floor) {
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key)!.push(reduced);
              }
            }
          }
        }
      }
    }
    const parts: Part[] = [];
    for (const group of ['system', 'helix', 'slogan', 'title']) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    // The flat mark: the horizon rule, unbent, broken at the point by a small ring.
    const gap = u.void + 2.5;
    const ring = Array.from({ length: 73 }, (_, i) => ({
      x: SINGULARITY.x + u.void * Math.cos(i / 72 * Math.PI * 2), y: SINGULARITY.y + u.void * Math.sin(i / 72 * Math.PI * 2),
    }));
    parts.push({ id: 'threshold-carbon', pen: 'carbon', paths: [
      [{ x: CARD.x0, y: HORIZON_Y }, { x: SINGULARITY.x - gap, y: HORIZON_Y }],
      [{ x: SINGULARITY.x + gap, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }],
      [{ x: CARD.x0, y: HORIZON_Y + 0.9 }, { x: SINGULARITY.x - gap, y: HORIZON_Y + 0.9 }],
      [{ x: SINGULARITY.x + gap, y: HORIZON_Y + 0.9 }, { x: CARD.x1, y: HORIZON_Y + 0.9 }],
      ring,
    ] });
    parts.push(...cardFrame('XIII', 'DEATH'));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
