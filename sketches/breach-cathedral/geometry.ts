import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';

type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet';
type Stroke = { ink: Ink; points: THREE.Vector3[] };
type Slab = { x: number; y: number; z: number; w: number; h: number; d: number; beat: number };

const W = 594, H = 840; // two depth pixels per page millimeter
const ART = { x0: 18, x1: 279, y0: 76, y1: 357 };
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function camera(): THREE.OrthographicCamera {
  const halfWidth = 7.6;
  const halfHeight = halfWidth * 420 / 297;
  const view = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 80);
  view.up.set(0, 1, 0);
  view.position.set(3.2, -5.8, 19.5);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

function line(ink: Ink, ...points: THREE.Vector3[]): Stroke { return { ink, points }; }

function slabs(ctx: SketchContext): Slab[] {
  const rng = ctx.random('cathedral-topology');
  const reach = n(ctx, 'cantilever', 0.55, 0, 1);
  const breach = n(ctx, 'breach', 0.5, 0, 1);
  const count = Math.round(n(ctx, 'levels', 9, 7, 11));
  const out: Slab[] = [];
  const phase = rng() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const y = -6.5 + i * 13 / (count - 1) + (rng() - 0.5) * 0.24;
    // Each level is a weighted, asymmetrical counterpoint around the void.
    const sign = (i % 3 === 1 ? -phase : phase) * (rng() < 0.2 ? -1 : 1);
    const width = 2.5 + reach * 1.85 + rng() * 0.95;
    const x = sign * (1.68 + rng() * 0.58);
    const z = (rng() - 0.5) * 0.48;
    const h = 0.74 + rng() * 0.50;
    const d = 0.75 + rng() * 0.40;
    // Open slots are built from separated solids, so the shell may really
    // appear through them in the common depth pass.
    if (i % 4 === 2) {
      const gap = 0.58 + 0.2 * breach;
      const left = width * (0.43 + rng() * 0.08);
      const right = width - gap - left;
      out.push({ x: x - width / 2 + left / 2, y, z, w: left, h, d, beat: i });
      out.push({ x: x + width / 2 - right / 2, y, z, w: right, h, d, beat: i });
    } else out.push({ x, y, z, w: width, h, d, beat: i });
    // A projecting upper course and a blade grow from selected levels.
    if (i % 2 === 0) out.push({ x: x + sign * 0.15, y: y + h * 0.48,
      z: z + 0.18, w: width * (0.74 + rng() * 0.15), h: 0.18, d: d + 0.30, beat: i });
    if (i % 3 === 1) out.push({ x: x - sign * width * 0.35, y: y + h * 0.7,
      z: z - 0.1, w: 0.24 + rng() * 0.16, h: 1.35 + rng() * 0.5,
      d: d * 0.8, beat: i });
    if (i % 3 === 0 || (rng() < 0.42 && i !== Math.floor(count / 2))) {
      out.push({ x: -sign * (2.20 + rng() * 0.38), y: y + 0.18, z: -0.34, w: 1.5 + rng() * 0.9, h: 0.75 + rng() * 0.28, d: 0.88, beat: i });
    }
  }
  // One narrow, nearly continuous structural blade bears the composition.
  // Opposing remnants are shorter so the central paper shaft stays legible.
  for (let i = 0; i < 3; i++) {
    if (!(breach > 0.72 && i === 1)) out.push({ x: -1.75, y: -4.55 + i * 4.55,
      z: -0.55, w: 0.58, h: 4.12, d: 1.00, beat: count + i });
    if (i !== 1) out.push({ x: 3.24 + rng() * 0.2, y: -4.52 + i * 4.52,
      z: -0.56, w: 0.48, h: 2.6 + rng() * 0.5, d: 0.85, beat: count + i + 3 });
  }
  const worldX = n(ctx, 'worldX', 0, -1.5, 1.5);
  const worldY = n(ctx, 'worldY', 0, -1.5, 1.5);
  const worldZ = n(ctx, 'worldZ', 0, -2, 2);
  return out.map(s => ({ ...s, x: s.x + worldX, y: s.y + worldY, z: s.z + worldZ }));
}

