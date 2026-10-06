import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { TABLOID_PAGE, TALL_ART, posterArtTransform } from '../phase-garden/poster.ts';
import { clearBands, planSlogans, type SloganPlan, type SloganSurface } from './slogan.ts';

export type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet';
export type Group = 'tower' | 'collapse' | 'strand-a' | 'strand-b' | 'slogan';
/** `owner` is the index of the solid a stroke belongs to, so slogan bands clear only its own hatch. */
type Stroke = { ink: Ink; group: Group; points: THREE.Vector3[]; owner?: number };
export type Role = 'stack' | 'pier' | 'stub' | 'fallen' | 'debris';
export type Slab = {
  x: number; y: number; z: number; w: number; h: number; d: number;
  rx: number; ry: number; rz: number;
  beat: number; role: Role;
  /** Where the solid stood before the collapse moved it. */
  home: { x: number; y: number; z: number };
  /** Local hatch loudness, 0..1; quiet slabs read as open masonry. */
  tone: number;
};

export const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS: Group[] = ['tower', 'collapse', 'strand-a', 'strand-b', 'slogan'];
// Depth pixels: two per page millimetre, aspect matched to the 11 × 17 sheet.
const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const ART = { x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width, y0: TALL_ART.y, y1: TALL_ART.y + TALL_ART.height };
const HALF_H = 13.0;
const HALF_W = HALF_H * TABLOID_PAGE.width / TABLOID_PAGE.height;
/** Page millimetres per world unit. */
export const MM_PER_UNIT = TABLOID_PAGE.height / (2 * HALF_H);
const MIN_SPACING_MM = 0.55;
// Slanted front hatch loses ~7% to its slant; keep the perpendicular gap at 0.5 mm or more.
const MIN_PITCH = 0.56 / MM_PER_UNIT;
const BOT = -10.9, TOP = 10.6;
const SIDE = 6.55; // outermost centre for anything that moves outward

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function camera(): THREE.OrthographicCamera {
  const view = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 80);
  view.up.set(0, 1, 0);
  view.position.set(3.2, -5.8, 19.5);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

function densityPitch(density: number, sparse: number, neutral: number, dense: number): number {
  return density < 0.55
    ? sparse + (neutral - sparse) * density / 0.55
    : neutral + (dense - neutral) * (density - 0.55) / 0.45;
}

export type Collapse = { centre: number; half: number; intensity: number };

export function collapseBand(ctx: SketchContext): Collapse {
  const rng = ctx.random('tower-collapse-band');
  const intensity = n(ctx, 'collapse', 0.6, 0, 1);
  const levels = Math.round(n(ctx, 'levels', 17, 15, 21));
  const step = (TOP - BOT) / (levels - 1);
  const frac = clamp(0.2 + 0.56 * n(ctx, 'collapseHeight', 0.5, 0, 1) + (rng() - 0.5) * 0.2, 0.14, 0.82);
  return { centre: BOT + (TOP - BOT) * frac, half: step * (0.9 + 2.5 * intensity), intensity };
}

function solid(x: number, y: number, z: number, w: number, h: number, d: number, beat: number, role: Role): Slab {
  return { x, y, z, w, h, d, rx: 0, ry: 0, rz: 0, beat, role, home: { x, y, z }, tone: 1 };
}

