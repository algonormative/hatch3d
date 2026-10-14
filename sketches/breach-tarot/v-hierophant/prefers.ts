import { preferFit } from '../../kit/format-preference.ts';

/**
 * V The Hierophant keeps its whole width on a small card: the wall runs from off one side of the print to short of
 * the other, where the horizon shows, and the V the thread opens into reaches within a few millimetres of that open
 * side. Fit by height crops both, and the V's arms have to stop short to keep their tips inside the window.
 * `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
