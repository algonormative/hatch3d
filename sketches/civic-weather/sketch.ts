import type { Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { hatchRegion } from '../../src/patch/region-hatch.ts';
import { clipPolylinesToSilhouette } from '../../src/operators/silhouette-knockout.ts';
import {
  arcadeOuter, arcadeRings, towerOuter, towerRings,
  skyBoundary, foregroundBoundary, closed,
} from './regions.ts';

const INK = 'slate';
const CURRENT = 'tide';
const architectureAngle = -56;

function number(ctx: SketchContext, id: string): number {
  return ctx.params[id] as number;
}

function midpoint(path: Point[]): Point {
  const a = path[0];
  const b = path[path.length - 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The authored raster's warm shadow decides which interleaved hatch rows survive. */
function masonry(ctx: SketchContext, rings: Point[][], pitch: number): Point[][] {
  const subPitch = pitch / 2;
  const a = architectureAngle * Math.PI / 180;
  return hatchRegion(rings, architectureAngle, subPitch).filter((path) => {
    const m = midpoint(path);
    const lane = Math.round((-Math.sin(a) * m.x + Math.cos(a) * m.y) / subPitch);
    if (lane % 2 === 0) return true;
    const darkness = 1 - ctx.assets.reference.sample(m.x, m.y);
    return darkness > 0.34;
  });
}

function fieldPath(yBase: number, bend: number, bias: number, disturbance: number): Point[] {
  const path: Point[] = [];
  for (let x = 13; x <= 197; x += 2) {
    const phase = (x - 13) / 184;
    const local = Math.exp(-(((x - 117) / 23) ** 2));
    const y = yBase
      + bend * Math.sin(Math.PI * phase)
      + bias * (x - 102) / 52
      + disturbance * local * Math.sin((x - 102) / 8);
    path.push({ x, y });
  }
  return path;
}

function skyPaths(ctx: SketchContext): Point[][] {
  const bias = number(ctx, 'windBias');
  const paths = Array.from({ length: 8 }, (_, i) =>
    fieldPath(22 + i * 6.7, 1.7, bias, i > 3 ? 0.6 : 0));
  const inside = clipPolylinesToSilhouette(paths, skyBoundary, 'inside');
  return clipPolylinesToSilhouette(inside, [arcadeOuter, towerOuter], 'outside');
}

function foregroundPaths(ctx: SketchContext): Point[][] {
  const pitch = number(ctx, 'foregroundPitch');
  const bend = number(ctx, 'foregroundBend');
  const omission = number(ctx, 'omission');
  const random = ctx.random('foreground-currents');
  const paths: Point[][] = [];
  for (let lane = 0, y = 114.5; y < 137; lane++, y = 114.5 + lane * pitch) {
    const source = fieldPath(y, bend * (0.55 + lane * 0.08), number(ctx, 'windBias') * 0.28, bend * 0.48)
      .map((point) => {
        // The current narrows beneath the fourth arch, then recovers its spacing.
        const focus = Math.exp(-(((point.x - 136) / 19) ** 2));
        return { x: point.x, y: 126 + (point.y - 126) * (1 - 0.5 * focus) };
      });
    let segment: Point[] = [];
    for (let i = 0; i < source.length; i++) {
      // Short rests yield a broken current; their named stream never touches sky or masonry.
      if (i % 9 === 0 && random() < omission) {
        if (segment.length >= 2) paths.push(segment);
        segment = [];
      }
      segment.push(source[i]);
    }
    if (segment.length >= 2) paths.push(segment);
  }
  return clipPolylinesToSilhouette(paths, foregroundBoundary, 'inside');
}

const sketch: Sketch = {
  name: 'Civic weather — first study',
  page: { width: 210, height: 148, margin: 12, paper: '#f7f4ed' },
  pens: [
    { id: INK, color: '#344044', width: 0.25 },
    { id: CURRENT, color: '#5c7f87', width: 0.35 },
  ],
  controls: [
    { type: 'slider', id: 'architecturePitch', label: 'Masonry pitch', default: 2.35, min: 1.5, max: 3.5, step: 0.05, units: 'mm' },
    { type: 'slider', id: 'foregroundPitch', label: 'Current pitch', default: 2.6, min: 1.7, max: 4, step: 0.1, units: 'mm' },
    { type: 'slider', id: 'foregroundBend', label: 'Current bend', default: 3.8, min: 0, max: 7, step: 0.2, units: 'mm' },
    { type: 'slider', id: 'windBias', label: 'Wind bias', default: -0.35, min: -1, max: 1, step: 0.05 },
    { type: 'slider', id: 'omission', label: 'Current rests', default: 0.12, min: 0, max: 0.45, step: 0.01 },
  ],
  assets: { reference: { path: 'reference.png', box: { x: 0, y: 0, width: 210, height: 148 }, fit: 'contain' } },
  draw(ctx) {
    const pitch = number(ctx, 'architecturePitch');
    return [
      { id: 'sky-currents', pen: CURRENT, paths: skyPaths(ctx), boundary: skyBoundary },
      { id: 'arcade', pen: INK, paths: [closed(arcadeOuter), ...arcadeRings.slice(1).map(closed), ...masonry(ctx, arcadeRings, pitch)], boundary: arcadeRings },
      { id: 'tower', pen: INK, paths: [closed(towerOuter), ...towerRings.slice(1).map(closed), ...masonry(ctx, towerRings, pitch)], boundary: towerRings },
      { id: 'foreground-currents', pen: CURRENT, paths: foregroundPaths(ctx), boundary: foregroundBoundary },
    ];
  },
};

export default sketch;
