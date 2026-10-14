import type { Fit } from './format.ts';

/**
 * The fit a card prefers on a format other than tabloid, where its render names none: a card whose scene reaches the
 * print's sides (a maze, a storm) keeps its whole width, `width`; one whose scene is a column (the Star) keeps its
 * vertical framing, `height`. An explicit `fit` in the render's format options (`--format '{"fit":…}'`) wins. Tabloid
 * ignores the fit, so its prints are unaffected.
 *
 * `kit/format.ts` lays the format out once, when it loads, so the preference has to be in place before that: a card
 * declares it in a module its `sketch.ts` imports first (`./prefers.ts`, which calls `preferFit`). This module loads
 * nothing else, so importing it never loads the format. Were the order ever wrong in a render, `preferFit` throws
 * rather than let the card draw in the wrong fit.
 */
interface Slot { fit?: Fit; loaded?: { fit: Fit; named: boolean } }
const SLOT = Symbol.for('hatch3d.breach-tarot.preferred-fit');
const registry = globalThis as unknown as Record<symbol, Slot | undefined>;
const slot = (): Slot => (registry[SLOT] ??= {});

/** Declare the card's preferred fit. Call it from the module the card's sketch imports first. */
export function preferFit(fit: Fit): void {
  const loaded = slot().loaded;
  if (loaded && !loaded.named && loaded.fit !== fit) {
    throw new Error(`The card prefers fit '${fit}', but the format had already loaded in fit '${loaded.fit}': import the card's prefers.ts before anything that loads kit/format.ts`);
  }
  slot().fit = fit;
}

/** The preferred fit declared so far, if any. */
export const preferredFit = (): Fit | undefined => slot().fit;

/** `kit/format.ts` only, as it lays out a render's format: the fit it used, and whether the render named it. */
export function formatLoaded(fit: Fit, named: boolean): void {
  slot().loaded = { fit, named };
}
