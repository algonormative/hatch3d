/** The fixed 64-step rest patterns the Breach sketches use to break lines and rays into dashes. */

export const RHYTHM_STEPS = 64;

/** 64 seeded booleans, each true with probability `p`: one RNG draw per step. */
export function restPattern(rng: () => number, p: number, steps = RHYTHM_STEPS): boolean[] {
  return Array.from({ length: steps }, () => rng() < p);
}

/**
 * 64 seeded booleans in bars of 8: the last step of each bar is always a rest (and draws nothing from
 * the RNG); every other step is true with probability `p`.
 */
export function barPattern(rng: () => number, p: number, steps = RHYTHM_STEPS, bar = 8): boolean[] {
  return Array.from({ length: steps }, (_, k) => (k % bar !== bar - 1) && rng() < p);
}
