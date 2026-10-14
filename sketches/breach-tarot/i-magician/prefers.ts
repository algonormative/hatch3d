import { preferFit } from '../../kit/format-preference.ts';

/**
 * I The Magician keeps its whole width on a small card: the print's frame is the slab cluster down its left edge (the
 * pillar and the long bar over the top) and the blocks tumbling out to both sides, and the height fit crops the pillar
 * to a fragment. The figure, its flame and the lemniscate stay in the middle either way, a tenth smaller in this fit.
 * `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
