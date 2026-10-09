import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { clamp, n } from '../params.ts';
import { densityLevel, densityPitch } from '../slabs.ts';
import type { Family, Ink } from '../types.ts';
import { Tube, type ClothStroke } from './tube.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** What the cloth and tone functions read of the scene: sheet projection, tone, line density. */
export interface ToneEnv {
  /** A world point on the sheet, in millimetres from the sheet centre. */
  screen: (p: THREE.Vector3) => { x: number; y: number };
  /** Darkness 0..1 at a point with a surface normal. */
  dark: (p: THREE.Vector3, normal: THREE.Vector3) => number;
  /** Overall line density, 0..1. */
  density: number;
}

/** Which pen and group each kind of cloth line goes to. Group names are the sketch's own. */
export interface Look {
  /** The body of the cloth: stripes, laminations, ribs. */
  cloth: Ink;
  /** The occasional accent line among the cloth. */
  accent: Ink;
  /** Seams, hems, ribbon edges, lapel and collar outlines. */
  edge: Ink;
  /** Pressed creases, facet edges, cuffs, tie stripes. */
  crease: Ink;
  /** The bright detail stripe of the tie. */
  detail: Ink;
  /** Group for cloth lines. */
  figure: string;
  /** Group for outlines. */
  contour: string;
  /** Stroke family, when the sketch tags one. */
  family?: Family;
}

export const LOOK: Look = {
  cloth: 'ultramarine', accent: 'violet', edge: 'vermilion', crease: 'carbon', detail: 'acid',
  figure: 'figure', contour: 'contour',
};

/** Minimum spacing of neighbouring lines on the sheet, in millimetres. */
export const MIN_MM = 0.55;

/** Smallest power-of-two stride that keeps neighbouring lines at least `min` apart on the sheet. */
export function stride(spacing: number, min = MIN_MM): number {
  let k = 1;
  while (spacing * k < min && k < 64) k *= 2;
  return k;
}
/** Tone thresholds of the three line tiers: primaries show first, tertiaries only in deep shadow. */
export const TIER = [0.1, 0.42, 0.66];
export const tierOf = (j: number) => (j % 4 === 0 ? 0 : j % 2 === 0 ? 1 : 2);

/** Collect contiguous runs of samples that pass `keep` into strokes, each tagged with `role` where one is named. */
export function runs(points: THREE.Vector3[], keep: boolean[], ink: Ink, group: string, out: ClothStroke[], family?: Family, role?: string) {
  const make = (pts: THREE.Vector3[]): ClothStroke => {
    const st: ClothStroke = family ? { ink, group, family, points: pts } : { ink, group, points: pts };
    if (role) st.role = role;
    return st;
  };
  let run: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) run.push(points[i]);
    else { if (run.length > 1) out.push(make(run)); run = []; }
  }
  if (run.length > 1) out.push(make(run));
}

/** Sheet-space distance from `beside` to the line from `a` toward `along`: how far apart neighbouring lines read. */
export function perpendicular(env: Pick<ToneEnv, 'screen'>, a: THREE.Vector3, along: THREE.Vector3, beside: THREE.Vector3): number {
  const p = env.screen(a), t = env.screen(along), q = env.screen(beside);
  const tx = t.x - p.x, ty = t.y - p.y, tl = Math.hypot(tx, ty) || 1e-9;
  return Math.abs(((q.x - p.x) * ty - (q.y - p.y) * tx) / tl);
}

/** Seeded smooth value noise for the impressionist breakup of the tone field. */
export function valueNoise(rng: () => number): (p: THREE.Vector3) => number {
  const table = Array.from({ length: 512 }, () => rng());
  const h = (i: number, j: number, k: number) => table[(((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0) % 512];
  return (p: THREE.Vector3) => {
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z);
    const fx = p.x - x0, fy = p.y - y0, fz = p.z - z0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    let out = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      out += h(x0 + a, y0 + b, z0 + c) * (a ? sx : 1 - sx) * (b ? sy : 1 - sy) * (c ? sz : 1 - sz);
    }
    return out;
  };
}

export interface ToneFieldOptions {
  /** Name of the seeded stream for the breakup noise. */
  noiseKey?: string;
  /** Direction toward the fixed key light that shades faces turned to it. */
  key?: THREE.Vector3;
}

/**
 * Tone field: `source` is the light. Close to it the cloth blows out to paper; the base stays heavy.
 * Reads the sketch parameters `value`, `glow` and `impression`.
 */
