import { preferFit } from '../../kit/format-preference.ts';

/**
 * VIII Strength keeps its whole width on a small card: the dam crosses the print from its lower left corner to past its
 * right side, and the coil lies on the lake with open water between it and the print's left edge. Fit by height draws
 * the person and the helix a tenth larger, but pushes the coil to within two millimetres of the window's edge.
 * `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
