import type { Point } from '@hatch3d/plot-core';

/** Family-owned marks in page millimeters; change the rhythm here. */
export function crossingLines(spacing: number, drift: number): Point[][] {
  const lines: Point[][] = [];
  for (let y = 24; y <= 124; y += spacing) {
    lines.push([{ x: 24, y }, { x: 186, y: y + drift }]);
  }
  return lines;
}
