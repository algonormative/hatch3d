import { createHash } from 'node:crypto';
import { createPlotprepClient, type PlotprepReport, type PrepareOptions } from '@hatch3d/plotprep-node';
import type { RenderResult } from '../../src/sketch/types.js';

export type PreparationOperations = Omit<PrepareOptions, 'signal'>;

export interface PreparedDerivative {
  key: string;
  sourceIdentity: string;
  sourceSha256: string;
  preparedSha256: string;
  operations: PreparationOperations;
  bytes: Buffer;
  report: PlotprepReport;
  sourceReport: PlotprepReport;
  preparedAt: string;
}

export const svgSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function physicalColor(color: string): string | null {
  const value = color.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) return `#${[...short[1]].map(channel => channel + channel).join('')}`;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return ({ black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff' } as Record<string, string>)[value] ?? null;
}

function samePhysicalPlan(result: RenderResult, report: PlotprepReport): boolean {
  const page = result.metadata.page;
  if (Math.abs(report.page.width_mm - page.width) > 0.001 || Math.abs(report.page.height_mm - page.height) > 0.001) return false;
  if (report.pens.length !== result.metadata.pens.length) return false;
  return report.pens.every((pen, index) => {
    const expected = result.metadata.pens[index];
    return pen.pen_id === expected.id && pen.layer_number === index + 1 &&
      Math.abs(pen.stroke_width_mm - expected.width) <= 0.001 && pen.passes === (expected.passes ?? 1) &&
      (physicalColor(expected.color) === null || physicalColor(expected.color) === physicalColor(pen.color));
  });
}

export function preparationOperations(value: unknown): PreparationOperations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Preparation operations must be an object');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['curveToleranceMm', 'sort', 'allowReverse', 'mergeToleranceMm', 'mergeScope', 'simplifyToleranceMm']);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error('Unknown preparation operation');
  for (const key of ['sort', 'allowReverse'] as const) if (record[key] !== undefined && typeof record[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  for (const key of ['curveToleranceMm', 'mergeToleranceMm', 'simplifyToleranceMm'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || (record[key] as number) < 0 || (record[key] as number) > 10)) {
      throw new Error(`${key} must be a finite number between 0 and 10 mm`);
    }
  }
  if (record.mergeScope !== undefined && record.mergeScope !== 'named-parts' && record.mergeScope !== 'pen') throw new Error('mergeScope must be named-parts or pen');
  if (record.mergeToleranceMm !== undefined && record.mergeScope === undefined) throw new Error('mergeScope is required with mergeToleranceMm');
  if (record.mergeScope !== undefined && record.mergeToleranceMm === undefined) throw new Error('mergeToleranceMm is required with mergeScope');
  return structuredClone(record) as PreparationOperations;
}

export async function prepareRender(result: RenderResult, executable: string | undefined, operations: PreparationOperations, signal?: AbortSignal): Promise<PreparedDerivative> {
  const sourceSha256 = svgSha256(result.svg);
  const client = createPlotprepClient({ executable });
  const prepared = await client.prepareSvg(Buffer.from(result.svg), { ...operations, signal });
  if (prepared.sourceReport.source.sha256 !== sourceSha256 || prepared.report.source.sha256 !== sourceSha256 ||
      prepared.report.prepared?.sha256 !== svgSha256(prepared.bytes) ||
      !samePhysicalPlan(result, prepared.sourceReport) || !samePhysicalPlan(result, prepared.report)) {
    throw new Error('Native preparation does not match the current canonical page and pen plan');
  }
  const preparedSha256 = prepared.report.prepared!.sha256;
  const key = svgSha256(`${result.identity}\0${sourceSha256}\0${preparedSha256}\0${JSON.stringify(operations)}`);
  return { key, sourceIdentity: result.identity, sourceSha256, preparedSha256,
    operations: structuredClone(operations), bytes: Buffer.from(prepared.bytes), report: prepared.report,
    sourceReport: prepared.sourceReport, preparedAt: new Date().toISOString() };
}

export function preparationSummary(prepared: PreparedDerivative) {
  return {
    key: prepared.key,
    sourceIdentity: prepared.sourceIdentity,
    sourceSha256: prepared.sourceSha256,
    preparedSha256: prepared.preparedSha256,
    operations: prepared.operations,
    report: prepared.report,
    sourceReport: prepared.sourceReport,
    preparedAt: prepared.preparedAt,
  };
}
