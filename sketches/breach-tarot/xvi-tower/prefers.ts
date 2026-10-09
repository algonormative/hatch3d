import { preferFit } from '../../kit/format-preference.ts';

/**
 * XVI The Tower keeps its whole width on a small card: the storm and the forked bolt reach both sides of the
 * print, and the paving runs out under them. `sketch.ts` imports this module first, so the fit is declared before
 * anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
