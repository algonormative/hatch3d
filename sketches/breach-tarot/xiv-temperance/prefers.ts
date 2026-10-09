import { preferFit } from '../../kit/format-preference.ts';

/**
 * XIV Temperance keeps its whole width on a small card: the pour spans the print from the near vessel's spill on the
 * left to the far vessel's spill on the right, 9 mm inside the print's right edge, and its arc's crown comes within
 * 3 mm of the window's top. Fit `height` cuts the far spill at the window's right edge and the crown at its top, so the
 * pour no longer spills whole at both rims; in `width` both stay inside, 2.4 mm clear of the right edge and 5.5 mm
 * under the top. `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