/** The intact cantilever stack and its piers, before the collapse acts on it. */
function stack(ctx: SketchContext): Slab[] {
  const rng = ctx.random('tower-topology');
  const reach = n(ctx, 'cantilever', 0.55, 0, 1);
  const breach = n(ctx, 'breach', 0.5, 0, 1);
  const count = Math.round(n(ctx, 'levels', 17, 15, 21));
  const step = (TOP - BOT) / (count - 1);
  const k = step / 1.4;
  const shaft = 0.42 + 0.9 * breach;
  const out: Slab[] = [];
  const phase = rng() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const y = BOT + i * step + (rng() - 0.5) * 0.2 * step;
    const sign = (i % 3 === 1 ? -phase : phase) * (rng() < 0.2 ? -1 : 1);
    // A heavier base, a lighter crown.
    const width = (2.25 + reach * 1.75 + (reach - 0.55) * 2.0 + rng() * 0.9) * (1.08 - 0.2 * f);
    const inner = shaft * (0.7 + rng() * 0.55);
    const x = sign * (inner + width / 2);
    const z = (rng() - 0.5) * 0.48;
    const h = step * (0.38 + rng() * 0.22);
    const d = 0.75 + rng() * 0.40;
    if (i % 4 === 2) {
      const left = width * (0.43 + rng() * 0.08);
      const gap = Math.min(width * 0.5, width - left - 0.12, 0.5 + 0.2 * breach + (breach - 0.5) * 0.7);
      const right = width - gap - left;
      out.push(solid(x - width / 2 + left / 2, y, z, left, h, d, i, 'stack'));
      out.push(solid(x + width / 2 - right / 2, y, z, right, h, d, i, 'stack'));
    } else out.push(solid(x, y, z, width, h, d, i, 'stack'));
    if (i % 2 === 0) out.push(solid(x + sign * 0.15, y + h * 0.5 + 0.08, z + 0.18,
      width * (0.74 + rng() * 0.15), 0.16, d + 0.30, i, 'stack'));
    if (i % 3 === 1) out.push(solid(x - sign * width * 0.33, y + h * 0.5 + 0.55 * k, z - 0.1,
      0.24 + rng() * 0.16, (1.1 + rng() * 0.4) * k, d * 0.8, i, 'stack'));
    if (i % 3 === 0 || (rng() < 0.42 && i !== Math.floor(count / 2))) {
      const cw = 1.3 + rng() * 0.9;
      out.push(solid(-sign * (shaft * (0.9 + rng() * 0.3) + cw / 2 + 0.35), y + 0.16 * k, -0.34,
        cw, (0.55 + rng() * 0.22) * k, 0.88, i, 'stack'));
    }
  }
  // Long structural blades behind the stack; the right one survives only in remnants.
  const segments = 5;
  const seg = (TOP - BOT + 1.2) / segments;
  for (let i = 0; i < segments; i++) {
    const yc = BOT - 0.4 + (i + 0.5) * seg;
    if (!(breach > 0.72 && i === 2)) out.push(solid(-(shaft + 0.95), yc, -0.55, 0.58, seg * 0.9, 1.0, count + i, 'pier'));
    if (i % 2 === 0) out.push(solid(shaft + 2.7 + rng() * 0.25, yc, -0.56, 0.48, seg * (0.55 + rng() * 0.15), 0.85, count + i + segments, 'pier'));
  }
  return out;
}