function slabGeometry(s: Slab): THREE.BufferGeometry {
  const mesh = new THREE.BoxGeometry(s.w, s.h, s.d);
  mesh.translate(s.x, s.y, s.z);
  return mesh;
}

function slabStrokes(s: Slab, density: number, interrupt: boolean): Stroke[] {
  const out: Stroke[] = [];
  const x0 = s.x - s.w / 2, x1 = s.x + s.w / 2;
  const y0 = s.y - s.h / 2, y1 = s.y + s.h / 2;
  const zf = s.z + s.d / 2 + 0.006, zb = s.z - s.d / 2;
  const p = (x: number, y: number, z = zf) => new THREE.Vector3(x, y, z);
  out.push(line('carbon', p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)));
  out.push(line('carbon', p(x0, y1), p(x0, y1, zb), p(x1, y1, zb), p(x1, y1)));
  out.push(line('carbon', p(x1, y0), p(x1, y0, zb)));
  // Open hatch packets are deliberately interrupted at selected beats.
  const pitch = 0.055 - density * 0.020;
  const margin = 0.07;
  const across = Math.floor((s.w - 2 * margin) / pitch);
  for (let j = 0; j <= across; j++) {
    if (interrupt && j % 5 < 2 && j > across * 0.27 && j < across * 0.76) continue;
    const x = x0 + margin + j * (s.w - 2 * margin) / Math.max(1, across);
    const ycut = y0 + margin + (j % 4) * 0.045;
    out.push(line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x, ycut), p(Math.min(x + 0.20, x1 - margin), y1 - margin)));
  }
  if (s.w > 2.2 && s.beat % 3 !== 1) {
    const rows = Math.ceil(s.h / 0.12);
    for (let j = 1; j < rows; j++) {
      const y = y0 + j * s.h / rows;
      const inset = 0.13 + (j % 3) * 0.035;
      out.push(line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x0 + inset, y), p(x1 - inset, Math.min(y + 0.11, y1 - 0.06))));
    }
  }
  if (s.h > 0.35) {
    const sideRows = Math.ceil(s.h / 0.065);
    for (let j = 1; j < sideRows; j++) {
      const y = y0 + j * s.h / sideRows;
      out.push(line(j % 4 === 0 ? 'ultramarine' : 'carbon',
        p(x1 + 0.007, y, zb + 0.04), p(x1 + 0.007, Math.min(y + 0.09, y1 - 0.02), zf - 0.04)));
    }
  }
  // A dark transverse course marks actual load along each cantilever.
  for (let k = 1; k <= 3; k++) {
    const y = y0 + k * s.h / 4;
    out.push(line(k === 2 ? 'ultramarine' : 'carbon', p(x0 + 0.09, y), p(x1 - 0.09, y)));
  }
  // Top planes remain open, with a few blue depth scores rather than raster fill.
  const topRows = Math.ceil(s.w / 0.12);
  for (let k = 1; k < topRows; k++) {
    const x = x0 + k * s.w / topRows;
    out.push(line('ultramarine', p(x, y1, zb + 0.03), p(x, y1, zf - 0.03)));
  }
  return out;
}

type Shell = {
  phase: number; twist: number; width: number; focusX: number; focusY: number;
  x: number; y: number; z: number;
  start: number; sweep: number; hand: 1 | -1; aspect: number; tilt: number;
};

