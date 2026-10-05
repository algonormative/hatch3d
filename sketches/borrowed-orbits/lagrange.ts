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

/**
 * The curve of a critical Jacobi level through its saddle (L1, L2 or L3), traced exactly. Marching squares cannot draw it: at the
 * saddle the level set is an X, the field is flat there (shallowest at L3, where the y curvature is of order mu) and a grid reads
 * the crossing as gaps. The four branches leave the saddle along the directions where the Hessian's quadratic form vanishes;
 * each is followed by predictor-corrector steps of arc length `step` (tangent from the gradient, Newton projection onto the
 * level) until it returns to the saddle, which closes a lobe, or leaves `box`. Lobes are returned as closed polylines through
 * the saddle, so every one passes through the L point exactly.
 */
export function traceSaddleCurves(mu: number, saddle: P2, box: Box, step = 0.0015): P2[][] {
  const level = jacobiField(mu, saddle.x, saddle.y);
  const field = (p: P2): number => jacobiField(mu, p.x, p.y) - level;
  const grad = (p: P2): P2 => jacobiGradient(mu, p.x, p.y);
  // Hessian of 2U at the saddle by central differences of the gradient.
  const e = 1e-5;
  const gxp = grad({ x: saddle.x + e, y: saddle.y }), gxm = grad({ x: saddle.x - e, y: saddle.y });
  const gyp = grad({ x: saddle.x, y: saddle.y + e }), gym = grad({ x: saddle.x, y: saddle.y - e });
  const hxx = (gxp.x - gxm.x) / (2 * e), hyy = (gyp.y - gym.y) / (2 * e), hxy = (gxp.y - gxm.y + gyp.x - gym.x) / (4 * e);
  // Eigen-decomposition of [[hxx, hxy], [hxy, hyy]]: lambda1 > 0 > lambda2 at a saddle.
  const mean = (hxx + hyy) / 2, radius = Math.hypot((hxx - hyy) / 2, hxy);
  const l1 = mean + radius, l2 = mean - radius;
  const theta = 0.5 * Math.atan2(2 * hxy, hxx - hyy);
  const ex = { x: Math.cos(theta), y: Math.sin(theta) }, ey = { x: -Math.sin(theta), y: Math.cos(theta) };
  const slope = Math.sqrt(Math.max(0, -l1 / l2));
  // Rays: x' = s, y' = +/- slope s, for s = +/-1, in the eigenbasis (l1 along ex).
  const rays: P2[] = [];
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const dx = sx, dy = sy * slope, n = Math.hypot(dx, dy);
    rays.push({ x: (ex.x * dx + ey.x * dy) / n, y: (ex.y * dx + ey.y * dy) / n });
  }
  const inside = (p: P2): boolean => p.x >= box.xMin && p.x <= box.xMax && p.y >= box.yMin && p.y <= box.yMax;
  const project = (p: P2): P2 => {
    let { x, y } = p;
    for (let i = 0; i < 4; i++) {
      const g = grad({ x, y }), n2 = g.x * g.x + g.y * g.y, f = field({ x, y });
      if (!(n2 > 1e-30)) break;
      // Never move farther than a step: near the saddle the gradient is tiny and a full Newton step would jump away.
      let dx = (f * g.x) / n2, dy = (f * g.y) / n2;
      const m = Math.hypot(dx, dy);
      if (m > step) { dx *= step / m; dy *= step / m; }
      x -= dx; y -= dy;
    }
    return { x, y };
  };
  const loops: P2[][] = [];
  const arrivals: P2[] = [];
  for (const ray of rays) {
    // Skip a ray that an earlier loop already arrived along (the same lobe, traversed the other way).
    if (arrivals.some(a => a.x * ray.x + a.y * ray.y > 0.99)) continue;
    let p = project({ x: saddle.x + 4 * step * ray.x, y: saddle.y + 4 * step * ray.y });
    let direction = { x: ray.x, y: ray.y };
    const line: P2[] = [{ ...saddle }, p];
    let travelled = 0, closed = false;
    for (let i = 0; i < 60000; i++) {
      const g = grad(p), n = Math.hypot(g.x, g.y);
      if (!(n > 0)) break;
      let t = { x: -g.y / n, y: g.x / n };
      if (t.x * direction.x + t.y * direction.y < 0) t = { x: -t.x, y: -t.y };
      // Midpoint predictor, then project.
      const mid = { x: p.x + (t.x * step) / 2, y: p.y + (t.y * step) / 2 };
      const gm = grad(mid), nm = Math.hypot(gm.x, gm.y) || 1;
      let tm = { x: -gm.y / nm, y: gm.x / nm };
      if (tm.x * t.x + tm.y * t.y < 0) tm = { x: -tm.x, y: -tm.y };
      const next = project({ x: p.x + tm.x * step, y: p.y + tm.y * step });
      direction = { x: next.x - p.x, y: next.y - p.y };
      const dn = Math.hypot(direction.x, direction.y) || 1;
      direction = { x: direction.x / dn, y: direction.y / dn };
      travelled += dn;
      p = next;
      if (!inside(p)) break;
      line.push(p);
      if (travelled > 30 * step && Math.hypot(p.x - saddle.x, p.y - saddle.y) < 3 * step) {
        closed = true;
        arrivals.push({ x: saddle.x - p.x, y: saddle.y - p.y });
        const n2 = Math.hypot(arrivals[arrivals.length - 1].x, arrivals[arrivals.length - 1].y) || 1;
        arrivals[arrivals.length - 1] = { x: -arrivals[arrivals.length - 1].x / n2, y: -arrivals[arrivals.length - 1].y / n2 };
        break;
      }
    }
    if (closed) line.push({ ...saddle });
    loops.push(line);
  }
  return loops;
}

/** Zero-velocity curves of a critical level: the marched components away from the saddle, and the traced lobes through it. */
export function criticalCurves(mu: number, saddle: P2, box: Box, cells = 900, tolerance = 0): P2[][] {
  const level = jacobiField(mu, saddle.x, saddle.y);
  const marched = zeroVelocityCurves(mu, level, box, cells, tolerance).filter(line => !line.some(p => Math.hypot(p.x - saddle.x, p.y - saddle.y) < 0.08));
  return [...marched, ...traceSaddleCurves(mu, saddle, box)];
}