/** Shear the stack in the collapse band: tumbling slabs, snapped stubs, broken piers, falling fragments. */
function collapse(ctx: SketchContext, intact: Slab[], band: Collapse): Slab[] {
  const rng = ctx.random('tower-collapse');
  const I = band.intensity;
  const out: Slab[] = [];
  const fall = (s: Slab, k: number, outward: number): Slab => {
    const mag = I * (0.45 + 0.55 * k);
    const x = s.x + outward * (0.7 + (1.6 + 2.6 * rng()) * mag);
    const y = s.y - (0.4 + (1.4 + 3.6 * rng()) * mag);
    const z = s.z + (rng() - 0.25) * 1.5 * mag;
    const rz = -outward * (0.25 + 1.3 * rng()) * mag * (rng() < 0.18 ? -1 : 1);
    const reachX = s.w / 2 * Math.abs(Math.cos(rz)) + s.h / 2 * Math.abs(Math.sin(rz));
    return { ...s, x: clamp(x, -SIDE + reachX, SIDE - reachX), y, z, rz,
      rx: (rng() - 0.5) * 0.9 * mag, ry: (rng() - 0.5) * 1.1 * mag, role: 'fallen' };
  };
  for (const s of intact) {
    const k = I > 0 ? 1 - ((s.y - band.centre) / band.half) ** 2 : 0;
    if (k <= 0) { out.push(s); continue; }
    if (s.role === 'pier') {
      // Snap the blade: a gap at the band core, the freed chunk tumbles.
      const y0 = s.y - s.h / 2, y1 = s.y + s.h / 2;
      const g0 = Math.max(y0, band.centre - band.half * 0.45), g1 = Math.min(y1, band.centre + band.half * 0.3);
      if (g1 - g0 < 0.3) { out.push(s); continue; }
      if (g0 - y0 > 0.4) out.push({ ...s, y: (y0 + g0) / 2, h: g0 - y0, home: { ...s.home, y: (y0 + g0) / 2 } });
      if (y1 - g1 > 0.4) out.push({ ...s, y: (g1 + y1) / 2, h: y1 - g1, home: { ...s.home, y: (g1 + y1) / 2 } });
      const chunk = { ...s, y: (g0 + g1) / 2, h: Math.min(g1 - g0, 2.2), home: { ...s.home, y: (g0 + g1) / 2 } };
      out.push(fall(chunk, k, Math.sign(s.x) || 1));
      continue;
    }
    const outward = Math.sign(s.x) || 1;
    const roll = rng();
    // The band core empties completely; snapped stubs survive only at its edges.
    const fallChance = 0.1 + 1.0 * k * Math.min(1, 0.35 + I);
    if (roll < fallChance) {
      if (s.w > 2 && rng() < 0.25 + 0.4 * I) {
        // Shear in two; the inner piece drops further.
        const cut = s.w * (0.38 + rng() * 0.22);
        const innerW = s.w - cut;
        const outerX = s.x + outward * (s.w / 2 - cut / 2), innerX = s.x - outward * (s.w / 2 - innerW / 2);
        out.push(fall({ ...s, x: outerX, w: cut, home: { ...s.home, x: outerX } }, k * 0.6, outward));
        out.push(fall({ ...s, x: innerX, w: innerW, home: { ...s.home, x: innerX } }, k, outward));
      } else out.push(fall(s, k, outward));
    } else if (s.w > 1.2 && roll < fallChance + 0.35) {
      // Snapped cantilever: the outer root stays, the tip breaks away.
      const keep = s.w * (0.42 + rng() * 0.25);
      const stubX = s.x + outward * (s.w / 2 - keep / 2);
      const tipW = s.w - keep, tipX = s.x - outward * (s.w / 2 - tipW / 2);
      out.push({ ...s, x: stubX, w: keep, rz: -outward * 0.06 * k * I, role: 'stub', home: { ...s.home, x: stubX } });
      out.push(fall({ ...s, x: tipX, w: tipW, home: { ...s.home, x: tipX } }, k, outward));
    } else out.push({ ...s, rz: -outward * 0.04 * k * I });
  }
  const amount = n(ctx, 'debris', 0.5, 0, 1);
  const pieces = Math.round((3 + 30 * I) * amount * 2);
  const drng = ctx.random('tower-debris');
  for (let i = 0; i < pieces; i++) {
    const side = drng() < 0.5 ? -1 : 1;
    const drop = drng() ** 0.85;
    const size = (1 - 0.55 * drop) * (0.35 + 0.65 * drng());
    const w = 0.22 + 0.85 * size, h = 0.09 + 0.24 * size, d = 0.18 + 0.42 * size;
    const y = band.centre - band.half * 0.25 - drop * (2.2 + 6.5 * I) - drng() * 0.6;
    const x = side * clamp(1.6 + drng() * 3.5 + drop * 1.4, 0, SIDE - w / 2);
    const z = 0.5 + drng() * 1.7;
    out.push({ ...solid(x, Math.max(BOT - 0.4, y), z, w, h, d, 64 + i, 'debris'),
      home: { x: side * 2.5, y: band.centre, z: 0 },
      rx: (drng() - 0.5) * 2.2, ry: (drng() - 0.5) * 2.2, rz: (drng() - 0.5) * Math.PI });
  }
  return out;
}

