import { preferFit } from '../../kit/format-preference.ts';

/**
 * III The Empress keeps its whole width on a small card: the crop is a field that runs out past both sides of the
 * print, and the wind is one long S from the left edge to the right. Fit `height` crops a tenth off the sides, which
 * cuts the S's first rise and the outer rows; the blocks it buys are only a ninth larger. `sketch.ts` imports this
 * module first, so the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('width');
