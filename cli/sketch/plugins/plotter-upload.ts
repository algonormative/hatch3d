import { createHash } from 'node:crypto';
import type { RenderResult } from '../../../src/sketch/types.js';
import { exportSketchPng, renderSvgPng } from '../export-png.js';
import { svgSha256, type PreparedDerivative } from '../preparation.js';

/** This module has no network side effects until queueSketchRender is called. */
export interface PlotterUploadConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PlotterUploadError extends Error {
  constructor(public readonly kind: 'config' | 'upstream', message: string) {
    super(message);
    this.name = 'PlotterUploadError';
  }
}

export function validatePlotterUploadConfig(config: PlotterUploadConfig): URL {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new PlotterUploadError('config', 'FEED_API_URL must be an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname) {
    throw new PlotterUploadError('config', 'FEED_API_URL must be an HTTPS origin without credentials, path, query, or fragment');
  }
  if (!config.token || /[\r\n]/.test(config.token)) throw new PlotterUploadError('config', 'FEED_API_TOKEN must be set');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000)) {
    throw new PlotterUploadError('config', 'Upload timeout must be 1 to 60000 milliseconds');
  }
  return url;
}

/** Stable across retries, and different if the canonical SVG changes. */
export function plotterQueueId(result: RenderResult): string {
  const digest = createHash('sha256').update(result.identity).update('\0').update(result.svg).digest('hex');
  return `hatch3d-sketch-${digest}`;
}

export function plotterQueueConfig(result: RenderResult, svgKey: string, pngKey: string): Record<string, unknown> {
  return {
    format: 'hatch3d-sketch-v1',
    identity: result.identity,
    composition: 'sketch',
    presetName: result.metadata.name,
    svg_key: svgKey,
    png_key: pngKey,
    page: result.metadata.page,
    pens: result.metadata.pens,
    layers: result.metadata.pens.map(pen => ({
      id: pen.id, color: pen.color, width: pen.width, passes: pen.passes ?? 1,
      parts: result.parts.filter(part => !part.diagnostic && part.pen === pen.id).map(part => part.id),
    })),
    params: result.params,
    ...(result.effectiveParams ? { effectiveParams: result.effectiveParams } : {}),
    seed: result.seed,
    ...(result.finishing ? { finishing: result.finishing } : {}),
    stats: result.stats,
  };
}

export function preparedQueueId(result: RenderResult, derivative: PreparedDerivative): string {
  return `hatch3d-prepared-${createHash('sha256').update(result.identity).update('\0').update(derivative.sourceSha256).update('\0').update(derivative.preparedSha256).digest('hex')}`;
}

export function preparedQueueConfig(result: RenderResult, derivative: PreparedDerivative, sourceSvgKey: string, preparedSvgKey: string, pngKey: string): Record<string, unknown> {
  const nativePens = derivative.report.pens;
  const pens = nativePens.map(pen => ({ id: pen.pen_id!, color: pen.color, width: pen.stroke_width_mm, passes: pen.passes }));
  return {
    ...plotterQueueConfig(result, preparedSvgKey, pngKey),
    page: result.metadata.page,
    pens,
    layers: nativePens.map(pen => ({ id: pen.pen_id!, color: pen.color, width: pen.stroke_width_mm, passes: pen.passes,
      parts: derivative.report.parts.filter(part => part.layer_number === pen.layer_number && part.path_count_after > 0).map(part => part.part_id) })),
    stats: { pathCount: derivative.report.geometry.output.paths, pointCount: derivative.report.geometry.output.vertices,
      lengthMm: derivative.report.geometry.output.drawn_length_mm, partCount: derivative.report.parts.filter(part => part.path_count_after > 0).length },
    preparation: { schema_version: 1, source_svg_key: sourceSvgKey, source_sha256: derivative.sourceSha256, prepared_sha256: derivative.preparedSha256 },
  };
}

interface QueueArtifacts { id: string; title: string; svg: Uint8Array; png: Uint8Array; sourceSvg?: Uint8Array; config: Record<string, unknown> }
export interface QueueGuard { signal?: AbortSignal; stillCurrent?: () => Promise<boolean> }

