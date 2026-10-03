import type { BufferGeometry } from 'three';
import type { Page, Pen, Navigator, Sketch } from './types.js';
import type { Legacy2DOptions, Legacy2DComposition } from './planar.js';
import type { LegacyCompositionMetadata } from './legacy-types.js';

/** UV hatch settings accepted by the existing Hatch3D 3D composition adapter. */
export interface HatchSettings {
  family?: 'u' | 'v' | 'diagonal' | 'rings' | 'hex' | 'crosshatch' | 'spiral' | 'wave';
  count?: number; samples?: number; uRange?: [number, number]; vRange?: [number, number]; angle?: number;
  waveAmplitude?: number; waveFrequency?: number; noiseAmplitude?: number; noiseFrequency?: number;
  dashLength?: number; gapLength?: number; dashRandom?: number;
  densityFn?: (u: number, v: number) => number; densityOversample?: number;
  stipple?: { dotsPerUnit?: number; dotSize?: number; shape?: 'point' | 'cross'; seed?: number };
  clipFn?: (u: number, v: number) => boolean;
  seed?: number; placement?: 'uniform' | 'dyadic';
}
export interface Legacy3DCompositionInput {
  surface: string;
  surfaceParams: Record<string, number>;
  hatchParams: HatchSettings;
  values: Record<string, unknown>;
}
export interface Legacy3DLayer {
  surface: string;
  params?: Record<string, number>;
  hatch: HatchSettings;
  transform?: { x?: number; y?: number; z?: number };
  group?: string;
}
/** Legacy geometry composition. The adapter still emits one solids pen part. */
export interface Legacy3DComposition extends LegacyCompositionMetadata {
  id: string; category?: '2d' | '3d' | 'layered'; type?: '3d';
  layers(input: Legacy3DCompositionInput): Legacy3DLayer[];
  hatchGroups?: string[];
  buildDepthMesh?: (input: Legacy3DCompositionInput) => BufferGeometry | null;
  occlusionSensitive?: boolean;
}
export interface Legacy3DOptions {
  composition: Legacy3DComposition;
  page: Page;
  pen: Pen;
  prefix?: string;
  canvas?: { width: number; height: number };
  defaults?: Record<string, number | boolean | string>;
  surfaceKey?: string;
  surfaceParams?: Record<string, number>;
  viewDefaults?: Record<string, number | boolean | string>;
  navigators?: Navigator[];
  xyAxisLabels?: Record<string, [string, string]>;
  paper?: Omit<Legacy2DOptions, 'page'> & { composition: Legacy2DComposition };
}
export declare function createHatch3d3DSketch(options: Legacy3DOptions): Sketch;
