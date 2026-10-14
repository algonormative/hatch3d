import { preferFit } from '../../kit/format-preference.ts';

/**
 * X Wheel of Fortune keeps its whole width on a small card: the wheel spans the print from side to side, the rising
 * stub on the rim's left within a few millimetres of the window's edge and the paving round the falling crossing
 * close to its right. In `height` the window loses both: the rim is cut on the left and the paving on the right, so
 * the round wheel is no longer whole. `sketch.ts` imports this module first, so the fit is declared before anything
 * loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