async function queueArtifacts(artifacts: QueueArtifacts, config: PlotterUploadConfig, guard: QueueGuard = {}): Promise<string> {
  const base = validatePlotterUploadConfig(config);
  const { id } = artifacts;
  const svgKey = `plotter/${id}.svg`;
  const pngKey = `plotter/${id}.png`;
  const sourceSvgKey = `plotter/${id}-source.svg`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = (path: string) => new URL(path, base).href;
  const post = async (path: string, contentType: string, body: BodyInit, acknowledge = false): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
    const cancel = () => controller.abort();
    guard.signal?.addEventListener('abort', cancel, { once: true });
    if (guard.signal?.aborted) controller.abort();
    try {
      const response = await fetchImpl(url(path), {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': contentType },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new PlotterUploadError('upstream', `Print queue request failed (${response.status})`);
      if (!acknowledge) { await response.body?.cancel(); return; }
      // A 200 login page or malformed response cannot be reported as a queued item.
      const reader = response.body?.getReader();
      if (!reader) throw new PlotterUploadError('upstream', 'Print queue did not acknowledge upload');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          throw new PlotterUploadError('upstream', 'Print queue acknowledgement exceeded size limit');
        }
        chunks.push(chunk.value);
      }
      let receipt: unknown;
      try {
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        receipt = JSON.parse(new TextDecoder().decode(data));
      } catch { throw new PlotterUploadError('upstream', 'Print queue did not acknowledge upload'); }
      if (typeof receipt !== 'object' || receipt === null || (receipt as { ok?: unknown }).ok !== true || (receipt as { id?: unknown }).id !== id) {
        throw new PlotterUploadError('upstream', 'Print queue did not acknowledge upload');
      }
    } catch (error) {
      if (error instanceof PlotterUploadError) throw error;
      throw new PlotterUploadError('upstream', 'Print queue request failed or timed out');
    } finally { clearTimeout(timer); guard.signal?.removeEventListener('abort', cancel); }
  };
  // The queue row is last: a retry reuses identical keys and the worker's INSERT OR IGNORE ID.
  if (artifacts.sourceSvg) await post(`/image/${sourceSvgKey}`, 'image/svg+xml; charset=utf-8', new Uint8Array(artifacts.sourceSvg));
  await post(`/image/${svgKey}`, 'image/svg+xml; charset=utf-8', new Uint8Array(artifacts.svg));
  await post(`/image/${pngKey}`, 'image/png', new Uint8Array(artifacts.png));
  if (guard.signal?.aborted || guard.stillCurrent && !(await guard.stillCurrent())) throw new PlotterUploadError('config', 'Current render changed before queue publication');
  await post('/print-queue', 'application/json', JSON.stringify({
    id,
    title: artifacts.title,
    composition: 'sketch',
    svg_key: svgKey,
    png_key: pngKey,
    config: JSON.stringify(artifacts.config),
    source: 'hatch3d',
  }), true);
  return id;
}

export async function queueSketchRender(result: RenderResult, config: PlotterUploadConfig, guard?: QueueGuard): Promise<string> {
  const id = plotterQueueId(result);
  const svgKey = `plotter/${id}.svg`;
  const pngKey = `plotter/${id}.png`;
  return queueArtifacts({ id, title: result.metadata.name, svg: new TextEncoder().encode(result.svg),
    png: exportSketchPng(result, 'paper', 6), config: plotterQueueConfig(result, svgKey, pngKey) }, config, guard);
}

export async function queuePreparedRender(result: RenderResult, derivative: PreparedDerivative, config: PlotterUploadConfig, guard?: QueueGuard): Promise<string> {
  if (derivative.sourceIdentity !== result.identity || derivative.sourceSha256 !== svgSha256(result.svg) ||
      derivative.preparedSha256 !== svgSha256(derivative.bytes)) throw new PlotterUploadError('config', 'Prepared upload does not match the current canonical render');
  const id = preparedQueueId(result, derivative);
  const svgKey = `plotter/${id}.svg`;
  const sourceSvgKey = `plotter/${id}-source.svg`;
  const pngKey = `plotter/${id}.png`;
  const png = renderSvgPng(derivative.bytes.toString('utf8'), result.metadata.page, 'paper', 6);
  return queueArtifacts({ id, title: result.metadata.name, svg: derivative.bytes, sourceSvg: new TextEncoder().encode(result.svg),
    png, config: preparedQueueConfig(result, derivative, sourceSvgKey, svgKey, pngKey) }, config, guard);
}