function shell(ctx: SketchContext): Shell {
  const random = ctx.random('living-shell');
  const silhouette = ctx.random('shell-silhouette');
  const family = Math.floor(silhouette() * 3);
  const hand: 1 | -1 = silhouette() > 0.65 ? -1 : 1;
  const aspectRoll = silhouette();
  const tiltRoll = silhouette();
  // Independent seeded topology choices, separate from local undulation.
  // Family 0 in its forward direction preserves the original open arch.
  const start = family === 0 ? (hand === 1 ? -0.28 : -0.50) * Math.PI
    : family === 1 ? -0.18 * Math.PI : -0.72 * Math.PI;
  const sweep = (family === 0 ? (hand === 1 ? 1.55 : 1.12)
    : family === 1 ? 1.13 : 1.82) * Math.PI;
  return {
    phase: random() * Math.PI * 2,
    twist: n(ctx, 'shellTwist', 0.62, 0, 1),
    width: n(ctx, 'shellWidth', 1.75, 0.8, 2.7),
    focusX: n(ctx, 'focusX', 0.5, 0, 1),
    focusY: n(ctx, 'focusY', 0.5, 0, 1),
    x: n(ctx, 'worldX', 0, -1.5, 1.5),
    y: n(ctx, 'worldY', 0, -1.5, 1.5),
    z: n(ctx, 'worldZ', 0, -2, 2),
    start, sweep, hand,
    aspect: aspectRoll > 0.8 ? 1 : 0.84 + 0.2 * aspectRoll,
    tilt: tiltRoll > 0.7 ? 0.28 : tiltRoll > 0.32 ? -0.14 : 0,
  };
}

function shellPoint(s: Shell, u: number, v: number): THREE.Vector3 {
  const a = s.start + u * s.sweep;
  const pressure = Math.sin(Math.PI * u) ** 2;
  const rx = 2.82 * s.aspect;
  const ry = 5.25 / s.aspect;
  const meander = 0.17 * Math.sin(9 * a + s.phase) * pressure;
  const cx = rx * Math.cos(a) + meander;
  const cy = ry * Math.sin(a) + 0.36 * Math.sin(2 * a + s.phase * 0.3);
  const baseZ = 0.78 + 1.58 * Math.sin(2.4 * a + s.phase * 0.27) + s.z;
  const roll = s.twist * (0.9 * Math.sin(2.3 * a + s.phase) + 0.5 * Math.cos(4.5 * a));
  const taper = 0.16 + 0.93 * Math.sin(Math.PI * u) ** 0.58;
  const width = s.width * taper * (0.86 + 0.17 * Math.sin(7 * a + s.phase));
  const localX = cx + v * width * Math.cos(a) * Math.cos(roll);
  const localY = cy + v * width * Math.sin(a) * Math.cos(roll);
  const ct = Math.cos(s.tilt), st = Math.sin(s.tilt);
  return new THREE.Vector3(
    s.x + (s.focusX - 0.5) * 2.4 + s.hand * (localX * ct - localY * st),
    s.y + (s.focusY - 0.5) * 2.4 + localX * st + localY * ct,
    baseZ + v * width * Math.sin(roll) + 0.13 * (1 - v * v),
  );
}

function trace(ink: Ink, count: number, fn: (t: number) => THREE.Vector3): Stroke {
  return { ink, points: Array.from({ length: count + 1 }, (_, i) => fn(i / count)) };
}

