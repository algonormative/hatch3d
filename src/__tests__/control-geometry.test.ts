import { describe, expect, it } from 'vitest';
import {
  CUBE_AXIS_TIPS, CUBE_EDGES, CUBE_VERTICES, cubeAxisOpacity, cubeEdgeOpacity,
  cubeProjectedBasis, denormalizeXY, normalizeXY, projectCubePoint, solveCubePlaneDelta,
} from '../controls/geometry.js';

// Independent transcription of OrbitCube's original X-then-Y rotation and projection.
function originalProject(x: number, y: number, z: number, theta: number, phi: number, size: number) {
  const y1 = y * Math.cos(phi) - z * Math.sin(phi);
  const z1 = y * Math.sin(phi) + z * Math.cos(phi);
  const x2 = x * Math.cos(theta) + z1 * Math.sin(theta);
  const z2 = -x * Math.sin(theta) + z1 * Math.cos(theta);
  const scale = size * 0.28;
  return { x: size / 2 + x2 * scale, y: size / 2 - y1 * scale, z: z2 };
}

describe('shared control geometry', () => {
  it.each([[0.6, 0.35], [-1.1, 0.9]])('preserves OrbitCube projection at theta %s phi %s', (theta, phi) => {
    expect(CUBE_VERTICES).toHaveLength(8);
    expect(CUBE_EDGES).toHaveLength(12);
    expect(CUBE_AXIS_TIPS.map((tip) => tip.label)).toEqual(['X', 'Y', 'Z']);
    for (const point of [...CUBE_VERTICES, ...CUBE_AXIS_TIPS.map((tip) => tip.pos)]) {
      expect(projectCubePoint(...point, theta, phi, 120)).toEqual(originalProject(...point, theta, phi, 120));
    }
    const front = projectCubePoint(1, 1, 1, theta, phi, 120).z;
    expect(cubeEdgeOpacity(front)).toBe(0.25 + 0.75 * Math.max(0, Math.min(1, (front + 1.5) / 3)));
    expect(cubeAxisOpacity(front)).toBe(0.3 + 0.7 * Math.max(0, Math.min(1, (front + 1.5) / 3)));
  });

  it('maps original XYPad edges, clamps pointer positions, and preserves Y-up', () => {
    expect(normalizeXY(-3, 3, -3, 3, -3, 3)).toEqual({ x: 0, y: 0 });
    expect(normalizeXY(3, -3, -3, 3, -3, 3)).toEqual({ x: 1, y: 1 });
    expect(denormalizeXY(-0.5, 1.5, -3, 3, -3, 3)).toEqual({ x: -3, y: -3 });
    expect(denormalizeXY(0.25, 0.75, -3, 3, -3, 3)).toEqual({ x: -1.5, y: -1.5 });
    expect(denormalizeXY(0.25, 0.75, -3, 3, -3, 3, 'down')).toEqual({ x: -1.5, y: 1.5 });
    expect(normalizeXY(-1.5, 1.5, -3, 3, -3, 3, 'down')).toEqual({ x: 0.25, y: 0.75 });
  });

  it('inverts drags in a selected cube plane', () => {
    const basis = cubeProjectedBasis(0.6, 0.35);
    const dx = basis.x[0] * 0.4 + basis.y[0] * -0.2;
    const dy = basis.x[1] * 0.4 + basis.y[1] * -0.2;
    const result = solveCubePlaneDelta(dx, dy, 'x', 'y', 0.6, 0.35);
    expect(result?.[0]).toBeCloseTo(0.4);
    expect(result?.[1]).toBeCloseTo(-0.2);
    expect(solveCubePlaneDelta(1, 1, 'x', 'y', 0, Math.PI / 2)).toBeNull();
  });
});