/** Every solid, after the collapse, with its hierarchy tone. */
export function towerSlabs(ctx: SketchContext): Slab[] {
  const band = collapseBand(ctx);
  const span = TOP - BOT;
  const worldX = n(ctx, 'worldX', 0, -1.5, 1.5);
  const worldY = n(ctx, 'worldY', 0, -1.5, 1.5);
  const worldZ = n(ctx, 'worldZ', 0, -2, 2);
  return collapse(ctx, stack(ctx), band).map(s => {
    // Loud around the breach and in the bearing base; the crown stays open paper.
    const near = Math.exp(-(((s.home.y - band.centre) / (span * 0.17)) ** 2));
    const base = clamp((BOT + span * 0.28 - s.home.y) / (span * 0.28), 0, 1) * 0.75;
    const tone = s.role === 'debris' ? 0.45 : 0.18 + 1.2 * Math.max(near, base);
    return { ...s, tone, x: s.x + worldX, y: s.y + worldY, z: s.z + worldZ,
      home: { x: s.home.x + worldX, y: s.home.y + worldY, z: s.home.z + worldZ } };
  });
}

function slabMatrix(s: Slab): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
}

function slabGeometry(s: Slab): THREE.BufferGeometry {
  const mesh = new THREE.BoxGeometry(s.w, s.h, s.d);
  mesh.applyMatrix4(slabMatrix(s));
  return mesh;
}

function slabStrokes(s: Slab, globalDensity: number, interrupt: boolean): Stroke[] {
  const out: Stroke[] = [];
  const group: Group = s.role === 'stack' || s.role === 'pier' ? 'tower' : 'collapse';
  const m = slabMatrix(s);
  const line = (ink: Ink, ...pts: THREE.Vector3[]) => out.push({ ink, group, points: pts.map(p => p.applyMatrix4(m)) });
  // Tone never pushes a course past the densest legal pitch.
  const density = Math.min(1, globalDensity * s.tone);
  const x0 = -s.w / 2, x1 = s.w / 2, y0 = -s.h / 2, y1 = s.h / 2;
  const zf = s.d / 2 + 0.006, zb = -s.d / 2;
  const p = (x: number, y: number, z = zf) => new THREE.Vector3(x, y, z);
  // All twelve edges; the depth pass decides which ones the eye can see.
  const e = 0.006;
  line('carbon', p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0));
  line('carbon', p(x0, y0, zb - e), p(x1, y0, zb - e), p(x1, y1, zb - e), p(x0, y1, zb - e), p(x0, y0, zb - e));
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    line('carbon', p(x + Math.sign(x) * e, y + Math.sign(y) * e, zb), p(x + Math.sign(x) * e, y + Math.sign(y) * e, zf));
  }
  const pitch = Math.max(MIN_PITCH, densityPitch(density, 0.12, 0.044, 0.032));
  const margin = 0.07;
  const across = Math.floor((s.w - 2 * margin) / pitch);
  for (let j = 0; j <= across; j++) {
    if (interrupt && j % 5 < 2 && j > across * 0.27 && j < across * 0.76) continue;
    const x = x0 + margin + j * (s.w - 2 * margin) / Math.max(1, across);
    const ycut = y0 + margin + (j % 4) * Math.min(0.045, s.h * 0.08);
    line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x, ycut), p(Math.min(x + 0.2, x1 - margin), y1 - margin));
  }
  if (s.w > 2.2 && s.beat % 3 !== 1) {
    const rows = Math.ceil(s.h / densityPitch(density, 0.28, 0.12, 0.07));
    for (let j = 1; j < rows; j++) {
      const y = y0 + j * s.h / rows;
      const inset = 0.13 + (j % 3) * 0.035;
      line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x0 + inset, y), p(x1 - inset, Math.min(y + 0.11, y1 - 0.06)));
    }
  }
  if (s.h > 0.3) {
    const sideRows = Math.ceil(s.h / densityPitch(density, 0.17, 0.065, 0.045));
    for (let j = 1; j < sideRows; j++) {
      const y = y0 + j * s.h / sideRows;
      line(j % 4 === 0 ? 'ultramarine' : 'carbon', p(x1 + 0.007, y, zb + 0.04), p(x1 + 0.007, Math.min(y + 0.09, y1 - 0.02), zf - 0.04));
    }
  }
  if (s.role !== 'debris' && s.tone > 0.35) for (let k = 1; k <= 3; k++) {
    const y = y0 + k * s.h / 4;
    line(k === 2 ? 'ultramarine' : 'carbon', p(x0 + 0.09, y), p(x1 - 0.09, y));
  }
  const topRows = Math.ceil(s.w / densityPitch(density, 0.28, 0.12, 0.07));
  for (let k = 1; k < topRows; k++) {
    const x = x0 + k * s.w / topRows;
    line('ultramarine', p(x, y1 + 0.006, zb + 0.03), p(x, y1 + 0.006, zf - 0.03));
    // The underside shows from this low eye; score it more sparsely.
    if (k % 3 === 0 && s.tone > 0.55) line('carbon', p(x, y0 - 0.006, zb + 0.03), p(x, y0 - 0.006, zf - 0.03));
  }
  return out;
}

