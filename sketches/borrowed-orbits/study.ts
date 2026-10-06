import type { Point, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, posterArtTransform } from '../phase-garden/poster.ts';
import { buildForbidden, guideRadii, middleRadius, WORLD } from './layout.ts';
import type { ForbiddenLayoutId, ForbiddenMember, GuideSet } from './layout.ts';
import { G } from './model.ts';
import type { Attractor, BoundaryMode, ForbiddenRegion, MarkSettings, OrbitStudyConfig, ParticleInit, Vec2 } from './model.ts';

/** Fixed integration step in seconds. A declared constant, not a control. */
export const DT = 0.1;
export const PARTICLE_MASS = 1;
/** Seeded angular jitter, as a fraction of the spacing between neighbouring particles on a guide. */
export const ANGLE_JITTER = 0.35;

export { WORLD };
export type { ForbiddenLayoutId, ForbiddenMember, GuideSet };

export type PosterFit = ReturnType<typeof posterArtTransform>;
export interface Rect { xMin: number; xMax: number; yMin: number; yMax: number }

export interface OrbitStudy {
  config: OrbitStudyConfig;
  marks: MarkSettings;
  guides: GuideSet;
  /** Draw the exact guide circles. */
  drawGuides: boolean;
  forbiddenLayout: ForbiddenLayoutId;
  forbidden: ForbiddenMember[];
  /** Hatch pitch of the forbidden solids, final page mm. */
  hatchPitch: number;
  /** Minimum trail spacing in pen widths (0 = off). */
  trailMinSpacing: number;
  /** Mass of the hidden primary, kg. */
  primaryMass: number;
  /** Hidden primary's position at step 0, m. */
  primaryPosition: Vec2;
  fit: PosterFit;
  /** Final page mm per world metre, before physical finishing (equals config.transforms.worldToPage.scale). */
  pageMmPerM: number;
  /** World metres → art coordinates (the space composePoster maps onto the page). */
  worldToArt(p: Vec2): Point;
  artToWorld(p: Point): Vec2;
  /** The art-space rectangle every mark is clipped to: the poster content frame, within the world domain. */
  frame: Rect;
}

/** A numeric control value, clamped to the declared range. */
export function numeric(ctx: SketchContext, id: string, fallback: number, min: number, max: number): number {
  const raw = ctx.params[id];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, value));
}

export function uint32(random: () => number): number {
  return Math.floor(random() * 0x100000000) >>> 0;
}

/** Mass in kg of a body whose circular orbit at radius `r` (m) about a point has period `periodS` (s): M = 4π² r³ / (G T²). */
export function massFromPeriod(r: number, periodS: number): number {
  return (4 * Math.PI * Math.PI * r * r * r) / (G * periodS * periodS);
}

/** Speed (m/s) of a circular orbit at distance r about a Plummer-softened mass: v² = G M r² / (r² + ε²)^{3/2}. */
export function circularSpeed(mass: number, r: number, softening: number): number {
  return Math.sqrt((G * mass * r * r) / Math.pow(r * r + softening * softening, 1.5));
}

/** Unit tangent of a revolution about `from` at `at`: cw reads clockwise on the page (y grows downward). */
function tangent(at: Vec2, from: Vec2, spin: 1 | -1): Vec2 {
  const rx = at.x - from.x, ry = at.y - from.y;
  const r = Math.hypot(rx, ry);
  if (r < 1e-9) return { x: 0, y: 0 };
  return { x: (-spin * ry) / r, y: (spin * rx) / r };
}

export interface ParticleSettings {
  perGuide: number;
  borrow: number;
  speedJitter: number;
  spin: 1 | -1;
  mass: number;
  softening: number;
  primary: Vec2;
}

/**
 * Seed `perGuide` particles on every guide circle at evenly spaced angles (alternate rings offset by half
 * a step) plus seeded angular jitter, each with a speed jitter. Velocity blends, by `borrow`, the circular
 * velocity about the true mass (0) and the circular velocity about the apparent centre computed as if the
 * mass sat there (1). Two draws per particle in index order, so the stream stays aligned whatever the controls.
 */
