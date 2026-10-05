/**
 * Circular restricted three-body problem references, drawn-only (nothing here is integrated).
 *
 * Normalized rotating frame: barycentre at the origin, separation 1, angular velocity 1, primary of mass 1 - mu at
 * (-mu, 0), secondary of mass mu at (1 - mu, 0). `U` is the effective potential
 *   U = (x² + y²)/2 + (1 - mu)/r1 + mu/r2,
 * and the Jacobi constant of a body with rotating-frame velocity v is C = 2U - |v|². The zero-velocity curves are the
 * level sets 2U = C; the body can only be where 2U >= C.
 */
import { contourLines } from './contour.ts';
import type { Box, P2 } from './contour.ts';

export interface LagrangePoints { L1: P2; L2: P2; L3: P2; L4: P2; L5: P2 }

/** x-force along the axis: dU/dx at (x, 0). */
const axial = (mu: number, x: number): number => x - ((1 - mu) * (x + mu)) / Math.abs((x + mu) ** 3) - (mu * (x - 1 + mu)) / Math.abs((x - 1 + mu) ** 3);
const axialDerivative = (mu: number, x: number): number => 1 + (2 * (1 - mu)) / Math.abs((x + mu) ** 3) + (2 * mu) / Math.abs((x - 1 + mu) ** 3);

function newton(mu: number, guess: number): number {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const step = axial(mu, x) / axialDerivative(mu, x);
    x -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return x;
}

/** L1-L3 by Newton on the collinear equilibrium (to ~1e-15); L4 and L5 are analytic. */
export function lagrangePoints(mu: number): LagrangePoints {
  const hill = Math.cbrt(mu / 3);
  return {
    L1: { x: newton(mu, 1 - mu - hill), y: 0 },
    L2: { x: newton(mu, 1 - mu + hill), y: 0 },
    L3: { x: newton(mu, -(1 + (5 * mu) / 12)), y: 0 },
    L4: { x: 0.5 - mu, y: Math.sqrt(3) / 2 },
    L5: { x: 0.5 - mu, y: -Math.sqrt(3) / 2 },
  };
}

/** Gradient of the effective potential U (zero at every Lagrange point). */
export function potentialGradient(mu: number, x: number, y: number): P2 {
  const r1 = ((x + mu) ** 2 + y * y) ** 1.5;
  const r2 = ((x - 1 + mu) ** 2 + y * y) ** 1.5;
  return { x: x - ((1 - mu) * (x + mu)) / r1 - (mu * (x - 1 + mu)) / r2, y: y - ((1 - mu) * y) / r1 - (mu * y) / r2 };
}

/** 2U: the field whose level sets are the zero-velocity curves. */
export function jacobiField(mu: number, x: number, y: number): number {
  return x * x + y * y + (2 * (1 - mu)) / Math.hypot(x + mu, y) + (2 * mu) / Math.hypot(x - 1 + mu, y);
}

/** Gradient of 2U. */
export function jacobiGradient(mu: number, x: number, y: number): P2 {
  const g = potentialGradient(mu, x, y);
  return { x: 2 * g.x, y: 2 * g.y };
}

/** Jacobi constant of a body at (x, y) with rotating-frame velocity (vx, vy). */
export const jacobiConstant = (mu: number, x: number, y: number, vx: number, vy: number): number => jacobiField(mu, x, y) - (vx * vx + vy * vy);

/** Critical Jacobi constants C(L1) >= C(L2) >= C(L3) >= C(L4) = C(L5) = 3 - mu (1 - mu). */
export function criticalLevels(mu: number): { L1: number; L2: number; L3: number; L4: number } {
  const p = lagrangePoints(mu);
  return {
    L1: jacobiField(mu, p.L1.x, p.L1.y), L2: jacobiField(mu, p.L2.x, p.L2.y),
    L3: jacobiField(mu, p.L3.x, p.L3.y), L4: jacobiField(mu, p.L4.x, p.L4.y),
  };
}

/** Zero-velocity curves of `mu` at Jacobi constant `level` inside `box` (normalized units): closed loops repeat their first point. */
export function zeroVelocityCurves(mu: number, level: number, box: Box, cells = 900, tolerance = 0): P2[][] {
  return contourLines((x, y) => jacobiField(mu, x, y), (x, y) => jacobiGradient(mu, x, y), level, box, cells, tolerance);
}

/**
 * The long-period (libration) normal mode of the linearized motion about L4 (`side` +1) or L5 (-1): the combination of
 * displacement and rotating-frame velocity that excites the slow libration and none of the short-period epicycle,
 * so a tadpole released this way is a clean banana instead of a banana strung with loops. Characteristic equation
 * lambda^4 + lambda^2 + 27 mu (1 - mu) / 4 = 0, lambda = i omega. With the x displacement 1, the y displacement is
 * `bRe`, the rotating velocity is (0, -omega bIm); scale all by the amplitude. `omega` is in units of the binary's
 * angular velocity (libration period = 2 pi / omega binary radians).
 */
export function librationMode(mu: number, side: 1 | -1): { omega: number; bRe: number; bIm: number } {
  const uxx = 0.75;
  const uxy = (side * 3 * Math.sqrt(3) / 4) * (1 - 2 * mu);
  const l2 = (-1 + Math.sqrt(1 - 27 * mu * (1 - mu))) / 2;
  const omega = Math.sqrt(-l2);
  // b = (lambda^2 - Uxx) / (2 lambda + Uxy) with lambda = i omega
  const denRe = uxy, denIm = 2 * omega, numRe = l2 - uxx;
  const norm = denRe * denRe + denIm * denIm;
  return { omega, bRe: (numRe * denRe) / norm, bIm: (-numRe * denIm) / norm };
}