export type Strand = {
  id: 'a' | 'b'; theta0: number; turns: number; hand: 1 | -1; radius: number; depth: number;
  width: number; twist: number; phase: number; y0: number; y1: number; swell: number; centre: number;
  x: number; y: number; z: number;
};

/** Two seeded strands of one helix: shared turns and handedness, offset phase, staggered ends. */
export function helixStrands(ctx: SketchContext): Strand[] {
  const rng = ctx.random('twin-helix');
  const band = collapseBand(ctx);
  const hand: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const turns = Math.max(0.6, n(ctx, 'helixTurns', 1.6, 0.6, 3.4) + (rng() - 0.5) * 0.5);
  const theta0 = rng() * Math.PI * 2;
  const offset = Math.PI * (0.55 + 0.9 * n(ctx, 'strandOffset', 0.5, 0, 1)) + (rng() - 0.5) * 0.4 * Math.PI;
  const radius = n(ctx, 'helixRadius', 2.7, 1.6, 4.2);
  const width = n(ctx, 'shellWidth', 1.4, 0.4, 2.4);
  const twist = n(ctx, 'shellTwist', 0.62, 0, 1);
  const x = n(ctx, 'worldX', 0, -1.5, 1.5) + (n(ctx, 'focusX', 0.5, 0, 1) - 0.5) * 2.4;
  const y = n(ctx, 'worldY', 0, -1.5, 1.5) + (n(ctx, 'focusY', 0.5, 0, 1) - 0.5) * 2.4;
  const z = n(ctx, 'worldZ', 0, -2, 2);
  const swell = 0.35 + 1.1 * band.intensity;
  const ends = () => [BOT - 0.6 + rng() * 1.8, TOP + 0.3 - rng() * 1.8];
  const [a0, a1] = ends(), [b0, b1] = ends();
  return [
    { id: 'a', theta0, turns, hand, radius, depth: 0.74, width, twist, phase: rng() * Math.PI * 2,
      y0: a0, y1: a1, swell, centre: band.centre, x, y, z },
    { id: 'b', theta0: theta0 + offset, turns, hand, radius: radius * (0.92 + rng() * 0.1), depth: 0.74,
      width: width * (0.88 + rng() * 0.14), twist, phase: rng() * Math.PI * 2,
      y0: b0, y1: b1, swell: swell * (0.7 + rng() * 0.4), centre: band.centre, x, y, z },
  ];
}

