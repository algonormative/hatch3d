import { preferFit } from '../../kit/format-preference.ts';

/**
 * VII The Chariot keeps its whole width on a small card: the two forces fly in from either side of the print, the pale
 * slabs within a few millimetres of its right edge and their arcs from beyond it, and the road curls in along the ground
 * to the left edge. Fit by height crops both pale slabs and the curl's far end; by width every slab in flight is whole
 * and the ramp, the helix and the unbuilt road keep their places, a tenth smaller. `sketch.ts` imports this module
 * first, so the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('width');
