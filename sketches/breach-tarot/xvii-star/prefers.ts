import { preferFit } from '../../kit/format-preference.ts';

/**
 * XVII The Star keeps its vertical framing on a small card: the star, the streams and the glitter path are a
 * column down the middle, the night at its sides. `sketch.ts` imports this module first, so the fit is declared before
 * anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('height');
