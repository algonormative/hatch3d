import { preferFit } from '../../kit/format-preference.ts';

/**
 * IX The Hermit keeps its vertical framing on a small card: the reading is the hermit and his lantern's pool high on the
 * summit, and in that framing they are at their largest (the hermit about 9 mm tall at 70 × 120). The scene loses only
 * the plain's outer edges, where nothing stands; in `width` the summit and the pool shrink and more empty ground opens
 * below. `sketch.ts` imports this module first, so the fit is declared before anything loads the format (see
 * kit/format-preference.ts); an explicit `--format '{"fit":…}'` still wins.
 */
preferFit('height');
