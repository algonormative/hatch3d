import { preferFit } from '../../kit/format-preference.ts';

/**
 * XXI The World keeps its whole width on a small card: the labyrinth is the reading, and on the print its rim spans the
 * card's width with its lunations whole. In `height` the window crops the print's sides, and the rim's outer circuit and
 * its wreath are cut by the card's edge; in `width` the whole labyrinth stands in the window, path and rim, with paper
 * either side. `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
