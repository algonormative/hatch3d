/** Public local Node host for the plot-core Sketch contract. */
export { SketchRunnerError } from './errors.js';
import type { FinishingOptions, FormatOptions, Params, RenderResult, SketchMetadata } from '@hatch3d/plot-core';
import { inspectSketch as inspect, renderSketch as render } from '../../../cli/sketch/runner.ts';
import { startSketchServer as start } from '../../../cli/sketch/server.ts';
import { exportSketchPng as exportPng, pngOptions as parsePng, PNG_SCALES as scales } from '../../../cli/sketch/export-png.ts';
import { runExperimentBatch as runBatch } from '../../../cli/sketch/experiments.ts';
import type { ExperimentBatchOptions, ExperimentManifest } from './experiment-types.js';
export type { ExperimentBatchOptions, ExperimentCandidate, ExperimentInputFingerprint, ExperimentManifest, ExperimentMatrix, ExperimentRegime, ExperimentSource, ExperimentStatus } from './experiment-types.js';

export interface RenderOptions { entry: string; params?: Params; seed?: number; finishing?: FinishingOptions; format?: FormatOptions; timeoutMs?: number; signal?: AbortSignal }
export interface InspectOptions { entry: string; timeoutMs?: number; signal?: AbortSignal }
export function renderSketch(options: RenderOptions): Promise<RenderResult> { return render(options); }
export function inspectSketch(options: InspectOptions): Promise<SketchMetadata> { return inspect(options); }

export interface PlotterUploadConfig { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }
export interface SketchServerOptions { entry: string; port?: number; outputDir?: string; plotterUpload?: PlotterUploadConfig; plotprepExecutable?: string }
export interface SketchServer { url: string; close: () => Promise<void> }
export function startSketchServer(options: SketchServerOptions): Promise<SketchServer> { return start(options); }

export type PngTheme = 'paper' | 'light' | 'dark';
export const PNG_SCALES = scales;
export function pngOptions(theme: unknown = 'paper', scale: unknown = 6): { theme: PngTheme; scale: number } { return parsePng(theme, scale); }
export function exportSketchPng(result: RenderResult, theme: PngTheme = 'paper', scale = 6): Buffer { return exportPng(result, theme, scale); }
export function runExperimentBatch(options: ExperimentBatchOptions): Promise<ExperimentManifest> { return runBatch(options); }
