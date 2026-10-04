import type { Point, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, posterArtTransform } from '../phase-garden/poster.ts';
import type { CloudStudyConfig, MarkSettings, SolidRegion, Vec2, Vortex } from './model.ts';

/** World domain in metres; its aspect matches the abstract Tabloid target. */
export const WORLD = Object.freeze({ width: 48, height: 78 });
/** Grid spacing in metres: 120 × 195 cells. */
export const GRID_SPACING = 0.4;
/** Fixed integration step in seconds. A declared constant, not a control. */
export const DT = 0.5;
/** Fin plate thickness, deliberately thinner than a grid cell. */
export const FIN_THICKNESS = 0.15;
/** Contour feature size handed to the hatcher, final page mm. */
export const FEATURE_SCALE_MM = 30;
/** Preferred wisp tangent, radians. */
export const HATCH_ANGLE = -0.38;

export type MemberKind = 'slab' | 'pier' | 'fin';

/** An architectural member. It is both a solid in the simulation and a drawn outline. */
export interface StructureMember {
  /** Simulation id, `solid-<name>`. */
  id: string;
  name: string;
  kind: MemberKind;
  /** Physical pen the member is drawn in. */
  pen: string;
  /** World metres; simple polygon. */
  polygon: Vec2[];
  /** Interior hatch direction in art space, radians. */
  hatchAngle: number;
}

export type PosterFit = ReturnType<typeof posterArtTransform>;

export interface CloudStudy {
  config: CloudStudyConfig;
  marks: MarkSettings;
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

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const snap = (v: number): number => Math.round(v * 20) / 20;

/**
 * Members enter from the left and right frame edges and stop short of the
 * middle: a missing span of about fourteen metres. Variation comes from the
 * `structure` stream; every polygon is in world metres.
 */
export function buildStructure(random: () => number): StructureMember[] {
  const jitter = (amount: number): number => snap((random() - 0.5) * 2 * amount);
  const W = WORLD.width;
  const members: StructureMember[] = [];
  const add = (name: string, kind: MemberKind, pen: string, polygon: Vec2[], hatchAngle: number): void => {
    members.push({ id: `solid-${name}`, name, kind, pen, polygon, hatchAngle });
  };
  // Heavy decks. They run past the domain edge so they touch the frame.
  const aEnd = 16.4 + jitter(1.2);
  const aY = 12 + jitter(1.5);
  add('deck-a', 'slab', 'carbon', rect(-2, aY, aEnd, aY + 4.4), 0.9);
  const bStart = 32 + jitter(1.2);
  const bY = 34 + jitter(1.5);
  add('deck-b', 'slab', 'carbon', rect(bStart, bY, W + 2, bY + 4.6), -0.9);
  const cEnd = 13.5 + jitter(1.5);
  const cY = 63 + jitter(1.5);
  add('deck-c', 'slab', 'carbon', rect(-2, cY, cEnd, cY + 3.6), 0.9);
  // Piers.
  const pierAX = aEnd - 6.2 + jitter(0.6);
  add('pier-a', 'pier', 'ultramarine', rect(pierAX, aY + 4.4, pierAX + 3.2, aY + 33), -0.9);
  const pierBX = bStart + 5.4 + jitter(0.6);
  add('pier-b', 'pier', 'ultramarine', rect(pierBX, bY + 4.6, pierBX + 3.2, bY + 38), 0.9);
  // One thin fin plate, thinner than a cell; it must still stop transport.
  const finX = 24.6 + jitter(0.6);
  const finY = 46 + jitter(1);
  add('fin', 'fin', 'violet', rect(finX, finY, finX + FIN_THICKNESS, finY + 17.5), 0.9);
  return members;
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

  const structure = buildStructure(ctx.random('structure'));
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
  const config: CloudStudyConfig = {
    domain: { origin: { x: 0, y: 0 }, size: { x: WORLD.width, y: WORLD.height } },
    transforms: {
      worldToGrid: { origin: { x: 0, y: 0 }, spacing: GRID_SPACING, cols: Math.round(WORLD.width / GRID_SPACING), rows: Math.round(WORLD.height / GRID_SPACING) },
      worldToPage: { scale: pageMmPerM, offset },
    },
    settings: {
      dt: DT,
      boundary: ctx.params.boundary === 'closed' ? 'closed' : 'open',
      diffusivity: numeric(ctx, 'dispersion', 0.1, 0, 5),
    },
    wind: { id: 'wind', kind: 'uniform-wind', velocity: { x: numeric(ctx, 'windX', 0.7, -6, 6), y: numeric(ctx, 'windY', 0.8, -6, 6) } },
    vortices,
    source: {
      id: 'smoke-source', kind: 'source',
      center: { x: numeric(ctx, 'sourceX', 14, 0, WORLD.width), y: numeric(ctx, 'sourceY', 8, 0, WORLD.height) },
      radii: { x: sourceSize, y: sourceSize * 1.5 },
      amplitude: 1, noiseScale: sourceSize * 0.45, seed: uint32(smokeRandom),
    },
    solids,
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
  return { config, marks, structure, fit, worldToArt, artToWorld, pageMmPerM };
}
