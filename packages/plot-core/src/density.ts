/**
 * Post-projection density limiter.
 *
 * After perspective projection, lines can pile up in foreshortened areas.
 * This module probabilistically removes polylines that pass through
 * overly dense regions of the 2D viewport.
 */

import { hash01 } from "./prng.js";

export interface DensityFilterOptions {
  /** Maximum desired polyline density per cell (default 20) */
  maxDensity: number;
  /** Grid cell size in pixels (default 40) */
  cellSize: number;
  /** Viewport width */
  width: number;
  /** Viewport height */
  height: number;
  /** Seed for the probabilistic keep decision (default 0). Same input + seed → same output. */
  seed?: number;
}

export function filterByProjectedDensity<T extends { x: number; y: number }[]>(
  polylines: T[],
  opts: DensityFilterOptions,
): T[] {
  const kept = filterByProjectedDensityIndices(polylines, opts);
  return kept.map((i) => polylines[i]);
}

/**
 * Same as filterByProjectedDensity but returns the kept indices, so callers
 * carrying per-polyline metadata (width bands, layer ids) can stay aligned.
 */
export function filterByProjectedDensityIndices(
  polylines: { x: number; y: number }[][],
  opts: DensityFilterOptions,
): number[] {
  const { maxDensity, cellSize, width, height, seed = 0 } = opts;
  if (polylines.length === 0) return [];
  if (maxDensity <= 0) return [];

  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const grid = new Uint16Array(cols * rows);

  // Pass 1: count unique polylines per cell
  const polylineCells: Set<number>[] = [];
  for (const pl of polylines) {
    const visited = new Set<number>();
    for (const pt of pl) {
      const col = Math.floor(pt.x / cellSize);
      const row = Math.floor(pt.y / cellSize);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const idx = row * cols + col;
      if (!visited.has(idx)) {
        visited.add(idx);
        grid[idx]++;
      }
    }
    polylineCells.push(visited);
  }

  // Pass 2: for each polyline, compute average density of cells it passes through
  const result: number[] = [];
  for (let i = 0; i < polylines.length; i++) {
    const cells = polylineCells[i];
    if (cells.size === 0) {
      result.push(i);
      continue;
    }

    let totalDensity = 0;
    for (const idx of cells) {
      totalDensity += grid[idx];
    }
    const avgDensity = totalDensity / cells.size;

    if (avgDensity <= maxDensity) {
      result.push(i);
    } else {
      // Deterministically keep: higher density → lower chance. Hashed per
      // line index so a line's fate is independent of the others.
      const keepProb = maxDensity / avgDensity;
      if (hash01(seed, i) < keepProb) {
        result.push(i);
      }
    }
  }

  return result;
}
