/**
 * Deterministic randomness utilities.
 *
 * Everything that used to reach for Math.random() in the render path now
 * derives from these, keyed on a seed plus a stable identity (line index,
 * cell index, …). Same config + same seed → byte-identical SVG output —
 * a design value borrowed from Krbn (github.com/vpalos/Krbn), where every
 * random decision is keyed on stable stroke identity so nothing "boils"
 * between renders.
 */

/** Deterministic PRNG (mulberry32). Canonical implementation — patch/signals re-exports it. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stateless hash of (seed, identity) → [0, 1).
 *
 * Use instead of rng() when a decision must be stable per item regardless
 * of evaluation order — e.g. "keep line i?" should not change because a
 * different line was filtered first.
 */
export function hash01(seed: number, id: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (id >>> 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
