import type { FormatOptions, Page } from './types.js';

/**
 * The render target: the page a render asked for (its `finishing.page`) and any format options, as the render
 * host published them before importing the sketch module.
 *
 * A page-aware sketch (`Sketch.pageAware`) draws on the page it is rendered at instead of being rescaled onto
 * it. Modules that lay themselves out when they load (a format module computing a card rect, a depth raster, a
 * pitch scale) need that page before any of the sketch's code runs, so the host publishes the target once,
 * before `import()`. Each render runs in its own process, which makes this module-level state safe. The slot
 * lives on `globalThis` under a registered symbol, so a bundled host and source-loaded sketch modules share it
 * even when each carries its own copy of this file.
 *
 * Outside a render host (a test importing a sketch directly, `inspect`) nothing is published and every reader
 * falls back to its default.
 *
 * A module that shaped itself to a target other than its default calls `adoptRenderTarget()`. The host checks
 * this after import: a sketch that has not declared `pageAware` but whose modules adopted the target is rendered
 * again in a fresh process with nothing published, so a legacy sketch sharing those modules keeps drawing on its
 * own page and being fitted by finishing, exactly as before.
 */
export interface RenderTarget {
  /** The requested page, as sent in `finishing.page`. */
  page?: Partial<Page> & { width: number; height: number };
  /** Options for the sketch's format module. */
  format?: FormatOptions;
}

const SLOT = Symbol.for('hatch3d.render-target');
interface Slot { target: RenderTarget; adopted: boolean }
const registry = globalThis as unknown as Record<symbol, Slot | undefined>;

/** Host only: publish the target before importing the sketch module. Once per process. */
export function publishRenderTarget(target: RenderTarget): void {
  if (registry[SLOT]) throw new Error('A render target is already published in this process');
  registry[SLOT] = { target: structuredClone(target), adopted: false };
}

/** The published target, or an empty one outside a render host. */
export function renderTarget(): RenderTarget {
  return structuredClone(registry[SLOT]?.target ?? {});
}

/** Called by a module that shaped itself to a target other than its default. */
export function adoptRenderTarget(): void {
  const slot = registry[SLOT];
  if (slot) slot.adopted = true;
}

/** Host only: whether any module adopted the published target. */
export function renderTargetAdopted(): boolean {
  return registry[SLOT]?.adopted ?? false;
}

/**
 * The page a page-aware sketch draws on: the requested width and height, and its paper when given. The margin
 * is the requested one when given; otherwise the declared margin scales with the page (by the smaller of the two
 * axis ratios, to 0.001 mm), so an 18 mm tabloid margin becomes about 4.5 mm on a 70 × 120 mm card.
 * Without a request it is the declared page itself.
 */
export function targetPage(declared: Page, requested?: RenderTarget['page']): Page {
  if (!requested) return declared;
  const ratio = Math.min(requested.width / declared.width, requested.height / declared.height);
  const margin = requested.margin ?? (declared.margin === undefined ? undefined : Math.round(declared.margin * ratio * 1000) / 1000);
  return {
    ...declared,
    width: requested.width,
    height: requested.height,
    ...(margin === undefined ? {} : { margin }),
    ...(requested.paper === undefined ? {} : { paper: requested.paper }),
  };
}
