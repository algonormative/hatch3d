import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSketch, renderSketch } from './runner.js';
import { listPins, loadPin, pinFile, savePin } from './viewer-pins.js';
import { exportSketchPng, renderSvgPng, PNG_SCALES, pngOptions } from './export-png.js';
import { prepareRender, preparationOperations, preparationSummary, svgSha256, type PreparedDerivative } from './preparation.js';
import { sourceStamp } from './source-stamp.js';
import { queuePreparedRender, queueSketchRender, validatePlotterUploadConfig, PlotterUploadError, type PlotterUploadConfig } from './plugins/plotter-upload.js';
import { BORDER_STYLES, PAPER_SIZES } from '../../src/utils/page-finishing.js';
import type { FinishingOptions, FormatOptions, RenderResult } from '../../src/sketch/types.js';

export interface SketchServerOptions { entry: string; port?: number; outputDir?: string; plotterUpload?: PlotterUploadConfig; plotprepExecutable?: string }
export interface SketchServer { url: string; close: () => Promise<void> }

const HERE = dirname(fileURLToPath(import.meta.url));
const packedAssets = existsSync(join(HERE, 'child.js'));
const STATIC = new Map([
  ['/', ['viewer.html', 'text/html; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/controls.js', [packedAssets ? 'controls.js' : '../../packages/plot-core/src/controls.js', 'text/javascript; charset=utf-8']],
  ['/viewer-state.js', ['viewer-state.js', 'text/javascript; charset=utf-8']],
  ['/radar-view.js', [packedAssets ? 'radar-view.js' : '../../packages/plot-core/src/radar-view.js', 'text/javascript; charset=utf-8']],
  ['/navigator-view.js', [packedAssets ? 'navigator-view.js' : '../../packages/plot-core/src/navigator-view.js', 'text/javascript; charset=utf-8']],
  ['/spatial-view.js', [packedAssets ? 'spatial-view.js' : '../../packages/plot-core/src/spatial-view.js', 'text/javascript; charset=utf-8']],
  ['/svg-controls.js', [packedAssets ? 'svg-controls.js' : '../../packages/plot-core/src/svg-controls.js', 'text/javascript; charset=utf-8']],
  ['/control-geometry.js', [packedAssets ? 'control-geometry.js' : '../../packages/plot-core/src/control-geometry.js', 'text/javascript; charset=utf-8']],
  ['/control-values.js', [packedAssets ? 'control-values.js' : '../../packages/plot-core/src/control-values.js', 'text/javascript; charset=utf-8']],
  ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
  ['/controls.css', [packedAssets ? 'controls.css' : '../../packages/plot-core/src/controls.css', 'text/css; charset=utf-8']],
]);
const MAX_BODY_BYTES = 64 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body exceeds 64 KiB');
    chunks.push(data);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Expected a JSON object'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function requestId(value: unknown): string | number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[\w-]+$/.test(value)) return value;
  throw new Error('requestId must be a short string or nonnegative integer');
}

function validParams(value: unknown): value is Record<string, number | string | boolean> {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => key.length <= 100 && /^(?!__)[A-Za-z][\w-]*$/.test(key) &&
      (typeof item === 'string' && item.length <= 512 || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item))));
}