export function seedParticles(random: () => number, guides: GuideSet, s: ParticleSettings): ParticleInit[] {
  const out: ParticleInit[] = [];
  const step = (2 * Math.PI) / s.perGuide;
  guides.radii.forEach((radius, g) => {
    for (let j = 0; j < s.perGuide; j++) {
      const dAngle = random(), dSpeed = random();
      const angle = step * (j + (g % 2) * 0.5 + ANGLE_JITTER * (2 * dAngle - 1));
      const position = { x: guides.centre.x + radius * Math.cos(angle), y: guides.centre.y + radius * Math.sin(angle) };
      const toTrue = Math.hypot(position.x - s.primary.x, position.y - s.primary.y);
      const t0 = tangent(position, s.primary, s.spin), t1 = tangent(position, guides.centre, s.spin);
      const v0 = circularSpeed(s.mass, toTrue, s.softening);
      const v1 = circularSpeed(s.mass, radius, s.softening);
      const jitter = 1 + s.speedJitter * (2 * dSpeed - 1);
      out.push({
        position,
        velocity: {
          x: jitter * (s.borrow * v1 * t1.x + (1 - s.borrow) * v0 * t0.x),
          y: jitter * (s.borrow * v1 * t1.y + (1 - s.borrow) * v0 * t0.y),
        },
      });
    }
  });
  return out;
}

/** `value 0` → the plain stream name (every earlier config unchanged); n > 0 → `<name>#<n>`. */
function seededStream(ctx: SketchContext, name: string, seed: number): () => number {
  return ctx.random(seed > 0 ? `${name}#${seed}` : name);
}

/**
 * Everything that defines the simulation (`config`) and everything that only defines how a history is drawn
 * (`marks` and the other mark fields). Page mapping: the domain covers the poster target in abstract mode
 * (cover) and sits whole inside it otherwise.
 */