export function toneField(ctx: SketchContext, source: THREE.Vector3, opts: ToneFieldOptions = {}): (p: THREE.Vector3, normal: THREE.Vector3) => number {
  const base = 0.58 + 0.42 * n(ctx, 'value', 0.5, 0, 1);
  const reach = 3 + 5 * n(ctx, 'glow', 0.5, 0, 1);
  const impression = 0.75 * n(ctx, 'impression', 0.5, 0, 1);
  const noise = valueNoise(ctx.random(opts.noiseKey ?? 'mannequin-impression'));
  const key = (opts.key ?? V(0.45, 0.55, 0.7)).clone().normalize();
  return (p, normal) => {
    const to = source.clone().sub(p);
    const d = to.length();
    const facing = Math.max(0, normal.dot(to) / d);
    // An aura first, a lamp second: distance from the source sets the value, facing only modulates it.
    const glow = 1.1 * (0.55 + 0.45 * facing) / (1 + (d / reach) ** 2.2);
    const patch = noise(p.clone().multiplyScalar(0.42)) - 0.5;
    return clamp(base - 1.5 * glow - 0.22 * Math.max(0, normal.dot(key)) + impression * patch, 0, 1);
  };
}

/**
 * A tube wound in one continuous ribbon: band coordinate b = u·L/W + hand·v. Laminations follow the
 * ribbon (constant b), ribs cross it (constant v), and a paper gap separates the turns.
 * Fine lines appear only where the tone is dark enough; rests (the 64-step interruptions) open some turns.
 */
export function ribbonTube(t: Tube, env: ToneEnv, opts: { band: number; gap: number; rests: (k: number) => boolean }, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const Wb = opts.band, L = t.length, gap = opts.gap;
  const lamPrimary = Math.max(3, Math.round(densityLevel(env.density, 3, 5, 7)));
  const N = lamPrimary * 4;
  const perTurn = Math.max(96, Math.round(t.circ / 0.09));
  const bAt = (u: number, v: number) => u * L / Wb + t.hand * v;
  const turns = L / Wb;
  const visible = (u: number, v: number) => !t.mask || t.mask(u, ((v % 1) + 1) % 1);
  // Laminations and the two ribbon edges.
  for (let j = -1; j <= N; j++) {
    const edge = j === -1 || j === N;
    const f = j === -1 ? 0 : j === N ? 1 - gap : (j + 0.5) / N * (1 - gap);
    const samples = Math.ceil((turns + 2) * perTurn);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) {
      const tau = -1 + (turns + 2) * i / samples; // unwrapped angle, in turns
      const u = (f + tau) * Wb / L;
      const v = t.hand * -tau;
      if (u < 0 || u > 1) { pts.push(V(0, 0, 0)); keep.push(false); continue; }
      const p = t.point(u, v);
      pts.push(p);
      if (!visible(u, v)) { keep.push(false); continue; }
      const k = Math.floor(bAt(u, ((v % 1) + 1) % 1));
      const dark = env.dark(p, t.normal(u, v));
      if (edge) { keep.push(dark > 0.05); continue; }
      const du = (1 - gap) / N * Wb / L;
      const s = stride(perpendicular(env, p, t.point(u + Wb / L / perTurn, v - t.hand / perTurn), t.point(u + du, v)));
      const tier = opts.rests(k) ? Math.max(tierOf(j), 1) : tierOf(j);
      keep.push(j % s === 0 && dark > TIER[tier] + (tier === 0 && opts.rests(k) ? 0.2 : 0));
    }
    runs(pts, keep, edge ? look.edge : look.cloth, edge ? look.contour : look.figure, out, look.family);
  }
  // Ribs across each turn of the ribbon.
  const ribPrimary = Math.max(8, Math.round(t.circ / densityPitch(env.density, 0.62, 0.4, 0.3)));
  const R = ribPrimary * 2;
  const kMin = Math.floor(bAt(0, 1)) - 1, kMax = Math.ceil(bAt(1, 0)) + 1;
  for (let k = kMin; k <= kMax; k++) {
    for (let i = 0; i < R; i++) {
      const v = i / R;
      const b0 = k + 0.02, b1 = k + 1 - gap - 0.02;
      const u0 = (b0 - t.hand * v) * Wb / L, u1 = (b1 - t.hand * v) * Wb / L;
      if (u1 < 0 || u0 > 1) continue;
      const mid = clamp((u0 + u1) / 2, 0, 1);
      const p = t.point(mid, v);
      if (!visible(mid, v)) continue;
      const dark = env.dark(p, t.normal(mid, v));
      const s = stride(perpendicular(env, p, t.point(mid + 0.01, v), t.point(mid, v + 1 / R)));
      const tier = i % 2 === 0 ? (i % 4 === 0 ? 0 : 1) : 2;
      if (i % s !== 0 || dark < TIER[tier] + 0.08 || (opts.rests(k) && tier > 0)) continue;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= 6; q++) {
        const u = u0 + (u1 - u0) * q / 6;
        const ok = u >= 0 && u <= 1 && visible(u, v);
        pts.push(ok ? t.point(u, v) : V(0, 0, 0));
        keep.push(ok);
      }
      runs(pts, keep, i % 8 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
    }
  }
  return out;
}
