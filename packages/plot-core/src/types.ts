import type { GuideOptions } from './assembly.js';

/** Public contract for a single executable sketch. Coordinates and widths are millimeters. */
export interface Point { x: number; y: number }

export interface Page {
  width: number;
  height: number;
  margin?: number;
  paper?: string;
}

export interface Pen { id: string; color: string; width: number; passes?: number }

/** Optional physical finishing applied after draw() and before final SVG assembly. */
export interface FinishingOptions {
  page?: Page;
  /** `lineGap`: a double border's distance between its two lines, in millimetres (default `DOUBLE_BORDER_INSET`, 2). */
  border?: { style: 'simple' | 'double' | 'ticked' | 'cropmarks'; pen: string; inset?: number; contentGap?: number; lineGap?: number };
  pens?: Record<string, { color?: string; width?: number; passes?: number }>;
  density?: { maxDensity: number; cellSize: number };
}

export interface ControlPresentation {
  group?: string;
  showWhen?: { control: string; equals: string | number | boolean };
}

export type Control =
  | (ControlPresentation & { type: 'slider'; id: string; label: string; default: number; min: number; max: number; step: number; units?: string; expensive?: boolean })
  | (ControlPresentation & { type: 'toggle'; id: string; label: string; default: boolean; units?: string; expensive?: boolean })
  | (ControlPresentation & { type: 'select'; id: string; label: string; default: string; options: string[]; optionLabels?: Record<string, string>; units?: string; expensive?: boolean })
  | (ControlPresentation & { type: 'text'; id: string; label: string; default: string; maxLength: number; units?: string; expensive?: boolean });

export interface Box { x: number; y: number; width: number; height: number }
export interface AssetDeclaration { path: string; box: Box; fit: 'contain' | 'cover' }

export interface RasterAsset {
  width: number;
  height: number;
  brightness: Float32Array;
  box: Box;
  fit: 'contain' | 'cover';
  /** White/paper outside the placed image. Coordinates are page millimeters. */
  sample(xMm: number, yMm: number): number;
}

export type Params = Record<string, number | boolean | string>;
/** Direct views over existing numeric sliders; axis order is horizontal/vertical for XY and X/Y/Z for XYZ. */
export type Navigator =
  | { id: string; label: string; type?: 'radar'; axes: string[] }
  | { id: string; label: string; type: 'xy'; axes: [string, string]; yDirection?: 'up' | 'down'; axisLabels?: [string, string] }
  | { id: string; label: string; type: 'xyz'; axes: [string, string, string]; axisLabels?: [string, string, string] };
/** Amount is target slider units per full normalized travel of the source control. */
export interface Macro { control: string; targets: { control: string; amount: number }[] }
export interface SketchContext {
  params: Params;
  seed: number;
  assets: Record<string, RasterAsset>;
  /**
   * The page this render draws on. For a `pageAware` sketch it is the requested `finishing.page` over the
   * declared page (see `targetPage`); for any other sketch it is the declared page. Hosts that predate it, and
   * tests that call `draw()` directly, may leave it out: read it as the declared page then.
   */
  page?: Page;
  /** Independent deterministic stream for one named part. */
  random(partId: string): () => number;
}

export interface Part {
  id: string;
  pen: string;
  paths: Point[][];
  /** Preservation metadata: first polygon is the outer region, later polygons are holes. Draw code clips its own regions. */
  boundary?: Point[][];
  /** Returned for inspection, excluded from canonical SVG and plot statistics. */
  diagnostic?: boolean;
}

/**
 * One ply of an assembly: a physical sheet of one paper, plotted as its own SVG job and then knife-cut. `pens` are the
 * pens its art may use (declared pens, by id). `cutInk` is the pen this ply's cut guides are inked with: the guides
 * themselves are emitted on the assembly's `cutPen` layer, and the host (finalize) inks that layer for this ply in
 * `cutInk`'s colour and width, so `cutInk`'s width is what the guide geometry is sized by (the outline sits half of it
 * inside the waste, the X marks keep clear of it).
 * `bleed` overrides the assembly's for the windows cut in this ply; `lift` is carried for the host and not read by plot-core.
 * An `onlay` is not a full sheet but a piece glued on top, plotted and cut elsewhere: `from` is free text naming its
 * source (such as `"lintel-l/black/bar"`) and the world's one `footprint` cut for the ply is its outline as placed. It
 * is never rendered here; the ply directly below it gets placement marks, and the plies below see through whatever
 * the piece does not cover. Its `pens` may be empty, and a signature cannot sit on it.
 */
