import { preferFit } from '../../kit/format-preference.ts';

/**
 * 0 The Fool keeps its whole width on a small card: the maze runs out to both sides of the print, and the
 * sun stands near its right edge. `sketch.ts` imports this module first, so the fit is declared before
 * anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
