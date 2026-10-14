import { preferFit } from '../../kit/format-preference.ts';

/**
 * XI Justice keeps its whole width on a small card: it is the set's frontal card, and its beam runs nearly the
 * width of the print, the long arm's pan and its one small block near the edge. In `height` the window crops the
 * print's sides, and that pan and block are cut by the card's edge (the heap's, on a mirrored seed); in `width` the
 * balance stands whole, as on the print, with paper either side. `sketch.ts` imports this module first, so the fit is
 * declared before anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
