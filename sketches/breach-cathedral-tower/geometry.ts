import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../src/projection.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { TABLOID_PAGE, TALL_ART, posterArtTransform } from '../phase-garden/poster.ts';
import { lineRough, scratchLetterRun, scratchRandom, scratchRun, type LineFamily } from '../phase-garden/scratch.ts';
import { clamp, n } from '../kit/params.ts';
import { clipToRect } from '../kit/page.ts';
import { restPattern } from '../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../kit/strokes.ts';
import { clearBands, letterScratch, planSlogans, sloganSettings, titleSettings, type SloganPlan, type SloganSurface } from '../kit/lettering.ts';
import {
  POSTER_HALF_H, POSTER_HALF_W, POSTER_MM_PER_UNIT, slabGeometry, slabMatrix, slabStrokes, solid, type Slab,
} from '../kit/slabs.ts';
import { TOWER_BOT, TOWER_TOP, collapseBand, helixStrands, strandPoint, strandStrokes, type Collapse } from '../kit/helix.ts';
import type { Ink } from '../kit/types.ts';

// The slab and helix building blocks live in the sketch kit; they are re-exported here for older importers.
export { densityPitch, slabGeometry, slabMatrix, slabStrokes, solid, type Role, type Slab } from '../kit/slabs.ts';
export { collapseBand, helixStrands, strandPoint, strandStrokes, type Collapse, type Strand } from '../kit/helix.ts';
export type { Ink };
export type Group = 'tower' | 'collapse' | 'strand-a' | 'strand-b' | 'slogan' | 'title';
/** `owner` is the index of the solid a stroke belongs to, so slogan bands clear only its own hatch. */
export type Stroke = { ink: Ink; group: Group; points: THREE.Vector3[]; owner?: number; family?: LineFamily; cap?: number };
export const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS: Group[] = ['tower', 'collapse', 'strand-a', 'strand-b', 'slogan', 'title'];
// Depth pixels: two per page millimetre, aspect matched to the 11 × 17 sheet.
const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const ART = { x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width, y0: TALL_ART.y, y1: TALL_ART.y + TALL_ART.height };
const HALF_H = POSTER_HALF_H;
const HALF_W = POSTER_HALF_W;
/** Page millimetres per world unit. */
export const MM_PER_UNIT = POSTER_MM_PER_UNIT;
const BOT = TOWER_BOT, TOP = TOWER_TOP;
const SIDE = 6.55; // outermost centre for anything that moves outward


export function camera(): THREE.OrthographicCamera {
  const view = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 80);
  view.up.set(0, 1, 0);
  view.position.set(3.2, -5.8, 19.5);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
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

/** Clip a page polyline to the art window. */
export const clipArt = (points: Point[]): Point[][] => clipToRect(points, ART);

export { simplify } from '../kit/page.ts';

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
  const beats = restPattern(rng, interruption);
  const view = camera();
  // The first six strokes of every solid are its outline edges (front, back, four depth edges).
  const strokes: Stroke[] = architecture.flatMap((s, owner) =>
    slabStrokes(s, density, beats[(s.beat * 7) % 64]).map((stroke, k): Stroke => ({ ...stroke, owner, family: k < 6 ? 'edge' : 'hatch' })));
  for (const s of strands) strokes.push(...strandStrokes(s, density, interruption, ctx, view).map((stroke): Stroke => ({ ...stroke, family: 'membrane' })));
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
    const pen = sloganSettings(ctx).pen as Ink;
    slogans.strokes.forEach((points, k) => strokes.push({ ink: pen, group: 'slogan', points, cap: slogans.strokeCaps[k] }));
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', points, cap: slogans.titleCap });
    // Ruled lettering: the slab-edge hand, scaled to each line's cap height.
    const ruled = letterScratch(ctx) === 'ruled';
    const letterLevel = { slogan: sloganSettings(ctx).rough, title: titleSettings(ctx).rough };
    const buckets = new PartBuckets();
    const removeHidden = ctx.params.occlusion !== false;
    const scratch = lineRough(ctx);
    const scratchEnv = { depth, bias: 0.0014, mmPerPx: pageMmPerPx };
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      hidden: () => removeHidden,
      pieces: (c, stroke) => {
        const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
        return bands ? clearBands(c, bands, pageMmPerPx) : [c];
      },
      begin: (stroke, index, whole) => {
        const key = `${stroke.group}-${stroke.ink}`;
        const srng = scratch > 0 && stroke.family ? scratchRandom(ctx.seed, 'line-scratch', index) : undefined;
        const letterRough = ruled && (stroke.group === 'slogan' || stroke.group === 'title') ? letterLevel[stroke.group] : 0;
        const lrng = letterRough > 0 ? scratchRandom(ctx.seed, 'letter-scratch', index) : undefined;
        const text = stroke.group === 'slogan' || stroke.group === 'title';
        return seen => {
          // Scratching acts on what is already visible; its added marks are depth-tested again.
          const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
          const runs = srng ? seen.flatMap(run => scratchRun(run, stroke.family!, scratch, srng,
            [near(run[0], whole[0]), near(run.at(-1)!, whole.at(-1)!)], scratchEnv))
            : lrng ? seen.flatMap(run => scratchLetterRun(run, letterRough, lrng, scratchEnv, stroke.cap!)) : seen;
          for (const run of runs) {
            // Glyph curves are millimetre-scale: keep every point.
            for (const path of clipArt(scalePoints(run, MM_X, MM_Y))) buckets.add(key, path, text);
          }
        };
      },
    });
    const parts = buckets.toParts(GROUPS, [...INKS, 'lettering']);
    return { parts, slogans };
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
