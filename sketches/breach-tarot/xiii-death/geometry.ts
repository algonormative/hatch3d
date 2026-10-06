import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  camera, helixStrands, simplify, slabGeometry, slabMatrix, slabStrokes, strandPoint, strandStrokes, towerSlabs, type Ink,
} from '../../breach-cathedral-tower/geometry.ts';
import { clearBands, planSlogans, sloganSettings, type SloganSurface } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * XIII Death: a ruled horizon after which nothing needs shading. Below it the cathedral carries its
 * full weight of hatch; above it the same structure goes on as bare edges, then construction
 * dashes, then sparse dots, then nothing. The helix crosses the line unchanged: only the system
 * loses its weight. The tower's own shaft, framed by its two piers, is the empty gate.
 */
type Family = 'edge' | 'hatch' | 'membrane' | 'text';
type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };

const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** How the structure comes undone with height above the line, as a keep-test along a path's length. */
export interface Undoing { solid: number; dashed: number; dotted: number }

export function undoing(ctx: SketchContext): Undoing {
  // Heights above the horizon, in page millimetres, where each register gives way to the next.
  const span = HORIZON_Y - CARD.y0;
  const reach = n(ctx, 'undoing', 0.5, 0, 1);
  return { solid: span * (0.08 + 0.2 * reach), dashed: span * (0.3 + 0.35 * reach), dotted: span * (0.6 + 0.38 * reach) };
}

/** Keep the parts of an edge that its height above the horizon still allows, by arclength rhythm. */
export function unrenderEdge(path: Point[], u: Undoing): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  let s = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  const keep = (p: Point, at: number) => {
    const h = HORIZON_Y - p.y;
    if (h <= u.solid) return true;
    if (h <= u.dashed) {
      // Construction dashes that open up as they climb.
      const f = (h - u.solid) / (u.dashed - u.solid);
      const period = 1.6 + 2.6 * f;
      return at % period < period * (0.62 - 0.22 * f);
    }
    if (h <= u.dotted) {
      const f = (h - u.dashed) / (u.dotted - u.dashed);
      const period = 2.6 + 9 * f;
      return at % period < 0.5;
    }
    return false;
  };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 0.15));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      if (keep(mid, s + len * (t0 + t1) / 2)) {
        if (!run.length) run.push(p0);
        run.push(p1);
      } else flush();
    }
    s += len;
  }
  flush();
  return out;
}

/** Hatch exists only below the line: the weight of the system ends at the horizon. */
function belowLine(path: Point[]): Point[][] {
  return clipWindow(path, { ...CARD, y0: HORIZON_Y, y1: CARD.y1 });
}

export function drawDeath(ctx: SketchContext): Part[] {
  // The system stands intact: no collapse, no debris. Its ending is in how it is drawn.
  const scene: SketchContext = { ...ctx, params: { collapse: 0, debris: 0, hatchDensity: 0.78, cantilever: 0.72, shellWidth: 0.85, helixRadius: 2.5, ...ctx.params } };
  const view = camera();
  // The value key is split at the line: full weight below it, deepest toward the ground.
  const architecture = towerSlabs(scene).map(s => {
    const y = (-new THREE.Vector3(s.x, s.y, s.z).project(view).y * 0.5 + 0.5) * TABLOID_PAGE.height;
    const below = (y - HORIZON_Y) / (CARD.y1 - HORIZON_Y);
    return { ...s, tone: below > 0 ? 0.85 + 0.45 * Math.min(1, below) : 0.3 };
  });
  const strands = helixStrands(scene);
  const density = n(scene, 'hatchDensity', 0.78, 0, 1);
  const interruption = n(scene, 'interruption', 0.32, 0, 1);
  const beatRng = ctx.random('death-rests');
  const beats = Array.from({ length: 64 }, () => beatRng() < interruption);
  // The first six strokes of every solid are its outline edges; the rest is hatch.
  const strokes: Stroke[] = architecture.flatMap((s, owner) => slabStrokes(s, density, beats[(s.beat * 7) % 64])
    .map((stroke, k): Stroke => ({ ink: stroke.ink, group: 'system', family: k < 6 ? 'edge' : 'hatch', points: stroke.points, owner })));
  for (const s of strands) {
    for (const stroke of strandStrokes(s, density, interruption, scene, view)) {
      strokes.push({ ink: stroke.ink, group: 'helix', family: 'membrane', points: stroke.points });
    }
  }
  const geometries = architecture.map(slabGeometry);
  for (const s of strands) geometries.push(buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The phrase lives only where the structure is still drawn: on faces below the line.
    const surfaces: SloganSurface[] = [];
    architecture.forEach((s, id) => {
      const c = new THREE.Vector3(s.x, s.y, s.z).project(view);
      const pageY = (-c.y * 0.5 + 0.5) * TABLOID_PAGE.height;
      if (s.role === 'stack' && s.w > 1.2 && s.h > 0.3 && pageY > HORIZON_Y + 6) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: HORIZON_Y / MM_Y, y1: CARD.y1 / MM_Y },
    });
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    const u = undoing(ctx);
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
          for (const inside of clipWindow(mm)) {
            const kept = stroke.family === 'hatch' ? belowLine(inside)
              : stroke.family === 'edge' ? unrenderEdge(inside, u) : [inside];
            for (const path of kept) {
              const reduced = text ? path : simplify(path);
              let length = 0;
              for (let j = 1; j < reduced.length; j++) length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
              // Construction dots are short by design; everything else drops sub-half-millimetre crumbs.
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
    // The threshold itself: a flat double rule across the window, the card's one 2D mark.
    parts.push({ id: 'threshold-carbon', pen: 'carbon', paths: [
      [{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }],
      [{ x: CARD.x0, y: HORIZON_Y + 0.9 }, { x: CARD.x1, y: HORIZON_Y + 0.9 }],
    ] });
    parts.push(...cardFrame('XIII', 'DEATH'));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
