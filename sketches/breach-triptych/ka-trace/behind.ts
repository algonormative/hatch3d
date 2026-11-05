import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { keepAlong, pathLength } from '../../kit/page.ts';
import { atPoint, isoLines, perVertex, platesOn, scatterOn, toWorld, type IsoLine, type SculptMesh, type SurfacePoint, type V3 } from '../../kit/sculpt.ts';

/**
 * The piece behind the piece, drawn as the face behind the visor is: a form cut into plates, each with lines of its own
 * direction that bend over it, gathering where it is dark; some plates cross-hatched, some wandering contours, some bare. Here
 * the form is a relief map traced from a clay render rather than a sculpted head, so the lines lie flat on the sheet. Then
 * it is all taken apart: `throughBlocks` moves, repeats or drops rectangles of it.
 */

export interface ReliefMap { w: number; h: number; x0: number; y0: number; cell: number; data: string }
export interface ReliefOptions { plateMm: number; pitchMm: number; cross: number; contours: number; bare: number; bend: number; swing: number }
export interface Drawn { rank: number; line: Point[] }

function decode(data: string): Uint8Array {
  const text = atob(data), out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The map as a mesh in page millimetres: height the blurred brightness, in `bend` mm; `tone` the brightness per vertex. */
function meshOf(map: ReliefMap, bend: number): { mesh: SculptMesh; tone: Float64Array } {
  const raw = decode(map.data), { w, h, cell, x0, y0 } = map, soft = new Float64Array(w * h), index = new Int32Array(w * h).fill(-1);
  const R = 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!raw[j * w + i]) continue;
    let sum = 0, n = 0;
    for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
      const v = raw[Math.min(h - 1, Math.max(0, j + b)) * w + Math.min(w - 1, Math.max(0, i + a))];
      if (v) { sum += v; n++; }
    }
    soft[j * w + i] = sum / n / 255;
  }
  let count = 0;
  for (let k = 0; k < w * h; k++) if (raw[k]) index[k] = count++;
  const pos = new Float64Array(count * 3), nrm = new Float64Array(count * 3), tone = new Float64Array(count), tri: number[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, v = index[k];
    if (v < 0) continue;
    pos[3 * v] = x0 + (i + 0.5) * cell; pos[3 * v + 1] = y0 + (j + 0.5) * cell; pos[3 * v + 2] = soft[k] * bend;
    const dx = (soft[j * w + Math.min(w - 1, i + 1)] - soft[j * w + Math.max(0, i - 1)]) * bend / (2 * cell), dy = (soft[Math.min(h - 1, j + 1) * w + i] - soft[Math.max(0, j - 1) * w + i]) * bend / (2 * cell), d = Math.hypot(dx, dy, 1);
    nrm[3 * v] = -dx / d; nrm[3 * v + 1] = -dy / d; nrm[3 * v + 2] = 1 / d;
    tone[v] = raw[k] / 255;
    if (i + 1 < w && j + 1 < h) {
      const a = v, b = index[k + 1], c = index[k + w], e = index[k + w + 1];
      if (b >= 0 && c >= 0 && e >= 0) tri.push(a, b, c, b, e, c);
    }
  }
  return { mesh: { pos, nrm, tri: Uint32Array.from(tri), transform: new THREE.Matrix4() }, tone };
}

