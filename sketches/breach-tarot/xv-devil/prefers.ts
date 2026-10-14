import { preferFit } from '../../kit/format-preference.ts';

/**
 * XV The Devil keeps its full width on a small card: the reading runs edge to edge (a door at each side of the card,
 * swung open, its leaf out toward the eye, a figure in each doorway, the pillar between). In `height` the window crops
 * the sides, and each door's open leaf runs into the card's edge; in `width` both doors stand whole and mirrored inside
 * the window, as on the print, for a scene a tenth smaller. `sketch.ts` imports this module first, so the fit is declared
 * before anything loads the format (see kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('width');
