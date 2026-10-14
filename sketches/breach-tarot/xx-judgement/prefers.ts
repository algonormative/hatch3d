import { preferFit } from '../../kit/format-preference.ts';

/**
 * XX Judgement keeps its whole width on a small card: the horn comes in at the print's top-left corner as a thin cord,
 * 12 mm inside the window's left edge, and its bell hangs 13 mm inside the right one. Fit `height` crops the print's
 * sides, so the cord starts at the card's left edge, running along under the top band for 21 mm, and the bell's rim
 * comes within half a millimetre of the right edge; in `width` the cord enters at the corner and the bell stands 3.4 mm
 * clear, as on the print. `sketch.ts` imports this module first, so the fit is declared before anything loads the
 * format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