export function strandPoint(s: Strand, t: number, v: number): THREE.Vector3 {
  const yy = s.y0 + t * (s.y1 - s.y0);
  const th = s.theta0 + s.hand * 2 * Math.PI * s.turns * t;
  const pressure = Math.sin(Math.PI * t) ** 2;
  // The living strands swell outward where the stack has failed.
  const swell = s.swell * Math.exp(-(((yy - s.centre) / 2.4) ** 2));
  const r = s.radius * (1 + 0.14 * Math.sin(2 * Math.PI * 1.7 * t + s.phase)) + swell
    + 0.15 * Math.sin(9 * th + s.phase) * pressure;
  const radial = new THREE.Vector3(Math.cos(th), 0, Math.sin(th) * s.depth);
  const twist = s.twist <= 0.62 ? s.twist : 0.62 + (s.twist - 0.62) * 1.8;
  const roll = twist * (0.95 * Math.sin(2 * Math.PI * 2.3 * t + s.phase) + 0.45 * Math.cos(2 * Math.PI * 4.1 * t + s.phase * 0.5));
  const taper = 0.16 + 0.93 * Math.sin(Math.PI * t) ** 0.55;
  const width = s.width * taper * (0.86 + 0.17 * Math.sin(2 * Math.PI * 5.5 * t + s.phase));
  // Width runs across the strand (radial × tangent), rolled toward the radial by the twist.
  const speed = s.hand * 2 * Math.PI * s.turns * r;
  const tangent = new THREE.Vector3(-Math.sin(th) * speed, s.y1 - s.y0, Math.cos(th) * s.depth * speed).normalize();
  const across = new THREE.Vector3().crossVectors(radial, tangent).normalize();
  if (across.y < 0) across.negate();
  const dir = across.multiplyScalar(Math.cos(roll)).addScaledVector(radial, Math.sin(roll));
  return new THREE.Vector3(s.x, s.y + yy + 0.3 * Math.sin(2 * th + s.phase * 0.3) * pressure, s.z + 0.25)
    .addScaledVector(radial, r + 0.13 * (1 - v * v))
    .addScaledVector(dir, v * width);
}

function trace(ink: Ink, group: Group, count: number, fn: (t: number) => THREE.Vector3): Stroke {
  return { ink, group, points: Array.from({ length: count + 1 }, (_, i) => fn(i / count)) };
}

const BARS = 16;