/** The relief's lines on the sheet. */
export function reliefLines(ctx: SketchContext, map: ReliefMap, o: ReliefOptions): Drawn[] {
  const { mesh, tone } = meshOf(map, o.bend), rng = ctx.random('ka-behind-relief');
  const seeds = scatterOn(mesh, o.plateMm, rng, () => true);
  const plates = platesOn(mesh, seeds);
  // Every plate its own way round, and its own kind.
  const dirs = seeds.map(() => { const a = (rng() * 2 - 1) * o.swing * Math.PI / 2 + 0.3; return [Math.cos(a), Math.sin(a), 0.8 * (rng() * 2 - 1)] as V3; });
  const kinds = seeds.map(() => { const r = rng(); return r < o.bare ? 'bare' : r < o.bare + o.contours ? 'contour' : r < o.bare + o.contours + o.cross ? 'cross' : 'lines'; });
  const out: Drawn[] = [];
  const brightness = (sp: SurfacePoint) => atPoint(tone, sp);
  // Lines by four: one in four even in the light, every other in the half tone, all of them in the shadow.
  const toned = (sp: SurfacePoint, line: IsoLine) => { const i = Math.abs(line.index), b = brightness(sp); return i % 4 === 0 ? b < 0.97 : i % 2 === 0 ? b < 0.62 : b < 0.34; };
  const SEAM = 0.45;
  const runs = (lines: IsoLine[], okay: (sp: SurfacePoint, line: IsoLine) => boolean, rank: number) => {
    for (const line of lines) {
      let run: SurfacePoint[] = [];
      const flush = () => { if (run.length >= 2) { const piece = toWorld(mesh, run).map(q => ({ x: q.x, y: q.y })); if (pathLength(piece) >= 0.8) out.push({ rank, line: piece }); } run = []; };
      for (const sp of line.points) { if (okay(sp, line)) run.push(sp); else flush(); }
      flush();
    }
  };
  const inPlate = (sp: SurfacePoint) => plates.plate[sp.a ?? 0], clearOfSeam = (sp: SurfacePoint) => plates.gap[sp.a ?? 0] > SEAM;
  const field = (turn: number) => perVertex(mesh, (p, _n, v) => { const d = dirs[plates.plate[v]], c = Math.cos(turn), s = Math.sin(turn); return p[0] * (d[0] * c - d[1] * s) + p[1] * (d[0] * s + d[1] * c) + p[2] * d[2]; });
  const lined = (sp: SurfacePoint) => kinds[inPlate(sp)] === 'lines' || kinds[inPlate(sp)] === 'cross';
  runs(isoLines(mesh, field(0), o.pitchMm, rng() * o.pitchMm), (sp, line) => lined(sp) && clearOfSeam(sp) && toned(sp, line), 3);
  runs(isoLines(mesh, field(1.25), o.pitchMm * 1.6, rng() * o.pitchMm), (sp, line) => kinds[inPlate(sp)] === 'cross' && clearOfSeam(sp) && toned(sp, line), 3.5);
  // Contours: of the height, wandering across a plate.
  runs(isoLines(mesh, perVertex(mesh, p => p[2]), o.pitchMm * 1.1 * o.bend / 18, rng()), sp => kinds[inPlate(sp)] === 'contour' && clearOfSeam(sp), 2);
  runs(isoLines(mesh, plates.gap, 1, 0, [SEAM * 0.4]), sp => kinds[inPlate(sp)] !== 'bare' || brightness(sp) < 0.5, 0.8);
  return out;
}

/** A rectangle of the drawing, in a slice frame: moved, repeated elsewhere (the original stays), or gone. */
export interface Block { u0: number; u1: number; v0: number; v1: number; du: number; dv: number; kind: 'move' | 'copy' | 'gone' }
export interface Frame { toPage: (u: number, v: number) => Point; toFrame: (q: Point) => { u: number; v: number } }

export function blocksOf(frame: Frame, width: number, height: number, count: number, far: number, rng: () => number): Block[] {
  const cs = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(frame.toFrame), u0 = Math.min(...cs.map(c => c.u)), u1 = Math.max(...cs.map(c => c.u)), v0 = Math.min(...cs.map(c => c.v)), v1 = Math.max(...cs.map(c => c.v));
  const out: Block[] = [];
  for (let i = 0; i < count; i++) {
    const w = 6 + 70 * rng() ** 2, h = 3 + 34 * rng() ** 2.4, u = u0 + rng() * (u1 - u0 - w), v = v0 + rng() * (v1 - v0 - h), r = rng(), side = rng() < 0.5 ? -1 : 1;
    out.push({ u0: u, u1: u + w, v0: v, v1: v + h, du: side * far * (0.25 + 0.75 * rng()), dv: (rng() < 0.3 ? h * Math.round(rng() * 2 - 1) : 0), kind: r < 0.5 ? 'move' : r < 0.78 ? 'copy' : 'gone' });
  }
  return out;
}

/** A line through the blocks, one after another: the pieces inside each go where it sends them. */
export function throughBlocks(line: Point[], blocks: Block[], frame: Frame): Point[][] {
  let pieces = [line];
  for (const b of blocks) {
    const next: Point[][] = [];
    const inside = (q: Point) => { const c = frame.toFrame(q); return c.u >= b.u0 && c.u <= b.u1 && c.v >= b.v0 && c.v <= b.v1; };
    const shifted = (q: Point) => { const c = frame.toFrame(q); return frame.toPage(c.u + b.du, c.v + b.dv); };
    for (const piece of pieces) {
      if (!piece.some(inside)) { next.push(piece); continue; }
      next.push(...(b.kind === 'copy' ? [piece] : keepAlong(piece, q => !inside(q), 0.15)));
      if (b.kind !== 'gone') for (const run of keepAlong(piece, inside, 0.15)) next.push(run.map(shifted));
    }
    pieces = next;
  }
  return pieces;
}
