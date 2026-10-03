import { compositionRegistry } from '../compositions/registry.ts';
import type { Composition3DDefinition, HatchFamily, HatchGroupConfig } from '../compositions/types.ts';
import { SURFACES } from '../surfaces.ts';
import { parseDString } from '../utils/clip.ts';
import { runPipeline } from '../workers/render-pipeline.ts';
import type { RenderRequest } from '../workers/render-worker.types.ts';
import { renderDepthBufferCPU } from './depth-buffer.ts';
import { hatchGroupPack, legacyControlPack } from './hatch3d-controls.ts';
import { createHatch3d2DLayer } from '../../packages/plot-core/src/planar.ts';
import type { Legacy2DOptions, CanvasSize } from '../../packages/plot-core/src/planar.ts';
export { createHatch3d2DLayer, createHatch3d2DSketch } from '../../packages/plot-core/src/planar.ts';
export type { Legacy2DOptions, CanvasSize, Hatch3d2DLayer } from '../../packages/plot-core/src/planar.ts';
import type { Control, Navigator, Page, Part, Pen, Point, Sketch, SketchContext } from './types.ts';

export interface Legacy3DOptions {
  composition: Composition3DDefinition;
  page: Page;
  pen: Pen;
  prefix?: string;
  canvas?: CanvasSize;
  defaults?: Record<string, number | boolean | string>;
  surfaceKey?: string;
  surfaceParams?: Record<string, number>;
  /** Override defaults for the native hatch/camera/occlusion controls. */
  viewDefaults?: Record<string, number | boolean | string>;
  /** Additional views over the same scalar controls. */
  navigators?: Navigator[];
  /** Physical axis names for a known legacy XY tuple. */
  xyAxisLabels?: Record<string, [string, string]>;
  /** Optional independent paper-space composition, emitted as a separate pen part. */
  paper?: Omit<Legacy2DOptions, 'page'>;
}

const familyOptions: HatchFamily[] = ['u', 'v', 'diagonal', 'rings', 'hex', 'crosshatch', 'spiral'];
const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
const controlId = (prefix: string, key: string): string => `${safe(prefix)}__${key}`;
const number = (ctx: SketchContext, key: string): number => Number(ctx.params[key]);
const bool = (ctx: SketchContext, key: string): boolean => ctx.params[key] === true;
const string = (ctx: SketchContext, key: string): string => String(ctx.params[key]);

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

function threeDControls(prefix: string, defaults: Record<string, number | boolean | string> = {}): Control[] {
  const id = (key: string) => controlId(prefix, `view__${key}`);
  const slider = (key: string, label: string, value: number, min: number, max: number, step: number, group: string): Control =>
    ({ type: 'slider', id: id(key), label, default: value, min, max, step, group });
  const controls: Control[] = [
    { type: 'select', id: id('hatchFamily'), label: 'Hatch family', default: 'u', options: familyOptions, group: 'Hatching' },
    slider('hatchCount', 'Count', 24, 5, 80, 1, 'Hatching'),
    slider('hatchSamples', 'Samples', 40, 10, 120, 1, 'Hatching'),
    { ...slider('hatchAngle', 'Angle (diagonal / crosshatch)', 0.7, 0, 3.14, 0.01, 'Hatching'), units: 'rad' },
    { type: 'toggle', id: id('useOcclusion'), label: 'Hidden-line removal', default: true, group: 'Occlusion' },
    { ...slider('depthRes', 'Depth resolution', 256, 128, 1024, 64, 'Occlusion'), showWhen: { control: id('useOcclusion'), equals: true } },
    { ...slider('depthBias', 'Depth bias', 0.001, 0.0001, 0.005, 0.0001, 'Occlusion'), showWhen: { control: id('useOcclusion'), equals: true } },
    { type: 'toggle', id: id('showMesh'), label: 'Show mesh diagnostic', default: false, group: 'Display' },
    { type: 'select', id: id('projection'), label: 'Projection', default: 'perspective', options: ['perspective', 'orthographic'], group: 'Camera' },
    slider('camDist', 'Distance', 8, 1, 25, 0.1, 'Camera'),
    slider('camTheta', 'Theta', 0.6, -3.14, 3.14, 0.01, 'Camera'),
    slider('camPhi', 'Phi', 0.35, -1.55, 1.55, 0.01, 'Camera'),
    slider('panX', 'Camera pan X', 0, -10, 10, 0.1, 'Camera'),
    slider('panY', 'Camera pan Y', 0, -10, 10, 0.1, 'Camera'),
  ];
  for (const [key, value] of Object.entries(defaults)) {
    const control = controls.find((item) => item.id === id(key));
    if (!control) throw new Error(`Unknown 3D view default ${key}`);
    (control as { default: number | boolean | string }).default = value;
  }
  return controls;
}

