import type { Point } from './types.js';
export type MacroFn = 'linear' | 'log' | 'exp' | 'sqrt';
export interface MacroDef { label: string; default: number; targets: { param: string; fn: MacroFn; strength: number }[] }
interface BaseControl { label: string; group: string; showWhen?: { control: string; equals: unknown } }
export type ControlDef =
  | (BaseControl & { type: 'slider'; default: number; min: number; max: number; step?: number })
  | (BaseControl & { type: 'toggle'; default: boolean })
  | (BaseControl & { type: 'select'; default: string; options: { label: string; value: string }[] })
  | (BaseControl & { type: 'xy'; default: [number, number]; min: number; max: number })
  | (BaseControl & { type: 'image'; sampleSize?: number });
export interface LegacyCompositionMetadata {
  name: string; controls?: Record<string, ControlDef>; macros?: Record<string, MacroDef>;
}
/** Existing Hatch3D 2D generator in canvas coordinates, mapped to page millimeters by the adapter. */
export interface Legacy2DComposition extends LegacyCompositionMetadata {
  id: string; category?: '2d' | '3d' | 'layered'; type?: '2d';
  generate(input: { width: number; height: number; values: Record<string, unknown> }): Point[][];
}
