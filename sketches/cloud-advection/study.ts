import type { Point, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, posterArtTransform } from '../phase-garden/poster.ts';
import type { CloudStudyConfig, MarkSettings, SolidRegion, Vec2, Vortex } from './model.ts';
import { WORLD, FIN_THICKNESS, buildStructure } from './layout.ts';
import type { LayoutId, MemberKind, StructureMember } from './layout.ts';

/** Grid spacing in metres: 120 × 195 cells. */
export const GRID_SPACING = 0.4;
/** Fixed integration step in seconds. A declared constant, not a control. */
export const DT = 0.5;
/** Contour feature size handed to the hatcher, final page mm. */
export const FEATURE_SCALE_MM = 30;
/** Preferred wisp tangent, radians. */
export const HATCH_ANGLE = -0.38;

export { WORLD, FIN_THICKNESS, buildStructure };
export type { StructureMember, MemberKind, LayoutId };

export type MarkStyle = 'contours' | 'streaks' | 'both';

/** Flow-streak settings. Like MarkSettings, they never enter simulation hashes. */
export interface StreakSettings {
  pen: string;
  /** Mean seed spacing, final page mm. */
  spacing: number;
  /** Seed for the jittered seed grid (named stream `cloud-streaks`). */
  seed: number;
}

export type PosterFit = ReturnType<typeof posterArtTransform>;

export interface CloudStudy {
  config: CloudStudyConfig;
  marks: MarkSettings;
  /** How the snapshot is drawn: contour wisps, flow streaks, or both. */
  style: MarkStyle;
  /** Contour culling: nearest-contour distance as a fraction of the cloud hatch pitch (0 = off). */
  contourMinSpacing: number;
  streak: StreakSettings;
  layout: LayoutId;
  structure: StructureMember[];
  fit: PosterFit;
  /** Final page mm per world metre, before physical finishing (equals config.transforms.worldToPage.scale). */
  pageMmPerM: number;
  /** World metres → art coordinates (the space composePoster maps onto the page). */
  worldToArt(p: Vec2): Point;
  artToWorld(p: Point): Vec2;
}

/** A numeric control value, clamped to the declared range. */
function numeric(ctx: SketchContext, id: string, fallback: number, min: number, max: number): number {
  const raw = ctx.params[id];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, value));
}

function uint32(random: () => number): number {
  return Math.floor(random() * 0x100000000) >>> 0;
}

/**
 * Everything that defines the simulation (`config`) and everything that only
 * defines how a snapshot is drawn (`marks`). Page mapping: the domain covers the
 * poster target in abstract mode (cover) and sits whole inside it otherwise.
 */
