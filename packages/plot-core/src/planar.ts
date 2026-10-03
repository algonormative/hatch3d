import { legacyControlPack } from './legacy-controls.js';
import type { Legacy2DComposition } from './legacy-types.js';
import type { AssetDeclaration, Control, Navigator, Page, Part, Pen, Point, Sketch, SketchContext } from './types.js';
export type { Legacy2DComposition } from './legacy-types.js';
export { legacyControlPack } from './legacy-controls.js';

export interface CanvasSize { width: number; height: number }
export interface Legacy2DOptions {
  composition: Legacy2DComposition;
  page: Page;
  pen: Pen;
  prefix?: string;
  canvas?: CanvasSize;
  defaults?: Record<string, number | boolean | string>;
  assets?: Record<string, AssetDeclaration>;
  imageBindings?: Record<string, string>;
  /** Add ctx.seed to this numeric legacy value after macros are applied. */
  seedValueKey?: string;
  transform?: boolean;
  /** Additional views over the same scalar controls. */
  navigators?: Navigator[];
  /** Physical axis names for a known legacy XY tuple. */
  xyAxisLabels?: Record<string, [string, string]>;
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
const controlId = (prefix: string, key: string): string => `${safe(prefix)}__${key}`;
const number = (ctx: SketchContext, key: string): number => Number(ctx.params[key]);

function canvasFor(page: Page, supplied?: CanvasSize): CanvasSize {
  const contentW = page.width - 2 * (page.margin ?? 0);
  const contentH = page.height - 2 * (page.margin ?? 0);
  const canvas = supplied ?? { width: Math.round(contentW * 3), height: Math.round(contentH * 3) };
  if (!(Number.isFinite(canvas.width) && canvas.width > 0 && Number.isFinite(canvas.height) && canvas.height > 0)) {
    throw new Error('Hatch3d canvas dimensions must be positive finite numbers');
  }
  return canvas;
}

function toMm(path: Point[], page: Page, canvas: CanvasSize): Point[] {
  const margin = page.margin ?? 0;
  const width = page.width - margin * 2;
  const height = page.height - margin * 2;
  const scale = Math.min(width / canvas.width, height / canvas.height);
  const left = margin + (width - canvas.width * scale) / 2;
  const top = margin + (height - canvas.height * scale) / 2;
  return path.map((p) => ({ x: left + p.x * scale, y: top + p.y * scale }));
}

function transform2D(paths: Point[][], ctx: SketchContext, page: Page, prefix: string): Point[][] {
  const tx = number(ctx, controlId(prefix, 'transform__panX'));
  const ty = number(ctx, controlId(prefix, 'transform__panY'));
  const scale = number(ctx, controlId(prefix, 'transform__scale'));
  const radians = number(ctx, controlId(prefix, 'transform__rotation')) * Math.PI / 180;
  const cx = page.width / 2;
  const cy = page.height / 2;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return paths.map((path) => path.map((p) => {
    const x = p.x - cx;
    const y = p.y - cy;
    return { x: cx + tx + scale * (cos * x - sin * y), y: cy + ty + scale * (sin * x + cos * y) };
  }));
}

function transformControls(prefix: string): Control[] {
  const id = (key: string) => controlId(prefix, `transform__${key}`);
  const group = 'Placement / 2D';
  return [
    { type: 'slider', id: id('panX'), label: 'Pan X', default: 0, min: -80, max: 80, step: 1, units: 'mm', group },
    { type: 'slider', id: id('panY'), label: 'Pan Y', default: 0, min: -80, max: 80, step: 1, units: 'mm', group },
    { type: 'slider', id: id('scale'), label: 'Scale', default: 1, min: 0.2, max: 3, step: 0.05, group },
    { type: 'slider', id: id('rotation'), label: 'Rotation', default: 0, min: -180, max: 180, step: 1, units: '°', group },
  ];
}

export interface Hatch3d2DLayer { controls: Control[]; navigators: Navigator[]; draw(ctx: SketchContext): Part; pen: Pen; assets?: Record<string, AssetDeclaration> }
/** Composable 2D adapter for use alongside hand-authored Sketch parts. */
export function createHatch3d2DLayer(options: Legacy2DOptions): Hatch3d2DLayer {
  const prefix = options.prefix ?? safe(options.composition.id);
  const canvas = canvasFor(options.page, options.canvas);
  const legacy = legacyControlPack(options.composition, prefix, options);
  return {
    controls: [...legacy.controls, ...(options.transform === false ? [] : transformControls(prefix))],
    navigators: [
      ...legacy.navigators,
      ...(options.transform === false ? [] : [{ id: controlId(prefix, 'transform__panXY'), label: 'Placement pan', type: 'xy' as const, axes: [controlId(prefix, 'transform__panX'), controlId(prefix, 'transform__panY')] as [string, string], yDirection: 'down' as const }]),
      ...(options.navigators ?? []),
    ],
    pen: options.pen,
    assets: options.assets,
    draw(ctx) {
      const values = legacy.values(ctx.params, ctx.assets, ctx.seed);
      let paths = options.composition.generate({ ...canvas, values }).map((path) => toMm(path, options.page, canvas));
      if (options.transform !== false) paths = transform2D(paths, ctx, options.page, prefix);
      return { id: `${safe(prefix)}-drawing`, pen: options.pen.id, paths: paths.filter((p) => p.length >= 2) };
    },
  };
}

export function createHatch3d2DSketch(options: Legacy2DOptions): Sketch {
  const bundle = createHatch3d2DLayer(options);
  return {
    name: options.composition.name,
    page: options.page,
    pens: [options.pen],
    controls: bundle.controls,
    navigators: bundle.navigators,
    ...(bundle.assets ? { assets: bundle.assets } : {}),
    draw(ctx) { return [bundle.draw(ctx)]; },
  };
}