function shellStrokes(s: Shell, density: number, interruption: number, ctx: SketchContext): Stroke[] {
  const out: Stroke[] = [];
  const rng = ctx.random('lamellar-64-beat');
  for (const v of [-1, 1]) out.push(trace('vermilion', 192, t => shellPoint(s, t, v)));
  const barGates = Array.from({ length: 8 }, (_, bar) => bar === 0 || bar === 7 || rng() > interruption * 0.73);
  const contours = Math.round(84 + density * 42);
  for (let j = 0; j < contours; j++) {
    const v = -0.975 + 1.95 * (j + 0.5) / contours;
    const ink: Ink = j % 13 === 0 ? 'vermilion' : j % 4 === 0 ? 'violet' : 'ultramarine';
    for (let bar = 0; bar < 8; bar++) {
      if (!barGates[bar] && j % 6 !== 0) continue;
      if (bar % 2 === 1 && j % 17 === 0) continue;
      const start = bar / 8 + 0.002, end = (bar + 1) / 8 - 0.002;
      out.push(trace(ink, 20, t => shellPoint(s, start + (end - start) * t, v)));
    }
  }
  out.push(trace('acid', 192, t => shellPoint(s, t, 0)));
  const ribs = Math.round(52 + density * 20);
  for (let i = 0; i <= ribs; i++) {
    const u = i / ribs;
    const group = Math.floor(i / 8);
    if (rng() < interruption * (group % 2 ? 1.0 : 0.42)) continue;
    out.push(trace(i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine', 14,
      t => shellPoint(s, u, -0.96 + t * 1.92)));
  }
  // Sixty-four small offset pulses: 8 bars of 8, with rests built into the rule.
  for (let i = 0; i < 64; i++) {
    const bar = Math.floor(i / 8), beat = i % 8;
    if ((beat === 2 || beat === 5) && bar % 2 === 0) continue;
    if (rng() < interruption * 0.38) continue;
    const u = (i + 0.5) / 64;
    out.push(trace(bar % 2 ? 'violet' : 'acid', 5,
      t => shellPoint(s, u, -1.12 - 0.15 * t)));
  }
  return out;
}

function clipArt(points: Point[]): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    let enter = 0, exit = 1;
    for (const [p, q] of [[-dx, a.x - ART.x0], [dx, ART.x1 - a.x], [-dy, a.y - ART.y0], [dy, ART.y1 - a.y]]) {
      if (p === 0) { if (q < 0) { enter = 1; exit = 0; break; } }
      else { const t = q / p; if (p < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t); }
    }
    if (enter > exit) { flush(); continue; }
    const lerp = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
    const start = lerp(enter), end = lerp(exit);
    if (run.length && (Math.hypot(run[run.length - 1].x - start.x, run[run.length - 1].y - start.y) > 0.001 || enter > 0)) flush();
    if (!run.length) run.push(start);
    run.push(end);
    if (exit < 1) flush();
  }
  flush();
  return runs;
}

function simplify(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const area = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (span > 1.4 || area > 0.15) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function drawCathedral(ctx: SketchContext): Part[] {
  const architecture = slabs(ctx);
  const organism = shell(ctx);
  const density = n(ctx, 'hatchDensity', 0.55, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 0.8);
  const rng = ctx.random('slab-interruptions');
  const beats = Array.from({ length: 64 }, () => rng() < interruption);
  const strokes: Stroke[] = architecture.flatMap(s => slabStrokes(s, density, beats[(s.beat * 7) % 64]));
  strokes.push(...shellStrokes(organism, density, interruption, ctx));
  const geometries = architecture.map(slabGeometry);
  geometries.push(buildSurfaceMesh((u, v) => shellPoint(organism, u, 2 * v - 1), {}, 150, 14));
  try {
    const view = camera();
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const projection = projectPolylinesClipped(strokes.map(s => s.points), view, W, H);
    const buckets = new Map<Ink, Point[][]>(INKS.map(ink => [ink, []]));
    const removeHidden = ctx.params.occlusion !== false;
    for (let i = 0; i < projection.polylines.length; i++) {
      const ink = strokes[projection.sourceIndices[i]].ink;
      for (const clipped of clipProjectedPolyline(projection.polylines[i], W, H)) {
        const dense = densifyProjectedPolyline(clipped);
        const runs = removeHidden ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        for (const run of runs) {
          const mm = run.map(p => ({ x: p.x / 2, y: p.y / 2 }));
          for (const path of clipArt(mm)) {
            const reduced = simplify(path);
            let length = 0;
            for (let j = 1; j < reduced.length; j++) {
              length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
            }
            if (reduced.length > 1 && length > 0.5) {
              buckets.get(ink)!.push(reduced);
            }
          }
        }
      }
    }
    return INKS.map(ink => ({ id: `cathedral-${ink}`, pen: ink, paths: buckets.get(ink)! }));
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
