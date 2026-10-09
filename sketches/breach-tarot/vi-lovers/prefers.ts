import { preferFit } from '../../kit/format-preference.ts';

/**
 * VI The Lovers keeps its vertical framing on a small card: the reading is small (the lovers' hands a breath apart,
 * their shadows on the ground, the two strands winding round each other overhead), and in that framing the lovers, the
 * gap between their hands and the helix are at their largest, a tenth larger than in `width`. Both towers still stand
 * whole in the window; only the open sky and ground beyond them are cropped. `sketch.ts` imports this module first, so
 * the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('height');
