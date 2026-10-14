import { preferFit } from '../../kit/format-preference.ts';

/**
 * XIII Death keeps its vertical framing on a small card: the singularity and the helix standing on it are the card, and
 * fit height draws them a tenth larger than fit width does. The nave's walls run on past both sides of the print, so
 * cropping them loses nothing that reads; fit width shows more above and below instead, where a near slab's edge comes
 * to lie along the top rule (the print starts its lintels at the third bay to keep them off it). `sketch.ts` imports this
 * module first, so the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('height');
