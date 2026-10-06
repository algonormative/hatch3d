import type { SketchContext } from '../../src/sketch/types.ts';

/** The shared control reader and scalar helpers for the 3D-poster sketches (Breach family). */

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Smoothstep from `a` to `b`. */
export const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** A numeric control, clamped to [lo, hi]; `fallback` when it is absent or not a finite number. */
export function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}
