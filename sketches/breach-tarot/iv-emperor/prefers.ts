import { preferFit } from '../../kit/format-preference.ts';

/**
 * IV The Emperor keeps its whole width on a small card: the throne stands right of centre with its high back
 * almost on the print's right rule, a strip of ruled sky beside it, and the avenue's rows run out at both sides.
 * Fit to the height, the card crops the back slab and the right armrest and the throne no longer stands whole.
 * `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
