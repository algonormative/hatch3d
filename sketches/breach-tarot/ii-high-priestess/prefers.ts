import { preferFit } from '../../kit/format-preference.ts';

/**
 * II The High Priestess keeps her vertical framing on a small card: the temple stands well inside the print's sides,
 * so `height` crops only open sky and floor there, keeps the lintel just under the top band as the print has it, and
 * draws the temple a ninth larger than `width`, which adds a band of empty sky above it. `sketch.ts` imports this
 * module first, so the fit is declared before anything loads the format (see kit/format-preference.ts); an explicit
 * `--format '{"fit":…}'` still wins.
 */
preferFit('height');
