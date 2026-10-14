import type { Point } from '../../sketch/types.ts';

/**
 * The distance between the two nearest points of two point sets, in the sets' own units (page millimetres): the test of a
 * halo's two sides, since a knockout leaves no mark nearer than its floor and few further than the halo scaled. Exact, and
 * linear enough for tens of thousands of points: `b` sorted by x, each point of `a` searching only the window the best
 * distance so far leaves. `Infinity` when either set is empty. Sample long paths first (a path's points can be far apart).
 */
export function nearestDistance(a: readonly Point[], b: readonly Point[]): number {
  const sorted = [...b].sort((p, q) => p.x - q.x);
  let best = Infinity;
  for (const p of a) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].x < p.x - best) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < sorted.length && sorted[i].x <= p.x + best; i++) best = Math.min(best, Math.hypot(sorted[i].x - p.x, sorted[i].y - p.y));
  }
  return best;
}
