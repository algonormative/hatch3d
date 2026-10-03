import { createHash } from 'node:crypto';
import type { RenderResult } from '../../../src/sketch/types.js';
import { exportSketchPng } from '../export-png.js';

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

export async function queueSketchRender(result: RenderResult, config: PlotterUploadConfig): Promise<string> {
  const base = validatePlotterUploadConfig(config);
  const id = plotterQueueId(result);
  const svgKey = `plotter/${id}.svg`;
  const pngKey = `plotter/${id}.png`;
  // The same renderer and default options as the viewer's PNG export.
  const png = exportSketchPng(result, 'paper', 6);
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = (path: string) => new URL(path, base).href;
  const post = async (path: string, contentType: string, body: BodyInit, acknowledge = false): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
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
    } finally { clearTimeout(timer); }
  };
  // The queue row is last: a retry reuses identical keys and the worker's INSERT OR IGNORE ID.
  await post(`/image/${svgKey}`, 'image/svg+xml; charset=utf-8', new TextEncoder().encode(result.svg));
  await post(`/image/${pngKey}`, 'image/png', new Uint8Array(png));
  await post('/print-queue', 'application/json', JSON.stringify({
    id,
    title: result.metadata.name,
    composition: 'sketch',
    svg_key: svgKey,
    png_key: pngKey,
    config: JSON.stringify(plotterQueueConfig(result, svgKey, pngKey)),
    source: 'hatch3d',
  }), true);
  return id;
}