function strandStrokes(s: Strand, density: number, interruption: number, ctx: SketchContext, view: THREE.Camera): Stroke[] {
  const out: Stroke[] = [];
  const group: Group = s.id === 'a' ? 'strand-a' : 'strand-b';
  const rng = ctx.random(`lamellar-${s.id}`);
  const screen = (p: THREE.Vector3) => {
    const q = p.clone().project(view);
    return { x: q.x * HALF_W * MM_PER_UNIT, y: q.y * HALF_H * MM_PER_UNIT };
  };
  const at = (t: number, v: number) => screen(strandPoint(s, t, v));
  for (const v of [-1, 1]) out.push(trace('vermilion', group, 480, t => strandPoint(s, t, v)));
  const gates = Array.from({ length: BARS }, (_, bar) => bar === 0 || bar === BARS - 1 || rng() > interruption * 0.73);
  const pitch = Math.max(MIN_PITCH, densityPitch(density, 0.09, 0.034, 0.032));
  const contours = Math.max(6, Math.round(2 * s.width * 0.95 / pitch));
  // Screen-space lamination spacing per bar: tapers and edge-on folds thin the course.
  const stride = (start: number, end: number) => {
    let spacing = Infinity;
    for (let i = 0; i <= 6; i++) {
      const t = start + (end - start) * i / 6;
      const a = at(t, -1), b = at(t, 1);
      const t0 = at(Math.max(0, t - 0.002), 0), t1 = at(Math.min(1, t + 0.002), 0);
      const tx = t1.x - t0.x, ty = t1.y - t0.y, tl = Math.hypot(tx, ty) || 1;
      const perp = Math.abs(((b.x - a.x) * ty - (b.y - a.y) * tx) / tl);
      spacing = Math.min(spacing, perp * (1.95 / contours) / 2);
    }
    let k = 1;
    while (spacing * k < MIN_SPACING_MM && k < 64) k *= 2;
    return k;
  };
  for (let bar = 0; bar < BARS; bar++) {
    const start = bar / BARS + 0.0015, end = (bar + 1) / BARS - 0.0015;
    // Laminations crowd toward the breach and open out toward the strand ends.
    const mid = s.y0 + (start + end) / 2 * (s.y1 - s.y0);
    const loud = Math.exp(-(((mid - s.centre) / 5.5) ** 2));
    const open = !gates[bar] || (loud < 0.25 && bar % 3 === 1);
    // Strides per sub-piece; nested powers of two keep surviving contours continuous.
    const SUB = 6;
    const strides = Array.from({ length: SUB }, (_, q) =>
      stride(start + (end - start) * q / SUB, start + (end - start) * (q + 1) / SUB));
    for (let j = 0; j < contours; j++) {
      if (bar % 2 === 1 && j % 17 === 0) continue;
      const v = -0.975 + 1.95 * (j + 0.5) / contours;
      const ink: Ink = j % 13 === 0 ? 'vermilion'
        : s.id === 'a' ? (j % 4 === 0 ? 'violet' : 'ultramarine') : 'violet';
      let q = 0;
      while (q < SUB) {
        const keep = (k: number) => j % k === 0 && (!open || j % (6 * k) === 0);
        if (!keep(strides[q])) { q++; continue; }
        let r = q;
        while (r + 1 < SUB && keep(strides[r + 1])) r++;
        const a0 = start + (end - start) * q / SUB, a1 = start + (end - start) * (r + 1) / SUB;
        out.push(trace(ink, group, 5 * (r - q + 1), t => strandPoint(s, a0 + (a1 - a0) * t, v)));
        q = r + 1;
      }
    }
  }
  if (s.id === 'a') out.push(trace('acid', group, 480, t => strandPoint(s, t, 0)));
  const ribs = Math.round(densityPitch(density, 40, 120, 170));
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= ribs; i++) {
    const u = i / ribs;
    const group8 = Math.floor(i / 8);
    if (rng() < interruption * (group8 % 2 ? 1.0 : 0.42)) continue;
    const here = at(u, 0);
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < 1.1) continue;
    last = here;
    const ink: Ink = s.id === 'a'
      ? (i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine')
      : (i % 8 === 0 ? 'vermilion' : i % 3 === 0 ? 'ultramarine' : 'violet');
    out.push(trace(ink, group, 14, t => strandPoint(s, u, -0.96 + t * 1.92)));
  }
  if (s.id === 'a') {
    // Sixty-four offset pulses along the leading edge: 8 bars of 8 with built-in rests.
    for (let i = 0; i < 64; i++) {
      const bar = Math.floor(i / 8), beat = i % 8;
      if ((beat === 2 || beat === 5) && bar % 2 === 0) continue;
      if (rng() < interruption * 0.38) continue;
      const u = 0.04 + 0.92 * (i + 0.5) / 64;
      out.push(trace(bar % 2 ? 'violet' : 'acid', group, 5, t => strandPoint(s, u, -1.12 - 0.15 * t)));
    }
  }
  return out;
}

