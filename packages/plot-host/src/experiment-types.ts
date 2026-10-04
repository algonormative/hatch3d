import type { FinishingOptions, Params } from '@hatch3d/plot-core';

export interface ExperimentSource { id: string; entry: string }
export interface ExperimentRegime { id: string; params: Params }
export interface ExperimentMatrix {
  sources: ExperimentSource[]; regimes: ExperimentRegime[]; seeds: number[];
  finishing?: FinishingOptions;
  png?: { theme?: 'paper' | 'light' | 'dark'; scale?: 1 | 2 | 3 | 4 | 6 | 8 };
}
export type ExperimentStatus = 'success' | 'failed' | 'stale' | 'cancelled';
export interface ExperimentInputFingerprint {
  kind: 'external' | 'repository'; fingerprint: string; sourceSha256: string; dependencySha256: string;
  revision?: string; toolkit?: { core: string; host: string };
}
export interface ExperimentCandidate {
  id: string; sourceId: string; regimeId: string; seed: number; entry: string; key: string; requestSha256: string;
  request: { params: Params; seed: number; finishing?: FinishingOptions };
  sourceFingerprint: string; status: ExperimentStatus; reused?: boolean; identity?: string;
  artifacts?: { svg: string; png: string; result: string; sha256: { svg: string; png: string; result: string } };
  error?: string;
}
export interface ExperimentManifest {
  version: 1; pipelineVersion: number; matrixSha256: string; status: 'running' | 'complete' | 'stopped';
  runtime: { node: string; platform: string; arch: string };
  matrix: ExperimentMatrix; sources: Record<string, ExperimentInputFingerprint>; candidates: ExperimentCandidate[];
}
export interface ExperimentBatchOptions { matrix: ExperimentMatrix; outputDir: string; baseDir?: string; timeoutMs?: number; signal?: AbortSignal }