let registrationNumber = 0;
function registerPrivateComposition(comp: Composition3DDefinition): string {
  let key: string;
  do { key = `sketch_hatch3d_${++registrationNumber}_${safe(comp.id)}`; } while (compositionRegistry.has(key));
  compositionRegistry.register({ ...comp, id: key });
  return key;
}

function pathsFromSvg(svgPaths: string[], page: Page, canvas: CanvasSize): Point[][] {
  return svgPaths.map((path) => {
    const points = parseDString(path);
    if (/Z\s*$/i.test(path) && points.length >= 3) points.push({ ...points[0] });
    return toMm(points, page, canvas);
  }).filter((path) => path.length >= 2);
}

export function createHatch3d3DSketch(options: Legacy3DOptions): Sketch {
  const prefix = options.prefix ?? safe(options.composition.id);
  const canvas = canvasFor(options.page, options.canvas);
  const legacy = legacyControlPack(options.composition, prefix, { defaults: options.defaults, xyAxisLabels: options.xyAxisLabels });
  const hatchGroups = hatchGroupPack(options.composition.hatchGroups, prefix);
  const paper = options.paper ? createHatch3d2DLayer({ ...options.paper, page: options.page, prefix: options.paper.prefix ?? `${prefix}_paper` }) : undefined;
  if (paper && options.paper!.pen.id === options.pen.id) throw new Error('Mixed 2D and 3D parts need distinct pen ids');
  const key = registerPrivateComposition(options.composition);
  const controls = [...legacy.controls, ...hatchGroups.controls, ...threeDControls(prefix, options.viewDefaults), ...(paper?.controls ?? [])];
  const ids = new Set<string>();
  for (const control of controls) {
    if (ids.has(control.id)) throw new Error(`Duplicate sketch control ${control.id}`);
    ids.add(control.id);
  }
  const id = (name: string) => controlId(prefix, `view__${name}`);
  return {
    name: paper ? `${options.composition.name} + ${options.paper!.composition.name}` : options.composition.name,
    page: options.page,
    pens: [options.pen, ...(paper ? [options.paper!.pen] : [])],
    controls,
    navigators: [
      ...legacy.navigators,
      { id: controlId(prefix, 'view__panXY'), label: 'Camera pan', type: 'xy', axes: [controlId(prefix, 'view__panX'), controlId(prefix, 'view__panY')], yDirection: 'up' },
      ...(paper?.navigators ?? []),
      ...(options.navigators ?? []),
    ],
    ...(paper?.assets ? { assets: paper.assets } : {}),
    draw(ctx) {
      const hatchParams = {
        family: string(ctx, id('hatchFamily')),
        count: number(ctx, id('hatchCount')),
        samples: number(ctx, id('hatchSamples')),
        angle: number(ctx, id('hatchAngle')),
      };
      const camera = {
        theta: number(ctx, id('camTheta')),
        phi: number(ctx, id('camPhi')),
        dist: number(ctx, id('camDist')),
        ortho: string(ctx, id('projection')) === 'orthographic',
        panX: number(ctx, id('panX')),
        panY: number(ctx, id('panY')),
        ...canvas,
      };
      const surfaceKey = options.surfaceKey ?? 'torus';
      const surface = SURFACES[surfaceKey];
      if (!surface) throw new Error(`Unknown hatch3d surface ${surfaceKey}`);
      const req: RenderRequest = {
        type: 'render', id: 0, compositionKey: key, is2d: false, ...canvas,
        resolvedValues: legacy.values(ctx.params, ctx.assets, ctx.seed),
        surfaceKey, surfaceParams: { ...surface.defaults, ...options.surfaceParams },
        hatchParams, currentHatchGroups: hatchGroups.values(ctx.params) as Record<string, HatchGroupConfig>,
        camera, useOcclusion: bool(ctx, id('useOcclusion')),
        depthRes: number(ctx, id('depthRes')), depthBias: number(ctx, id('depthBias')),
        exportLayout: { contentW: canvas.width, contentH: canvas.height, scale: 1 },
        showMesh: bool(ctx, id('showMesh')),
        densityFilterEnabled: false, densityMax: 0, densityCellSize: 1,
        seed: ctx.seed,
      };
      const result = runPipeline(req, renderDepthBufferCPU);
      const parts: Part[] = [{ id: `${safe(prefix)}-solids`, pen: options.pen.id, paths: pathsFromSvg(result.svgPaths, options.page, canvas) }];
      if (paper) parts.push(paper.draw(ctx));
      if (req.showMesh) parts.push({ id: `${safe(prefix)}-mesh`, pen: options.pen.id, paths: pathsFromSvg(result.meshPaths, options.page, canvas), diagnostic: true });
      return parts;
    },
  };
}