export function buildStudy(ctx: SketchContext): CloudStudy {
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

  const layout: LayoutId = (['span', 'colonnade', 'portal', 'ring'] as const).find(id => id === ctx.params.layout) ?? 'orbit';
  const structure = buildStructure(ctx.random('structure'), layout, numeric(ctx, 'structureDensity', 0.6, 0, 1), Math.round(numeric(ctx, 'ringCount', 8, 4, 12)));
  const solids: SolidRegion[] = structure.map(member => ({ id: member.id, kind: 'solid', polygon: member.polygon }));

  const eddyCirculation = numeric(ctx, 'eddyCirculation', 30, -120, 120);
  const eddyCore = numeric(ctx, 'eddyCore', 3, 0.5, 12);
  const eddyCenter = { x: numeric(ctx, 'eddyX', 32, 0, WORLD.width), y: numeric(ctx, 'eddyY', 24, 0, WORLD.height) };
  const vortices: Vortex[] = [{ id: 'eddy-a', kind: 'vortex', center: eddyCenter, circulation: eddyCirculation, coreRadius: eddyCore }];
  if (eddyCirculation !== 0) {
    // A weaker counter-rotating partner, mirrored through the domain centre.
    vortices.push({
      id: 'eddy-b', kind: 'vortex', circulation: -0.6 * eddyCirculation, coreRadius: eddyCore * 1.2,
      center: { x: WORLD.width - eddyCenter.x, y: WORLD.height - eddyCenter.y },
    });
  }
  const sourceSize = numeric(ctx, 'sourceSize', 8, 1, 20);
  const smokeRandom = ctx.random('smoke-source');
  const boundaryMode = ctx.params.boundary === 'closed' || ctx.params.boundary === 'inflow' ? ctx.params.boundary : 'open';
  const config: CloudStudyConfig = {
    domain: { origin: { x: 0, y: 0 }, size: { x: WORLD.width, y: WORLD.height } },
    transforms: {
      worldToGrid: { origin: { x: 0, y: 0 }, spacing: GRID_SPACING, cols: Math.round(WORLD.width / GRID_SPACING), rows: Math.round(WORLD.height / GRID_SPACING) },
      worldToPage: { scale: pageMmPerM, offset },
    },
    settings: {
      dt: DT,
      boundary: boundaryMode,
      diffusivity: numeric(ctx, 'dispersion', 0.1, 0, 5),
    },
    wind: { id: 'wind', kind: 'uniform-wind', velocity: { x: numeric(ctx, 'windX', 0.7, -6, 6), y: numeric(ctx, 'windY', 0.8, -6, 6) } },
    vortices,
    source: {
      id: 'smoke-source', kind: 'source',
      center: { x: numeric(ctx, 'sourceX', 14, 0, WORLD.width), y: numeric(ctx, 'sourceY', 8, 0, WORLD.height) },
      radii: { x: sourceSize, y: sourceSize * 1.5 },
      amplitude: ctx.params.sourceEnabled === false ? 0 : 1, noiseScale: sourceSize * 0.45, seed: uint32(smokeRandom),
    },
    solids,
    // Eddies stay put unless asked; `fixed` is the sim's default and is left out of the config (and the hash).
    ...(ctx.params.eddyDrift === 'wind' || ctx.params.eddyDrift === 'kirchhoff' ? { eddyDrift: ctx.params.eddyDrift } : {}),
    // Upstream weather arrives through the upwind edges only in `inflow` mode; it is hashed whenever present.
    ...(boundaryMode === 'inflow' ? { front: {
      id: 'weather-front' as const, kind: 'frozen-field' as const,
      amplitude: numeric(ctx, 'frontAmplitude', 0.8, 0, 2), scale: numeric(ctx, 'frontScale', 12, 2, 40),
      coverage: numeric(ctx, 'frontCoverage', 0.5, 0, 1), softness: numeric(ctx, 'frontSoftness', 0.12, 0.02, 0.5), seed: uint32(ctx.random('weather-front')),
      fillInterior: ctx.params.fillInterior !== false,
    } } : {}),
  };

  const coreRadius = numeric(ctx, 'coreRadius', 34, 0, 120);
  const marks: MarkSettings = {
    referenceDensity: numeric(ctx, 'referenceDensity', 0.8, 0.02, 4),
    cloudPen: typeof ctx.params.cloudPen === 'string' ? ctx.params.cloudPen : 'cyan',
    structurePen: 'carbon',
    hatchSpacing: numeric(ctx, 'cloudHatchPitch', 2, 0.5, 12),
    hatchAngle: HATCH_ANGLE,
    featureScale: FEATURE_SCALE_MM,
    obscure: numeric(ctx, 'obscure', 0.8, 0, 1),
    core: {
      center: {
        x: TABLOID_PAGE.width / 2 + numeric(ctx, 'coreX', 0, -120, 120),
        y: TABLOID_PAGE.height / 2 + numeric(ctx, 'coreY', 0, -200, 200),
      },
      radius: coreRadius,
    },
    wispSeed: uint32(ctx.random('cloud-wisps')),
  };
  const style: MarkStyle = ctx.params.markStyle === 'both' || ctx.params.markStyle === 'streaks' ? ctx.params.markStyle : 'contours';
  const streak: StreakSettings = {
    pen: typeof ctx.params.streakPen === 'string' ? ctx.params.streakPen : 'coral',
    spacing: numeric(ctx, 'streakSpacing', 4, 1, 20),
    seed: uint32(ctx.random('cloud-streaks')),
  };
  return { config, marks, style, contourMinSpacing: numeric(ctx, 'contourMinSpacing', 0.55, 0, 1), streak, layout, structure, fit, worldToArt, artToWorld, pageMmPerM };
}