function clipArt(points: Point[]): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    let enter = 0, exit = 1;
    for (const [p, q] of [[-dx, a.x - ART.x0], [dx, ART.x1 - a.x], [-dy, a.y - ART.y0], [dy, ART.y1 - a.y]]) {
      if (p === 0) { if (q < 0) { enter = 1; exit = 0; break; } }
      else { const t = q / p; if (p < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t); }
    }
    if (enter > exit) { flush(); continue; }
    const lerp = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
    const start = lerp(enter), end = lerp(exit);
    if (run.length && (Math.hypot(run[run.length - 1].x - start.x, run[run.length - 1].y - start.y) > 0.001 || enter > 0)) flush();
    if (!run.length) run.push(start);
    run.push(end);
    if (exit < 1) flush();
  }
  flush();
  return runs;
}

function simplify(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const area = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (span > 1.4 || area > 0.15) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface TowerOptions {
  /** Depth occluders: the whole scene (default) or the architecture alone, for visibility audits. */
  occluders?: 'all' | 'architecture';
}

export function drawTower(ctx: SketchContext, options: TowerOptions = {}): Part[] {
  return towerScene(ctx, options).parts;
}

/** The plotted parts plus the slogan plan that produced any lettering. */
export function towerScene(ctx: SketchContext, options: TowerOptions = {}): { parts: Part[]; slogans: SloganPlan } {
  const architecture = towerSlabs(ctx);
  const strands = helixStrands(ctx);
  const density = n(ctx, 'hatchDensity', 0.55, 0, 1);
  const rawInterruption = n(ctx, 'interruption', 0.32, 0, 1);
  const interruption = rawInterruption <= 0.32 ? rawInterruption : 0.32 + (rawInterruption - 0.32) * 1.6;
  const rng = ctx.random('slab-interruptions');
  const beats = Array.from({ length: 64 }, () => rng() < interruption);
  const view = camera();
  const strokes: Stroke[] = architecture.flatMap((s, owner) =>
    slabStrokes(s, density, beats[(s.beat * 7) % 64]).map(stroke => ({ ...stroke, owner })));
  for (const s of strands) strokes.push(...strandStrokes(s, density, interruption, ctx, view));
  const geometries = architecture.map(slabGeometry);
  if (options.occluders !== 'architecture') {
    for (const s of strands) geometries.push(buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  }
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // Slogans: only intact stack faces, never the collapse; chosen against this same depth pass.
    const surfaces: SloganSurface[] = [];
    architecture.forEach((s, id) => {
      if (s.role === 'stack' && s.w > 1.2 && s.h > 0.3) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const pageMmPerPx = MM_Y * posterArtTransform(ctx, TABLOID_PAGE, TALL_ART).scale;
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: pageMmPerPx,
      art: { x0: ART.x0 / MM_X, x1: ART.x1 / MM_X, y0: ART.y0 / MM_Y, y1: ART.y1 / MM_Y },
    });
    const pen = INKS.find(ink => ink === ctx.params.sloganPen) ?? 'carbon';
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', points });
    const projection = projectPolylinesClipped(strokes.map(s => s.points), view, W, H);
    const buckets = new Map<string, Point[][]>();
    const removeHidden = ctx.params.occlusion !== false;
    for (let i = 0; i < projection.polylines.length; i++) {
      const stroke = strokes[projection.sourceIndices[i]];
      const key = `${stroke.group}-${stroke.ink}`;
      const text = stroke.group === 'slogan';
      const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
      const pieces = clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, pageMmPerPx) : [c]);
      for (const clipped of pieces) {
        const dense = densifyProjectedPolyline(clipped);
        const runs = removeHidden ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        for (const run of runs) {
          const mm = run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
          for (const path of clipArt(mm)) {
            // Glyph curves are millimetre-scale: keep every point.
            const reduced = text ? path : simplify(path);
            let length = 0;
            for (let j = 1; j < reduced.length; j++) {
              length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
            }
            if (reduced.length > 1 && length > (text ? 0.05 : 0.5)) {
              if (!buckets.has(key)) buckets.set(key, []);
              buckets.get(key)!.push(reduced);
            }
          }
        }
      }
    }
    const parts: Part[] = [];
    for (const group of GROUPS) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    return { parts, slogans };
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
