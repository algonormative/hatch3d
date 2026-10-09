import { preferFit } from '../../kit/format-preference.ts';

/**
 * XIX The Sun keeps its whole width on a small card: the sun's rays reach out level to either side, and in its width they
 * stand whole inside the window as on the print, where fit height runs them into the card's edges; the wall runs off
 * both sides with its breach where the print has it. `sketch.ts` imports this module first, so the fit is declared before
 * anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