export function buildStudy(ctx: SketchContext): OrbitStudy {
  const fit = posterArtTransform(ctx, TABLOID_PAGE);
  const { target } = fit;
  const abstract = ctx.params.posterMode === 'abstract';
  const sx = target.width / WORLD.width;
  const sy = target.height / WORLD.height;
  const pageMmPerM = abstract ? Math.max(sx, sy) : Math.min(sx, sy);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const offset = { x: cx - (WORLD.width / 2) * pageMmPerM, y: cy - (WORLD.height / 2) * pageMmPerM };
  const worldToArt = (p: Vec2): Point => fit.inverse({ x: offset.x + p.x * pageMmPerM, y: offset.y + p.y * pageMmPerM });
  const artToWorld = (p: Point): Vec2 => {
    const page = { x: p.x * fit.scale + fit.dx, y: p.y * fit.scale + fit.dy };
    return { x: (page.x - offset.x) / pageMmPerM, y: (page.y - offset.y) / pageMmPerM };
  };
  // Content frame in art space: the poster target intersected with the world domain.
  const t0 = fit.inverse({ x: target.x, y: target.y });
  const t1 = fit.inverse({ x: target.x + target.width, y: target.y + target.height });
  const d0 = worldToArt({ x: 0, y: 0 }), d1 = worldToArt({ x: WORLD.width, y: WORLD.height });
  const frame: Rect = {
    xMin: Math.max(Math.min(t0.x, t1.x), Math.min(d0.x, d1.x)), xMax: Math.min(Math.max(t0.x, t1.x), Math.max(d0.x, d1.x)),
    yMin: Math.max(Math.min(t0.y, t1.y), Math.min(d0.y, d1.y)), yMax: Math.min(Math.max(t0.y, t1.y), Math.max(d0.y, d1.y)),
  };

  // Seeds are separated from day one. `structureSeed` reseeds only the `structure` stream (the forbidden layout),
  // `dynamicsSeed` only the `dynamics` stream (particle jitter). 0 uses the plain names.
  const structureSeed = Math.round(numeric(ctx, 'structureSeed', 0, 0, 999));
  const dynamicsSeed = Math.round(numeric(ctx, 'dynamicsSeed', 0, 0, 999));

  const centre = { x: numeric(ctx, 'centreX', 24, 0, WORLD.width), y: numeric(ctx, 'centreY', 36, 0, WORLD.height) };
  const guideInner = numeric(ctx, 'guideInner', 6, 1, 30);
  const guideOuter = Math.max(guideInner + 1, numeric(ctx, 'guideOuter', 20, 2, 40));
  const guideCount = Math.round(numeric(ctx, 'guideCount', 5, 2, 9));
  const guides: GuideSet = { centre, radii: guideRadii(guideCount, guideInner, guideOuter) };

  const softening = numeric(ctx, 'softening', 0.6, 0.05, 3);
  const captureRadius = numeric(ctx, 'captureRadius', 1.2, 0, 4);
  const primaryPosition = { x: centre.x + numeric(ctx, 'massDX', 3, -15, 15), y: centre.y + numeric(ctx, 'massDY', 5, -15, 15) };
  const primaryMass = massFromPeriod(middleRadius(guideInner, guideOuter), numeric(ctx, 'orbitPeriod', 60, 20, 180));
  const attractors: Attractor[] = [{
    id: 'mass-primary', kind: 'attractor', mass: primaryMass, position: primaryPosition, velocity: { x: 0, y: 0 },
    // Pinned by default: a mass far heavier than the perturber, so the pass bends the trails without carrying the
    // centre away. An artistic departure from two-body motion, labelled in the brief; `massPinned` off restores it.
    softening, captureRadius, dynamic: ctx.params.massPinned === false, hidden: true,
  }];
  const ratio = numeric(ctx, 'perturberRatio', 0.35, 0, 1.5);
  if (ctx.params.perturberEnabled !== false && ratio > 0) {
    // Straight-line entry: closest approach to the apparent centre at `perturberStep`, `impact` metres to one side of it.
    const angle = (numeric(ctx, 'perturberAngle', 25, -180, 180) * Math.PI) / 180;
    const impact = numeric(ctx, 'perturberImpact', 8, -40, 40);
    const speed = numeric(ctx, 'perturberSpeed', 2, 0.1, 10);
    const stepAt = Math.round(numeric(ctx, 'perturberStep', 400, 0, 2400));
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const closest = { x: centre.x - dir.y * impact, y: centre.y + dir.x * impact };
    attractors.push({
      id: 'mass-perturber', kind: 'attractor', mass: primaryMass * ratio,
      position: { x: closest.x - dir.x * speed * stepAt * DT, y: closest.y - dir.y * speed * stepAt * DT },
      velocity: { x: dir.x * speed, y: dir.y * speed }, softening, captureRadius, dynamic: true, hidden: true,
    });
  }

  const forbiddenLayout: ForbiddenLayoutId = (['bars', 'arc', 'gate'] as const).find(id => id === ctx.params.forbiddenLayout)
    ?? (ctx.params.forbiddenLayout === 'none' ? 'none' : 'bars');
  const forbidden = buildForbidden(seededStream(ctx, 'structure', structureSeed), forbiddenLayout, guides, Math.round(numeric(ctx, 'forbiddenCount', 8, 1, 24)));
  const regions: ForbiddenRegion[] = forbidden.map(member => ({ id: member.id, kind: 'forbidden', polygon: member.capture }));

  const particles = seedParticles(seededStream(ctx, 'dynamics', dynamicsSeed), guides, {
    perGuide: Math.round(numeric(ctx, 'particlesPerGuide', 60, 4, 300)),
    borrow: numeric(ctx, 'borrow', 1, 0, 1),
    speedJitter: numeric(ctx, 'speedJitter', 0.03, 0, 0.3),
    spin: ctx.params.spin === 'ccw' ? -1 : 1,
    mass: primaryMass, softening, primary: primaryPosition,
  });

  const boundary: BoundaryMode = ctx.params.boundary === 'absorb' ? 'absorb' : 'open';
  const config: OrbitStudyConfig = {
    domain: { origin: { x: 0, y: 0 }, size: { x: WORLD.width, y: WORLD.height } },
    transforms: { worldToPage: { scale: pageMmPerM, offset } },
    settings: { dt: DT, boundary, escapeMargin: numeric(ctx, 'escapeMargin', 30, 5, 100) },
    attractors,
    forbidden: regions,
    particleMass: PARTICLE_MASS,
    particles,
  };

  const marks: MarkSettings = {
    trailPen: typeof ctx.params.trailPen === 'string' ? ctx.params.trailPen : 'ultramarine',
    structurePen: typeof ctx.params.structurePen === 'string' ? ctx.params.structurePen : 'carbon',
    guidePen: typeof ctx.params.guidePen === 'string' ? ctx.params.guidePen : 'vermilion',
    trailSteps: Math.round(numeric(ctx, 'trailSteps', 400, 20, 1200)),
    taper: numeric(ctx, 'taper', 0.5, 0, 1),
    dashSeed: uint32(ctx.random('trail-dashes')),
  };
  return {
    config, marks, guides, drawGuides: ctx.params.drawGuides !== false, forbiddenLayout, forbidden,
    hatchPitch: numeric(ctx, 'hatchPitch', 1, 0.3, 6), trailMinSpacing: numeric(ctx, 'trailMinSpacing', 0, 0, 10),
    primaryMass, primaryPosition, fit, pageMmPerM, worldToArt, artToWorld, frame,
  };
}
