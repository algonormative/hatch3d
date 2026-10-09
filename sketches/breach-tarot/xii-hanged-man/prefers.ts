import { preferFit } from '../../kit/format-preference.ts';

/**
 * XII The Hanged Man keeps its vertical framing on a small card: the card is the plumb line, from the top of the window
 * down the helix and the bare thread to the bob and its point in the ring just above the bottom band, and in that
 * framing the bob is at its largest. The leaning towers only lose their outer edges, which the print crops too; in
 * `width` the bob shrinks and floats over open ground. `sketch.ts` imports this module first, so the fit is declared
 * before anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('height');
