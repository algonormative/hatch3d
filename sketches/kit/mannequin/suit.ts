import * as THREE from 'three';
import { clamp } from '../params.ts';
import { densityPitch } from '../slabs.ts';
import type { Ink } from '../types.ts';
import { LOOK, TIER, perpendicular, runs, stride, tierOf, type Look, type ToneEnv } from './hatch.ts';
import type { ClothStroke, Tube } from './tube.ts';

/** Seams, hems and extras of one garment piece, in tube coordinates. */
export type Tailoring = { seams: number[]; hems: number[]; creases?: number[]; stop?: number; cuffs?: number[] };

/** Seams and hems per garment piece (keyed by tube id without its side suffix). */
export const HEMS: Record<string, Tailoring> = {
  trunk: { seams: [0, 0.5, 0.75], hems: [0.07] },
  thigh: { seams: [0, 0.5], hems: [], creases: [0.25] },
  shin: { seams: [0, 0.5], hems: [0.955], creases: [0.25] },
  upper: { seams: [0.5], hems: [] },
  fore: { seams: [0.5], hems: [0.88], stop: 0.88, cuffs: [0.955] },
};

/**
 * Tailored cloth: pinstripes run along each garment piece (constant v), seams and hems in the edge
 * pen, pressed creases and facet edges in the crease pen. Value comes from line density alone: fine
 * stripes join the primaries only where the tone is dark, rings cross them in the deepest shadow, and
 * the domed ends (knees, shoulders, elbows) are hatched with rings instead of converging stripes.
 */
export function pinstripeTube(t: Tube, env: ToneEnv, opts: Tailoring, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const primary = Math.max(8, Math.round(t.circ / densityPitch(env.density, 0.56, 0.38, 0.29)));
  const N = primary * 4;
  const samples = Math.max(80, Math.round(t.length / 0.07));
  const lo = 0.35 * t.caps[0] / t.length, hi = Math.min(opts.stop ?? 1, 1 - 0.35 * t.caps[1] / t.length);
  const cloth = (u: number, v: number) => !t.mask || t.mask(u, ((v % 1) + 1) % 1);
  const visible = (u: number, v: number) => u >= lo && u <= hi && cloth(u, v);
  const offset = t.facets >= 3 ? 0.5 / N : 0;
  for (let j = 0; j < N; j++) {
    const v = j / N + offset;
    const tier = tierOf(j);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      const p = t.point(u, v);
      pts.push(p);
      if (!visible(u, v)) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, t.point(u + 1 / samples, v), t.point(u, v + 1 / N)));
      keep.push(j % s === 0 && env.dark(p, t.normal(u, v)) > TIER[tier]);
    }
    runs(pts, keep, j % 16 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
  }
  // Rings: the only hatch on the domed ends, and a cross-hatch over the stripes in the deepest shadow.
  const R = Math.max(8, Math.round(t.length / 0.34)) * 4;
  const around = Math.max(120, Math.round(t.circ / 0.06));
  for (let i = 0; i < R; i++) {
    const u = (i + 0.5) / R;
    if (u > (opts.stop ?? 1)) continue;
    const tier = tierOf(i);
    const capped = u < lo || u > hi;
    const threshold = capped ? TIER[tier] : tier === 0 ? 0.74 : tier === 1 ? 0.84 : 2;
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let q = 0; q <= around; q++) {
      const v = q / around;
      const p = t.point(u, v);
      pts.push(p);
      if (!cloth(u, v)) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, t.point(u, v + 1 / around), t.point(u + 1 / R, v)));
      keep.push(i % s === 0 && env.dark(p, t.normal(u, v)) > threshold);
    }
    runs(pts, keep, i % 8 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
  }
  const along = (v: number, ink: Ink, group: string, lift: number, show: (u: number) => boolean) => {
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) { const u = i / samples; pts.push(t.point(u, v, lift)); keep.push(show(u) && cloth(u, v)); }
    runs(pts, keep, ink, group, out, look.family);
  };
  const ring = (u: number, ink: Ink, lift: number, show = true) => {
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= around; i++) { const v = i / around; pts.push(t.point(u, v, lift)); keep.push(show && cloth(u, v)); }
    runs(pts, keep, ink, look.contour, out, look.family);
  };
  // The planes of a faceted body: crisp crease-pen edges, end to end.
  if (t.facets >= 3) for (let k = 0; k < t.facets; k++) along(k / t.facets, look.crease, look.figure, 0.004, u => u <= (opts.stop ?? 1));
  for (const v of opts.seams) along(v + offset, look.edge, look.contour, 0.01, u => u >= lo && u <= hi);
  for (const v of opts.creases ?? []) along(v + offset, look.crease, look.figure, 0.012, u => u >= lo && u <= hi);
  for (const u of opts.hems) ring(u, look.edge, 0.012);
  for (const u of opts.cuffs ?? []) ring(u, look.crease, 0.03);
  return out;
}