export async function startSketchServer({ entry, port = 0, outputDir, plotterUpload, plotprepExecutable }: SketchServerOptions): Promise<SketchServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port');
  if (plotterUpload) validatePlotterUploadConfig(plotterUpload);
  if (plotprepExecutable !== undefined && (typeof plotprepExecutable !== 'string' || !plotprepExecutable.trim())) throw new Error('plotprepExecutable must name an installed native executable');
  const preparationEnabled = plotprepExecutable !== undefined;
  const absoluteEntry = await realpath(resolve(entry));
  const sketchRoot = dirname(absoluteEntry);
  const defaultOutputRoot = packedAssets ? (relative(sketchRoot, process.cwd()).startsWith('..') ? process.cwd() : dirname(sketchRoot)) : join(HERE, '..', '..');
  const desiredOutput = resolve(outputDir ?? join(defaultOutputRoot, '.sketch-output', basename(sketchRoot), 'pins'));
  let existingAncestor = desiredOutput;
  let realAncestor: string;
  for (;;) {
    try { realAncestor = await realpath(existingAncestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  const plannedRealOutput = resolve(realAncestor, relative(existingAncestor, desiredOutput));
  const plannedRelative = relative(sketchRoot, plannedRealOutput);
  if (!plannedRelative.startsWith('..') && !isAbsolute(plannedRelative)) throw new Error('Pin output directory must be outside the sketch source directory');
  await mkdir(desiredOutput, { recursive: true });
  const pinsDir = await realpath(desiredOutput);
  const relativeOutput = relative(sketchRoot, pinsDir);
  if (!relativeOutput.startsWith('..') && !isAbsolute(relativeOutput)) throw new Error('Pin output directory must be outside the sketch source directory');

  let generation = 0;
  let currentController: AbortController | null = null;
  let currentGood: { generation: number; result: RenderResult; sourceStamp: string } | null = null;
  let preparationSerial = 0;
  let preparationController: AbortController | null = null;
  let currentPrepared: { generation: number; derivative: PreparedDerivative } | null = null;
  const uploadControllers = new Set<AbortController>();
  const invalidate = () => {
    generation++;
    currentController?.abort();
    preparationSerial++;
    preparationController?.abort();
    for (const controller of uploadControllers) controller.abort();
    currentGood = null;
    currentPrepared = null;
  };
  const selectedDerivative = (selected: { generation: number; result: RenderResult }, artifact: unknown, key: unknown): PreparedDerivative | null => {
    if (artifact === undefined || artifact === 'source') {
      if (key !== undefined) throw new Error('Prepared key requires the prepared artifact');
      return null;
    }
    if (artifact !== 'prepared' || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid prepared artifact selection');
    const candidate = currentPrepared;
    if (!candidate || candidate.generation !== generation || candidate.generation !== selected.generation ||
        candidate.derivative.key !== key || candidate.derivative.sourceIdentity !== selected.result.identity ||
        candidate.derivative.sourceSha256 !== svgSha256(selected.result.svg)) throw new Error('Prepared artifact is stale or unavailable');
    return candidate.derivative;
  };
  const activeRender = async (identity: unknown): Promise<typeof currentGood> => {
    const selected = currentGood;
    if (!selected || selected.generation !== generation || selected.result.identity !== identity) return null;
    const stamp = await sourceStamp(absoluteEntry, selected.result.metadata.assets).catch(() => null);
    // An older action cannot invalidate a render that took ownership while its stamp was in flight.
    if (selected !== currentGood || selected.generation !== generation) return null;
    if (stamp === selected.sourceStamp) return selected;
    invalidate();
    for (const client of eventClients) client.write('event: source-change\ndata: {}\n\n');
    return null;
  };
  const eventClients = new Set<ServerResponse>();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const notifySourceChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      for (const client of eventClients) client.write('event: source-change\ndata: {}\n\n');
    }, 120);
  };
  let watcherCheck = 0;
  const watcher: FSWatcher = watch(sketchRoot, { recursive: true }, () => {
    const selected = currentGood;
    if (!selected) {
      // A failed metadata/render leaves no current result; edits still need to wake the viewer.
      // During a render, its before/after stamps decide whether the source stayed stable.
      notifySourceChange();
      return;
    }
    const check = ++watcherCheck;
    void (async () => {
      const stamp = await sourceStamp(absoluteEntry, selected.result.metadata.assets).catch(() => null);
      if (check !== watcherCheck || selected !== currentGood || selected.generation !== generation || stamp === selected.sourceStamp) return;
      invalidate();
      notifySourceChange();
    })();
  });

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;
    try {
      const address = server.address();
      const localPort = address && typeof address !== 'string' ? address.port : port;
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
      if (!allowedHosts.has(req.headers.host ?? '')) { json(res, 403, { error: 'Local viewer only' }); return; }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && (!origin.startsWith('http://') || !allowedHosts.has(new URL(origin).host))) { json(res, 403, { error: 'Foreign origin rejected' }); return; }
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: 'Expected application/json' }); return; }
      }
      if (req.method === 'GET' && STATIC.has(path)) {
        const [file, mime] = STATIC.get(path)!;
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const bytes = await readFile(join(HERE, file));
        res.end(path === '/' && plotterUpload
          ? bytes.toString('utf8').replace('</body>', '<script type="module" src="/plotter-upload-view.js"></script></body>')
          : bytes);
        return;
      }
      if (req.method === 'GET' && path === '/plotter-upload-view.js' && plotterUpload) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(await readFile(join(HERE, 'plugins/plotter-upload-view.js')));
        return;
      }
      if (plotterUpload && req.method === 'POST' && path === '/api/plugins/plotter-upload') {
        const origin = req.headers.origin;
        if (!origin || ![...allowedHosts].some(host => origin === `http://${host}`) || req.headers['x-sketch-action'] !== 'plotter-upload') {
          json(res, 403, { error: 'Local upload action required' });
          return;
        }
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['identity', 'artifact', 'preparedKey'].includes(key)) || typeof body.identity !== 'string' || body.identity.length > 256) {
          json(res, 400, { error: 'Expected current render identity and optional artifact selection' });
          return;
        }
        const selected = await activeRender(body.identity);
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be uploaded' });
          return;
        }
        const uploadController = new AbortController();
        uploadControllers.add(uploadController);
        res.on('close', () => { if (!res.writableEnded) uploadController.abort(); });
        try {
          const derivative = selectedDerivative(selected, body.artifact, body.preparedKey);
          const guard = { signal: uploadController.signal,
            stillCurrent: async () => (await activeRender(selected.result.identity)) === selected &&
              (!derivative || currentPrepared?.derivative.key === derivative.key) };
          const id = derivative ? await queuePreparedRender(selected.result, derivative, plotterUpload, guard) : await queueSketchRender(selected.result, plotterUpload, guard);
          json(res, 201, { ok: true, id });
        } catch (error) {
          if (error instanceof PlotterUploadError && error.kind === 'upstream') json(res, 502, { error: error.message });
          else json(res, 400, { error: 'Could not prepare plotter upload' });
        } finally { uploadControllers.delete(uploadController); }
        return;
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        eventClients.add(res);
        res.on('close', () => eventClients.delete(res));
        return;
      }
      if (req.method === 'GET' && path === '/api/metadata') {
        json(res, 200, await inspectSketch({ entry: absoluteEntry }));
        return;
      }
      if (req.method === 'GET' && path === '/api/finishing-options') {
        json(res, 200, { paperSizes: PAPER_SIZES, borderStyles: BORDER_STYLES, pngScales: PNG_SCALES, preparationEnabled });
        return;
      }
      if (req.method === 'POST' && path === '/api/preparation') {
        if (!preparationEnabled) { json(res, 404, { error: 'Native preparation is disabled; reopen with --plotprep EXECUTABLE' }); return; }
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['identity', 'operations'].includes(key)) || typeof body.identity !== 'string' || body.identity.length > 256) throw new Error('Expected current render identity and preparation operations');
        const selected = await activeRender(body.identity);
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be prepared' }); return;
        }
        const operations = preparationOperations(body.operations);
        const serial = ++preparationSerial;
        preparationController?.abort();
        currentPrepared = null;
        const controller = new AbortController();
        preparationController = controller;
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const derivative = await prepareRender(selected.result, plotprepExecutable, operations, controller.signal);
          const afterStamp = await sourceStamp(absoluteEntry, selected.result.metadata.assets).catch(() => null);
          if (serial !== preparationSerial || selected !== currentGood || selected.generation !== generation || controller.signal.aborted ||
              derivative.sourceSha256 !== svgSha256(selected.result.svg) || afterStamp !== selected.sourceStamp) {
            json(res, 409, { error: 'Preparation was superseded by a source or render change' }); return;
          }
          currentPrepared = { generation, derivative };
          json(res, 200, { preparation: preparationSummary(derivative) });
        } catch (error) {
          if (serial !== preparationSerial || selected !== currentGood || selected.generation !== generation || controller.signal.aborted) {
            json(res, 409, { error: 'Preparation was superseded by a source or render change' }); return;
          }
          const kind = error && typeof error === 'object' && 'kind' in error ? (error as { kind: unknown }).kind : undefined;
          json(res, kind === 'unavailable' ? 503 : kind === 'timeout' ? 504 : 422,
            { error: kind === 'unavailable' ? `Native plotprep unavailable: ${errorMessage(error)}. Set --plotprep to the installed executable.` : errorMessage(error) });
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/preparation.svg') {
        if (!preparationEnabled) { json(res, 404, { error: 'Native preparation is disabled' }); return; }
        const selected = await activeRender(requestUrl.searchParams.get('identity'));
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be viewed' }); return;
        }
        const derivative = selectedDerivative(selected, 'prepared', requestUrl.searchParams.get('preparedKey'));
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'content-length': derivative!.bytes.length,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(derivative!.bytes);
        return;
      }
      if (req.method === 'GET' && path === '/api/export.svg') {
        const selected = await activeRender(requestUrl.searchParams.get('identity'));
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be exported' });
          return;
        }
        const slug = selected.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'sketch';
        if ([...requestUrl.searchParams.keys()].some(key => !['identity', 'artifact', 'preparedKey'].includes(key)) ||
            ['identity', 'artifact', 'preparedKey'].some(key => requestUrl.searchParams.getAll(key).length > 1)) throw new Error('Invalid SVG export query');
        const derivative = selectedDerivative(selected, requestUrl.searchParams.get('artifact') ?? undefined, requestUrl.searchParams.get('preparedKey') ?? undefined);
        const svg = derivative?.bytes ?? Buffer.from(selected.result.svg);
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-disposition': `attachment; filename="${slug}${derivative ? '-prepared' : ''}.svg"`,
          'content-length': svg.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(svg);
        return;
      }
      if (req.method === 'GET' && path === '/api/export.png') {
        const selected = await activeRender(requestUrl.searchParams.get('identity'));
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be exported' });
          return;
        }
        if ([...requestUrl.searchParams.keys()].some(key => !['identity', 'theme', 'scale', 'artifact', 'preparedKey'].includes(key)) ||
          ['identity', 'theme', 'scale', 'artifact', 'preparedKey'].some(key => requestUrl.searchParams.getAll(key).length > 1)) throw new Error('Invalid PNG export query');
        const { theme, scale } = pngOptions(requestUrl.searchParams.get('theme') ?? undefined, requestUrl.searchParams.get('scale') ?? undefined);
        const derivative = selectedDerivative(selected, requestUrl.searchParams.get('artifact') ?? undefined, requestUrl.searchParams.get('preparedKey') ?? undefined);
        const bytes = derivative ? renderSvgPng(derivative.bytes.toString('utf8'), selected.result.metadata.page, theme, scale) : exportSketchPng(selected.result, theme, scale);
        const slug = selected.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'sketch';
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-disposition': `attachment; filename="${slug}${derivative ? '-prepared' : ''}-${theme}-${scale}x.png"`,
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
        return;
      }
      if (req.method === 'POST' && path === '/api/render') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['requestId', 'params', 'seed', 'finishing', 'format'].includes(key))) throw new Error('Render request accepts only requestId, params, seed, finishing, and format');
        const id = requestId(body.requestId);
        if (!validParams(body.params)) throw new Error('Invalid params');
        if (body.seed !== undefined && (!Number.isSafeInteger(body.seed) || (body.seed as number) < 0)) throw new Error('Seed must be a nonnegative integer');
        invalidate();
        const sequence = generation;
        const controller = new AbortController();
        currentController = controller;
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const metadata = await inspectSketch({ entry: absoluteEntry, timeoutMs: 10_000, signal: controller.signal });
          const beforeStamp = await sourceStamp(absoluteEntry, metadata.assets);
          const result = await renderSketch({ entry: absoluteEntry, params: body.params, seed: body.seed as number | undefined, finishing: body.finishing as FinishingOptions | undefined,
            ...(body.format === undefined ? {} : { format: body.format as FormatOptions }), timeoutMs: 15000, signal: controller.signal });
          if (sequence !== generation || controller.signal.aborted) { json(res, 409, { requestId: id, error: 'Superseded render' }); return; }
          const afterStamp = await sourceStamp(absoluteEntry, result.metadata.assets);
          if (beforeStamp !== afterStamp) { json(res, 409, { requestId: id, error: 'Sketch source or declared assets changed during render' }); return; }
          if (sequence !== generation || controller.signal.aborted) { json(res, 409, { requestId: id, error: 'Superseded render' }); return; }
          currentGood = { generation: sequence, result, sourceStamp: afterStamp };
          json(res, 200, { requestId: id, result });
        } catch (error) {
          if (sequence !== generation || controller.signal.aborted) { json(res, 409, { requestId: id, error: 'Superseded render' }); return; }
          const message = errorMessage(error);
          json(res, /timed? out|timeout|exceeded/i.test(message) ? 504 : 422, { requestId: id, error: message });
        } finally {
          if (currentController === controller) currentController = null;
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/pins') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['identity', 'artifact', 'preparedKey'].includes(key)) || typeof body.identity !== 'string' || body.identity.length > 256) throw new Error('Invalid render identity');
        const selected = await activeRender(body.identity);
        if (!selected) {
          json(res, 409, { error: 'Only the current successful render can be pinned' });
          return;
        }
        const derivative = selectedDerivative(selected, body.artifact, body.preparedKey);
        const pin = await savePin(pinsDir, selected.result, derivative ?? undefined);
        json(res, 201, { pinId: pin.pinId, pinnedAt: pin.pinnedAt, identity: pin.result.identity });
        return;
      }
      if (req.method === 'GET' && path === '/api/pins') {
        const pins = await listPins(pinsDir);
        json(res, 200, pins.map(pin => {
          const report = pin.preparation?.report;
          return { pinId: pin.pinId, pinnedAt: pin.pinnedAt, identity: pin.result.identity, name: pin.result.metadata.name,
            page: pin.result.metadata.page,
            pens: report ? report.pens.map(pen => ({ id: pen.pen_id, color: pen.color, width: pen.stroke_width_mm, passes: pen.passes })) : pin.result.metadata.pens,
            finishing: pin.result.finishing, ...(pin.result.format === undefined ? {} : { format: pin.result.format }), params: pin.result.params, seed: pin.result.seed,
            stats: report ? { pathCount: report.geometry.output.paths, pointCount: report.geometry.output.vertices,
              lengthMm: report.geometry.output.drawn_length_mm, partCount: report.parts.filter(part => part.path_count_after > 0).length } : pin.result.stats,
            canonicalStats: pin.preparation ? pin.result.stats : undefined, preparation: pin.preparation };
        }));
        return;
      }
      const pinMatch = /^\/api\/pins\/([^/]+)(?:\/(svg|png))?$/.exec(path);
      if (req.method === 'GET' && pinMatch) {
        const [, id, kind] = pinMatch;
        if (!id) throw new Error('Invalid pin ID');
        if (!kind) { json(res, 200, await loadPin(pinsDir, id)); return; }
        const pin = await loadPin(pinsDir, id);
        const bytes = await readFile(kind === 'svg' && pin.preparation ? join(pinsDir, id, 'prepared.svg') : pinFile(pinsDir, id, kind as 'svg' | 'png'));
        res.writeHead(200, { 'content-type': kind === 'svg' ? 'image/svg+xml' : 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(bytes);
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, errorMessage(error).includes('ENOENT') ? 404 : 400, { error: errorMessage(error) });
      else res.destroy();
    }
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); });
    });
  } catch (error) { watcher.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine server address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      clearTimeout(changeTimer);
      watcher.close();
      currentController?.abort();
      preparationController?.abort();
      for (const controller of uploadControllers) controller.abort();
      for (const client of eventClients) client.end();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
