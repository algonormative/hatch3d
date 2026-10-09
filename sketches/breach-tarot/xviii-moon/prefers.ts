import { preferFit } from '../../kit/format-preference.ts';

/**
 * XVIII The Moon keeps its whole width on a small card: the near tower stands at the print's left edge and the dog's
 * stakes reach toward its right, and fit height cuts the one and runs the other into the card's edge. `sketch.ts` imports
 * this module first, so the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('width');