/** Suit front on the trunk, in trunk coordinates (u up the spine, v round it, 0.25 = front). */
export const BUTTON = 0.4, COLLAR = 0.83;
export function opening(u: number): number { return u < BUTTON || u > COLLAR + 0.04 ? 0 : 0.085 * clamp((u - BUTTON) / (COLLAR - BUTTON), 0, 1); }
export function lapel(u: number): number { return u < BUTTON - 0.02 || u > COLLAR ? 0 : 0.034 + 0.026 * clamp((u - BUTTON) / (COLLAR - BUTTON), 0, 1); }
/** Distance of `v` from the front centre line (0 at the front, 0.5 at the back). */
export const front = (v: number) => Math.abs(((v - 0.25) % 1 + 1.5) % 1 - 0.5);

/** Lapels, tie and collar laid over the trunk; the shirt in the opening stays paper. */
export function suitFront(trunk: Tube, env: ToneEnv, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const steps = 90;
  const lift = 0.05;
  const line = (ink: Ink, group: string, fn: (s: number) => [number, number], count = steps, liftBy = lift) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= count; i++) { const [u, v] = fn(i / count); pts.push(trunk.point(u, v, liftBy)); }
    out.push(look.family ? { ink, group, family: look.family, points: pts } : { ink, group, points: pts });
  };
  const u0 = BUTTON - 0.02, u1 = COLLAR;
  for (const side of [-1, 1]) {
    const edgeIn = (s: number): [number, number] => { const u = u0 + (u1 - u0) * s; return [u, 0.25 + side * opening(u)]; };
    const edgeOut = (s: number): [number, number] => { const u = u0 + (u1 - u0) * s; return [u, 0.25 + side * (opening(u) + lapel(u))]; };
    line(look.edge, look.contour, edgeIn);
    line(look.edge, look.contour, edgeOut);
    // Lapel cloth: laminations parallel to the roll line, thicker toward the dark lower lapel.
    const count = Math.round(densityPitch(env.density, 6, 10, 13));
    for (let k = 1; k < count; k++) {
      const f = k / count;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let i = 0; i <= steps; i++) {
        const u = u0 + (u1 - u0) * i / steps;
        const v = 0.25 + side * (opening(u) + f * lapel(u));
        const p = trunk.point(u, v, lift);
        pts.push(p);
        keep.push(env.dark(p, trunk.normal(u, v)) > TIER[tierOf(k)] - 0.05);
      }
      runs(pts, keep, k % 4 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
    }
    // Notch and collar points.
    line(look.edge, look.contour, s => [u1 + 0.065 * s, 0.25 + side * (opening(u1) + lapel(u1) * (1 - 0.6 * s))], 12);
    line(look.edge, look.contour, s => [0.895 - 0.075 * s, 0.25 + side * (0.02 + 0.05 * s)], 12, 0.03);
    line(look.edge, look.contour, s => [0.82 + 0.075 * s, 0.25 + side * (0.07 + 0.045 * s)], 12, 0.03);
  }
  // The tie: a knot under the collar, a blade with diagonal stripes, ending at the button.
  const tieTop = 0.875, tieEnd = BUTTON + 0.005;
  const half = (u: number) => u > 0.85 ? 0.011 : 0.012 + 0.012 * (0.85 - u) / (0.85 - tieEnd);
  line(look.edge, look.contour, s => { const u = tieTop - (tieTop - tieEnd) * s; return [u, 0.25 - half(u)]; }, 60, 0.07);
  line(look.edge, look.contour, s => { const u = tieTop - (tieTop - tieEnd) * s; return [u, 0.25 + half(u)]; }, 60, 0.07);
  line(look.edge, look.contour, s => [0.85, 0.25 + (2 * s - 1) * half(0.85)], 6, 0.07);
  const stripes = Math.round(densityPitch(env.density, 22, 34, 44));
  for (let k = 0; k < stripes; k++) {
    const c = tieEnd + (0.85 - tieEnd) * (k + 0.5) / stripes;
    if (k % 6 === 5) continue;
    line(k % 6 === 2 ? look.detail : look.crease, look.figure, s => [c + 0.012 * (s - 0.5), 0.25 + (2 * s - 1) * half(c) * 0.9], 4, 0.07);
  }
  return out;
}
