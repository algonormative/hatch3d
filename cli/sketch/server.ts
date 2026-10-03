import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSketch, renderSketch } from './runner.js';
import { listPins, loadPin, pinFile, savePin } from './viewer-pins.js';
import { exportSketchPng, PNG_SCALES, pngOptions } from './export-png.js';
import { BORDER_STYLES, PAPER_SIZES } from '../../src/utils/page-finishing.js';
import type { FinishingOptions, RenderResult } from '../../src/sketch/types.js';

export interface SketchServerOptions { entry: string; port?: number; outputDir?: string }
export interface SketchServer { url: string; close: () => Promise<void> }

const STATIC = new Map([
  ['/', ['viewer.html', 'text/html; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/viewer-state.js', ['viewer-state.js', 'text/javascript; charset=utf-8']],
  ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
]);
const HERE = dirname(fileURLToPath(import.meta.url));
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
      (typeof item === 'string' && item.length <= 100 || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item))));
}

export async function startSketchServer({ entry, port = 0, outputDir }: SketchServerOptions): Promise<SketchServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port');
  const absoluteEntry = await realpath(resolve(entry));
  const sketchRoot = dirname(absoluteEntry);
  const desiredOutput = resolve(outputDir ?? join(HERE, '..', '..', '.sketch-output', basename(sketchRoot), 'pins'));
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
  let currentGood: { generation: number; result: RenderResult } | null = null;
  const eventClients = new Set<ServerResponse>();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher: FSWatcher = watch(sketchRoot, { recursive: true }, () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      generation++;
      currentController?.abort();
      currentGood = null;
      for (const client of eventClients) client.write('event: source-change\ndata: {}\n\n');
    }, 120);
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
        res.end(await readFile(join(HERE, file)));
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
        json(res, 200, { paperSizes: PAPER_SIZES, borderStyles: BORDER_STYLES, pngScales: PNG_SCALES });
        return;
      }
      if (req.method === 'GET' && path === '/api/export.svg') {
        const selected = currentGood;
        if (!selected || selected.generation !== generation || selected.result.identity !== requestUrl.searchParams.get('identity')) {
          json(res, 409, { error: 'Only the current successful render can be exported' });
          return;
        }
        const slug = selected.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'sketch';
        const svg = selected.result.svg;
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-disposition': `attachment; filename="${slug}.svg"`,
          'content-length': Buffer.byteLength(svg),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(svg);
        return;
      }
      if (req.method === 'GET' && path === '/api/export.png') {
        const selected = currentGood;
        if (!selected || selected.generation !== generation || selected.result.identity !== requestUrl.searchParams.get('identity')) {
          json(res, 409, { error: 'Only the current successful render can be exported' });
          return;
        }
        if ([...requestUrl.searchParams.keys()].some(key => !['identity', 'theme', 'scale'].includes(key)) ||
          ['identity', 'theme', 'scale'].some(key => requestUrl.searchParams.getAll(key).length > 1)) throw new Error('Invalid PNG export query');
        const { theme, scale } = pngOptions(requestUrl.searchParams.get('theme') ?? undefined, requestUrl.searchParams.get('scale') ?? undefined);
        const bytes = exportSketchPng(selected.result, theme, scale);
        const slug = selected.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'sketch';
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-disposition': `attachment; filename="${slug}-${theme}-${scale}x.png"`,
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
        return;
      }
      if (req.method === 'POST' && path === '/api/render') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['requestId', 'params', 'seed', 'finishing'].includes(key))) throw new Error('Render request accepts only requestId, params, seed, and finishing');
        const id = requestId(body.requestId);
        if (!validParams(body.params)) throw new Error('Invalid params');
        if (body.seed !== undefined && (!Number.isSafeInteger(body.seed) || (body.seed as number) < 0)) throw new Error('Seed must be a nonnegative integer');
        const sequence = ++generation;
        currentController?.abort();
        currentGood = null;
        const controller = new AbortController();
        currentController = controller;
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const result = await renderSketch({ entry: absoluteEntry, params: body.params, seed: body.seed as number | undefined, finishing: body.finishing as FinishingOptions | undefined, timeoutMs: 15000, signal: controller.signal });
          if (sequence !== generation || controller.signal.aborted) { json(res, 409, { requestId: id, error: 'Superseded render' }); return; }
          currentGood = { generation: sequence, result };
          json(res, 200, { requestId: id, result });
        } catch (error) {
          if (sequence !== generation || controller.signal.aborted) { json(res, 409, { requestId: id, error: 'Superseded render' }); return; }
          const message = errorMessage(error);
          json(res, /timed? out|timeout|exceeded/i.test(message) ? 504 : 422, { requestId: id, error: message });
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/pins') {
        const body = await readJson(req);
        if (typeof body.identity !== 'string' || body.identity.length > 256) throw new Error('Invalid render identity');
        const selected = currentGood;
        if (!selected || selected.generation !== generation || selected.result.identity !== body.identity) {
          json(res, 409, { error: 'Only the current successful render can be pinned' });
          return;
        }
        const pin = await savePin(pinsDir, selected.result);
        json(res, 201, { pinId: pin.pinId, pinnedAt: pin.pinnedAt, identity: pin.result.identity });
        return;
      }
      if (req.method === 'GET' && path === '/api/pins') {
        const pins = await listPins(pinsDir);
        json(res, 200, pins.map(pin => ({ pinId: pin.pinId, pinnedAt: pin.pinnedAt, identity: pin.result.identity, name: pin.result.metadata.name, page: pin.result.metadata.page, pens: pin.result.metadata.pens, finishing: pin.result.finishing, params: pin.result.params, seed: pin.result.seed, stats: pin.result.stats })));
        return;
      }
      const pinMatch = /^\/api\/pins\/([^/]+)(?:\/(svg|png))?$/.exec(path);
      if (req.method === 'GET' && pinMatch) {
        const [, id, kind] = pinMatch;
        if (!id) throw new Error('Invalid pin ID');
        if (!kind) { json(res, 200, await loadPin(pinsDir, id)); return; }
        const bytes = await readFile(pinFile(pinsDir, id, kind as 'svg' | 'png'));
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
      for (const client of eventClients) client.end();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
