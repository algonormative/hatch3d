/** Shared, dependency-free geometry for the original spatial controls and sketch viewer. */
export const CUBE_VERTICES = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
export const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
export const CUBE_AXIS_TIPS = [
  { label: 'X', pos: [1.4, 0, 0] },
  { label: 'Y', pos: [0, 1.4, 0] },
  { label: 'Z', pos: [0, 0, 1.4] },
];

export const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Rotate around X by phi, then around Y by theta, matching OrbitCube. */
export function rotateCubePoint(x, y, z, theta, phi) {
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const y1 = y * cosP - z * sinP;
  const z1 = y * sinP + z * cosP;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const x2 = x * cosT + z1 * sinT;
  const z2 = -x * sinT + z1 * cosT;
  return [x2, y1, z2];
}

/** Project into OrbitCube's SVG coordinates. z remains the rotated depth. */
export function projectCubePoint(x, y, z, theta, phi, size = 120) {
  const [rx, ry, rz] = rotateCubePoint(x, y, z, theta, phi);
  const half = size / 2;
  const scale = size * 0.28;
  return { x: half + rx * scale, y: half - ry * scale, z: rz };
}

export function cubeEdgeOpacity(avgZ) {
  return 0.25 + 0.75 * clamp01((avgZ + 1.5) / 3);
}

export function cubeAxisOpacity(z) {
  return 0.3 + 0.7 * clamp01((z + 1.5) / 3);
}

/** Screen-space unit basis (positive screen Y points down). */
export function cubeProjectedBasis(theta, phi) {
  const basis = (x, y, z) => {
    const [rx, ry] = rotateCubePoint(x, y, z, theta, phi);
    return [rx, -ry];
  };
  return { x: basis(1, 0, 0), y: basis(0, 1, 0), z: basis(0, 0, 1) };
}

/** Invert an on-screen drag in a selected cube plane; null when edge-on. */
export function solveCubePlaneDelta(dx, dy, axisA, axisB, theta, phi, scale = 1) {
  const basis = cubeProjectedBasis(theta, phi);
  const a = basis[axisA];
  const b = basis[axisB];
  if (!a || !b || !Number.isFinite(scale) || scale === 0) return null;
  const det = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(det) < 1e-6) return null;
  return [(dx * b[1] - dy * b[0]) / (det * scale), (dy * a[0] - dx * a[1]) / (det * scale)];
}

/** Map scalar values to normalized screen coordinates; positive Y goes up by default. */
export function normalizeXY(valueX, valueY, minX, maxX, minY, maxY, yDirection = 'up') {
  const x = (valueX - minX) / (maxX - minX);
  const y = (valueY - minY) / (maxY - minY);
  return { x, y: yDirection === 'up' ? 1 - y : y };
}

/** Clamp pointer coordinates and map to scalar values. Rounding belongs to the caller. */
export function denormalizeXY(nx, ny, minX, maxX, minY, maxY, yDirection = 'up') {
  const x = clamp01(nx);
  const y = clamp01(ny);
  return { x: minX + x * (maxX - minX), y: yDirection === 'up' ? maxY - y * (maxY - minY) : minY + y * (maxY - minY) };
}