export interface PlySpec { id: string; paper: { id: string; color: string }; pens: string[]; cutInk: string; bleed?: number; lift?: number; onlay?: { from: string } }

/**
 * Several plies stacked into one artwork. `plies` runs bottom to top; a window cut in an upper ply shows the ply
 * below. `control` is the id of the select control (options = the ply ids, bottom to top) that picks the ply a render
 * is. Art is kept `margin` mm away from its own ply's cuts and, on the ply below a window, extends `bleed` mm under the
 * window's edge. `cutPen` is the declared pen id of the layer that cut guides, placement marks and the `asm-*`
 * diagnostics are emitted on. It names a layer, not an ink: the host inks that layer in the colour and width of the
 * ply's own `cutInk`. A `signature` keeps its `box` empty of art on `ply`, for the signing pen to fill.
 */
export interface AssemblySpec { control: string; plies: PlySpec[]; cutPen: string; margin: number; bleed: number;
  signature?: { ply: string; pen: string; box: Box } }

/**
 * A cut in a ply. `rings` is the even-odd area. By default (`kind: 'waste'`) it is a window: the paper inside is thrown
 * away, so an outer ring with a hole keeps only the hole's inside (a "shaped ply"). A `'part'` is cut out and kept
 * (glued elsewhere), so the ply's art survives on both sides of its line; plies below still see through it. A
 * `'footprint'` is the outline of an onlay ply's piece as placed, and appears only on onlay plies.
 */
export interface Cut { id: string; rings: Point[][]; label?: string; kind?: 'waste' | 'part' | 'footprint';
  /**
   * Guide options for this cut alone, merged over the defaults and the options `renderPly` was given (the pen width is
   * always the ply's cut ink's). Only a window (`waste`) has X marks and a label to size; a part's guide is its outline
   * and a footprint has none, so they ignore it.
   */
  guide?: Partial<Omit<GuideOptions, 'penWidth'>> }
/** Cuts by ply id. */
export type Cuts = Record<string, Cut[]>;

export interface Sketch {
  name: string;
  /** The declared page. A `pageAware` sketch treats it as the default and draws on `ctx.page`. */
  page: Page;
  /**
   * Opt in to drawing on the page a render asks for. With `finishing.page` set, a page-aware sketch draws on
   * that page (`ctx.page`) and finishing does not rescale it; any other sketch draws on its declared page and
   * finishing fits it uniformly onto the requested one. Not part of the metadata, so render identities don't move.
   */
  pageAware?: boolean;
  /**
   * Opt in to assembly: one artwork made from several plies of different paper. The sketch draws the whole world on
   * every render (the same seed gives the same world), a select control (`assembly.control`) picks which ply this
   * render is, and `renderPly` clips the art to what that ply shows and adds its cut guides. Validated by
   * `validateSketch`, but not part of the metadata, so render identities don't move.
   */
  assembly?: AssemblySpec;
  pens: Pen[];
  controls: Control[];
  navigators?: Navigator[];
  macros?: Macro[];
  assets?: Record<string, AssetDeclaration>;
  draw(ctx: SketchContext): Part[] | Promise<Part[]>;
}

export interface AssetMetadata extends AssetDeclaration {
  dataUrl: string;
  width: number;
  height: number;
}

export interface SketchMetadata {
  name: string;
  page: Page;
  sourcePage?: Page;
  pens: Pen[];
  controls: Control[];
  navigators?: Navigator[];
  macros?: Macro[];
  assets: Record<string, AssetMetadata>;
}

export interface Diagnostic {
  level: 'warning' | 'error';
  code: string;
  message: string;
  partId?: string;
}

export interface RenderStats {
  pathCount: number;
  pointCount: number;
  lengthMm: number;
  partCount: number;
}

/** Options a sketch's format module reads from the render target, e.g. `{ fit: 'width' }`. Flat JSON values only. */
export type FormatOptions = Record<string, string | number | boolean>;

export interface RenderResult {
  schemaVersion: 1;
  metadata: SketchMetadata;
  finishing?: FinishingOptions;
  /** Present only when the request carried format options; part of the identity then. */
  format?: FormatOptions;
  params: Params;
  /** Values passed to draw(); present only for sketches declaring macros. */
  effectiveParams?: Params;
  seed: number;
  parts: Part[];
  svg: string;
  identity: string;
  diagnostics: Diagnostic[];
  stats: RenderStats;
  durationMs: number;
}
