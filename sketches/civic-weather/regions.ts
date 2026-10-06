import type { Point } from '../../src/sketch/types.ts';

/** Millimeter-space authored placement; rings remain fixed across mark edits. */
export const arcadeOuter: Point[] = [
  { x: 36, y: 58 }, { x: 180, y: 58 }, { x: 180, y: 114 }, { x: 36, y: 114 },
];

function archHole(left: number): Point[] {
  const radius = 9.5;
  const center = left + radius;
  const points: Point[] = [{ x: left, y: 114 }, { x: left, y: 86 }];
  for (let i = 0; i <= 20; i++) {
    const angle = Math.PI - (Math.PI * i) / 20;
    points.push({ x: center + radius * Math.cos(angle), y: 86 - 11 * Math.sin(angle) });
  }
  points.push({ x: left + radius * 2, y: 114 });
  return points;
}

export const archHoles: Point[][] = [48, 73, 98, 123, 148].map(archHole);
export const arcadeRings: Point[][] = [arcadeOuter, ...archHoles];

export const towerOuter: Point[] = [
  { x: 39, y: 31 }, { x: 73, y: 31 }, { x: 73, y: 35 },
  { x: 69, y: 35 }, { x: 69, y: 58 }, { x: 43, y: 58 },
  { x: 43, y: 35 }, { x: 39, y: 35 },
];
export const towerSlots: Point[][] = [
  [{ x: 50, y: 40 }, { x: 54, y: 40 }, { x: 54, y: 51 }, { x: 50, y: 51 }],
  [{ x: 60, y: 40 }, { x: 64, y: 40 }, { x: 64, y: 51 }, { x: 60, y: 51 }],
];
export const towerRings: Point[][] = [towerOuter, ...towerSlots];

export const skyBoundary: Point[][] = [[
  { x: 12, y: 17 }, { x: 198, y: 17 }, { x: 198, y: 87 }, { x: 12, y: 87 },
]];
export const foregroundBoundary: Point[][] = [[
  { x: 12, y: 113 }, { x: 198, y: 113 }, { x: 198, y: 136 },
  { x: 12, y: 136 },
]];

export function closed(ring: Point[]): Point[] {
  return [...ring, { ...ring[0] }];
}
