import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { RenderResult, SketchMetadata } from '../sketch/types';

const runner = vi.hoisted(() => ({ inspectSketch: vi.fn(), renderSketch: vi.fn() }));
const watcherGate = vi.hoisted(() => ({ suppress: false }));
vi.mock('node:fs', async () => {
  const { createRequire } = await import('node:module');
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const watch = (filename: string, options: { recursive?: boolean }, listener: (...args: unknown[]) => void) =>
    fs.watch(filename, options, (eventType, path) => { if (!watcherGate.suppress) listener(eventType, path); });
  return { ...fs, watch, default: { ...fs, watch } };
});
vi.mock('../../cli/sketch/runner.js', () => runner);
vi.mock('../../cli/sketch/source-stamp.js', () => ({
  sourceStamp: vi.fn(async (entry: string) => (await import('node:fs/promises')).readFile(entry, 'utf8')),
}));

import { startSketchServer, type SketchServer } from '../../cli/sketch/server';
import { sourceStamp } from '../../cli/sketch/source-stamp.js';
import { inspectSvg, penPathCounts, reconcileControls, reconcileHiddenPens } from '../../cli/sketch/viewer-state.js';

const metadata: SketchMetadata = {
  name: 'Test study',
  page: { width: 100, height: 150, paper: '#fff7ed' },
  pens: [{ id: 'ink', color: '#101010', width: 0.3 }],
  controls: [{ type: 'slider', id: 'pitch', label: 'Pitch', default: 2, min: 1, max: 5, step: 1 }],
  assets: {},
};

function result(identity: string, pitch = 2): RenderResult {
  return {
    schemaVersion: 1, metadata, params: { pitch }, seed: 3, identity,
    parts: [{ id: 'marks', pen: 'ink', paths: [[{ x: 1, y: 1 }, { x: 10, y: 10 }]] }],
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="150mm" viewBox="0 0 100 150"><g data-part-id="marks"><path d="M1 1 L10 10" stroke="#101010" fill="none"/></g></svg>`,
    diagnostics: [], stats: { pathCount: 1, pointCount: 2, lengthMm: 12.7, partCount: 1 }, durationMs: 4,
  };
}

describe('local sketch viewer', () => {
  let temporary: string;
  let entry: string;
  let outputDir: string;
  let server: SketchServer;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'sketch-viewer-'));
    const source = join(temporary, 'source');
    await mkdir(source);
    entry = join(source, 'index.ts');
    outputDir = join(temporary, 'pins');
    await writeFile(entry, 'export default {}');
    runner.inspectSketch.mockReset().mockResolvedValue(metadata);
    runner.renderSketch.mockReset().mockResolvedValue(result('first'));
    server = await startSketchServer({ entry, outputDir });
  });

  afterEach(async () => {
    watcherGate.suppress = false;
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function expectSourceChangeAfterEdit(nextSource: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const events = await fetch(new URL('/api/events', server.url), { signal: controller.signal });
      reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
      await writeFile(entry, nextSource);
      let message = '';
      while (!message.includes('event: source-change')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Source event stream ended before the edit was reported');
        message += new TextDecoder().decode(chunk.value);
      }
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => {});
      controller.abort();
    }
  }

  it('serves a complete browser module graph from its HTTP routes', async () => {
    const visited = new Set<string>();
    const pending = ['/viewer.js'];
    while (pending.length) {
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await fetch(new URL(path, server.url));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/javascript');
      const source = await response.text();
      for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
        pending.push(new URL(match[1], new URL(path, server.url)).pathname);
      }
    }
    expect(visited).toContain('/control-values.js');
    expect(visited).toContain('/control-geometry.js');
  });

  it('returns metadata and preserves only compatible values after source edits', async () => {
    const response = await fetch(new URL('/api/metadata', server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metadata);
    const previous = [metadata.controls[0], { type: 'toggle', id: 'fog', label: 'Fog', default: false }];
    const next = [
      { ...metadata.controls[0], max: 3 },
      { type: 'toggle', id: 'fog', label: 'Fog', default: false },
      { type: 'select', id: 'mood', label: 'Mood', default: 'calm', options: ['calm', 'wild'] },
    ];
    expect(reconcileControls(previous, { pitch: 4, fog: true }, next)).toEqual({
      params: { pitch: 2, fog: true, mood: 'calm' },
      incompatible: [{ id: 'pitch', oldValue: 4, reason: 'Type, range, step, or option changed' }],
    });
  });

  it('combines pen visibility and named-part isolation without changing canonical layers', () => {
    const full = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">' +
      '<g data-pen-id="black" inkscape:groupmode="layer" inkscape:label="1-black"><g data-part-id="sky"><path d="M0 0"/></g><g data-part-id="street"><path d="M1 1"/></g></g>' +
      '<g data-pen-id="blue" inkscape:groupmode="layer" inkscape:label="2-blue"><g data-part-id="sea"><path d="M2 2"/></g></g>' +
      '<g data-pen-id="red" inkscape:groupmode="layer" inkscape:label="3-red"><g data-part-id="sun"><path d="M3 3"/></g></g></svg>';
    expect(inspectSvg(full, '', new Set())).toBe(full);
    const inspected = new DOMParser().parseFromString(inspectSvg(full, 'street', new Set(['blue'])), 'image/svg+xml');
    expect(inspected.querySelector('[data-pen-id="blue"]')?.getAttribute('display')).toBe('none');
    expect(inspected.querySelector('[data-part-id="sky"]')?.getAttribute('display')).toBe('none');
    expect(inspected.querySelector('[data-part-id="street"]')?.getAttribute('display')).toBeNull();
    expect(inspected.querySelector('[data-inspection-diagnostics]')).toBeNull(); // isolating a plotted part hides diagnostics
    expect(inspected.querySelector('[data-part-id="sun"]')?.getAttribute('display')).toBe('none');
    const allHidden = new DOMParser().parseFromString(inspectSvg(full, '', new Set(['black', 'blue', 'red'])), 'image/svg+xml');
    expect([...allHidden.querySelectorAll('[data-pen-id]')].every(layer => layer.getAttribute('display') === 'none')).toBe(true);
    expect(full).not.toContain('display="none"');
    expect(full).toContain('inkscape:label="3-red"');
  });

  it('adds diagnostic paths only to the inspection image', () => {
    const full = '<svg xmlns="http://www.w3.org/2000/svg"><g data-pen-id="ink"><g data-part-id="marks"><path d="M1,1L2,2"/></g></g></svg>';
    const parts = [{ id: 'mesh', pen: 'ink', diagnostic: true, paths: [[{ x: 3, y: 4 }, { x: 5, y: 6 }]] }];
    const pens = [{ id: 'ink', color: '#123456', width: 0.3 }];
    const image = inspectSvg(full, '', new Set(), parts, pens);
    const parsed = new DOMParser().parseFromString(image, 'image/svg+xml');
    expect(parsed.querySelector('[data-inspection-diagnostics] [data-diagnostic-part-id="mesh"] path')?.getAttribute('d')).toBe('M3,4L5,6');
    expect(parsed.querySelector('[data-inspection-diagnostics] [data-diagnostic-part-id="mesh"]')?.getAttribute('stroke')).toBe('#123456');
    expect(inspectSvg(full, '', new Set(['ink']), parts, pens)).not.toContain('data-inspection-diagnostics');
    expect(inspectSvg(full, 'marks', new Set(), parts, pens)).not.toContain('data-inspection-diagnostics');
    expect(full).not.toContain('mesh');
  });

  it('counts plotted paths for arbitrary pens and retains hidden IDs across reordered renders', () => {
    const pens = [
      { id: 'black', color: '#111', width: 0.3 },
      { id: 'blue', color: '#33f', width: 0.5 },
      { id: 'red', color: '#f33', width: 0.2 },
    ];
    const parts = [
      { id: 'a', pen: 'black', paths: [[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 2, y: 2 }]] },
      { id: 'b', pen: 'black', paths: [[{ x: 0, y: 0 }, { x: 2, y: 2 }]] },
      { id: 'c', pen: 'red', paths: [[{ x: 0, y: 0 }, { x: 3, y: 3 }]] },
      { id: 'guide', pen: 'blue', diagnostic: true, paths: [[{ x: 0, y: 0 }, { x: 4, y: 4 }]] },
    ];
    expect(penPathCounts(pens, parts)).toEqual(new Map([['black', 3], ['blue', 0], ['red', 1]]));
    expect([...reconcileHiddenPens(new Set(['black', 'blue']), [pens[2], pens[1], { id: 'green', color: '#0f0', width: 0.4 }])]).toEqual(['blue']);
  });

  it('rejects a superseded render and pins only the latest successful full SVG', async () => {
    runner.renderSketch.mockImplementation(({ params, signal }: { params: { pitch: number }; signal: AbortSignal }) => {
      if (params.pitch === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return Promise.resolve(result('second', params.pitch));
    });
    const first = post('/api/render', { requestId: 1, params: { pitch: 1 }, seed: 3 });
    await new Promise(done => setTimeout(done, 40));
    const second = await post('/api/render', { requestId: 2, params: { pitch: 3 }, seed: 3 });
    expect(second.status).toBe(200);
    expect((await second.json()).result.identity).toBe('second');
    expect((await first).status).toBe(409);
    expect((await post('/api/pins', { identity: 'first' })).status).toBe(409);
    const pinResponse = await post('/api/pins', { identity: 'second' });
    expect(pinResponse.status).toBe(201);
    const { pinId } = await pinResponse.json();
    expect(await readFile(join(outputDir, pinId, 'art.svg'), 'utf8')).toBe(result('second', 3).svg);
    expect((await readFile(join(outputDir, pinId, 'preview.png'))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const stored = JSON.parse(await readFile(join(outputDir, pinId, 'result.json'), 'utf8'));
    expect(stored.result).toMatchObject({ identity: 'second', params: { pitch: 3 }, seed: 3 });
    expect((await readdir(join(outputDir, pinId))).sort()).toEqual(['art.svg', 'preview.png', 'result.json']);

    runner.renderSketch.mockRejectedValue(new Error('bad geometry'));
    expect((await post('/api/render', { requestId: 3, params: { pitch: 4 }, seed: 3 })).status).toBe(422);
    expect((await post('/api/pins', { identity: 'second' })).status).toBe(409);
    expect((await fetch(new URL(`/api/pins/${pinId}/svg`, server.url))).status).toBe(200);
    expect((await fetch(new URL('/api/pins', server.url))).status).toBe(200);
  });

  it('serves exact canonical SVG as an attachment only for the current successful identity', async () => {
    const exported = (identity: string) => fetch(new URL(`/api/export.svg?identity=${encodeURIComponent(identity)}`, server.url));
    expect((await exported('first')).status).toBe(409);
    expect((await post('/api/render', { requestId: 1, params: { pitch: 2 }, seed: 3 })).status).toBe(200);
    const current = await exported('first');
    expect(current.status).toBe(200);
    expect(current.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    expect(current.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9-]+\.svg"$/);
    expect(await current.text()).toBe(result('first').svg);
    expect((await exported('old-identity')).status).toBe(409);

    let rejectPending: ((error: Error) => void) | undefined;
    runner.renderSketch.mockImplementation(() => new Promise((_resolve, reject) => { rejectPending = reject; }));
    const pending = post('/api/render', { requestId: 2, params: { pitch: 3 }, seed: 3 });
    await vi.waitFor(() => expect(rejectPending).toBeTypeOf('function'));
    expect((await exported('first')).status).toBe(409);
    rejectPending!(new Error('bad geometry'));
    expect((await pending).status).toBe(422);
    expect((await exported('first')).status).toBe(409);

    runner.renderSketch.mockResolvedValue(result('second'));
    expect((await post('/api/render', { requestId: 3, params: { pitch: 2 }, seed: 3 })).status).toBe(200);
    await writeFile(entry, 'export default { changed: true }');
    await vi.waitFor(async () => expect((await exported('second')).status).toBe(409), { timeout: 1500 });
  });

  it('does not let an old action stamp invalidate a newer render', async () => {
    const stamp = vi.mocked(sourceStamp);
    let releaseStamp: ((value: string) => void) | undefined;
    let completeRender: ((value: RenderResult) => void) | undefined;
    let oldExport: Promise<Response> | undefined;
    let newer: Promise<Response> | undefined;
    watcherGate.suppress = true;
    try {
      expect((await post('/api/render', { requestId: 1 })).status).toBe(200);
      const priorCalls = stamp.mock.calls.length;
      stamp.mockImplementationOnce(() => new Promise(resolve => { releaseStamp = resolve; }));
      oldExport = fetch(new URL('/api/export.svg?identity=first', server.url));
      await vi.waitFor(() => expect(stamp.mock.calls.length).toBe(priorCalls + 1));

      runner.renderSketch.mockImplementationOnce(() => new Promise(resolve => { completeRender = resolve; }));
      newer = post('/api/render', { requestId: 2 });
      await vi.waitFor(() => expect(completeRender).toBeTypeOf('function'));
      releaseStamp!(await readFile(entry, 'utf8'));
      expect((await oldExport).status).toBe(409);
      completeRender!(result('second'));
      const response = await newer;
      expect(response.status, await response.text()).toBe(200);
      expect((await fetch(new URL('/api/export.svg?identity=second', server.url))).status).toBe(200);
    } finally {
      releaseStamp?.(await readFile(entry, 'utf8'));
      completeRender?.(result('second'));
      if (oldExport) await oldExport.catch(() => undefined);
      if (newer) await newer.catch(() => undefined);
      stamp.mockReset().mockImplementation(async path => readFile(path, 'utf8'));
      watcherGate.suppress = false;
    }
  });

  it('notifies a source fix after initial metadata fails', async () => {
    runner.inspectSketch.mockRejectedValueOnce(new Error('Invalid sketch syntax'));
    expect((await fetch(new URL('/api/metadata', server.url))).status).toBe(400);
    await expectSourceChangeAfterEdit('export default { fixed: true };\n');
  });

  it('notifies a source fix after a failed rerender clears the last good result', async () => {
    expect((await post('/api/render', { requestId: 1 })).status).toBe(200);
    runner.renderSketch.mockRejectedValueOnce(new Error('Invalid sketch geometry'));
    expect((await post('/api/render', { requestId: 2 })).status).toBe(422);
    await expectSourceChangeAfterEdit('export default { repaired: true };\n');
  });

  it('notifies a source edit during a pending render even when that render becomes stale', async () => {
    let completeRender!: (value: RenderResult) => void;
    runner.renderSketch.mockImplementationOnce(() => new Promise(resolve => { completeRender = resolve; }));
    const pending = post('/api/render', { requestId: 1 });
    await vi.waitFor(() => expect(completeRender).toBeTypeOf('function'));
    await expectSourceChangeAfterEdit('export default { editedDuringRender: true };\n');
    completeRender(result('first'));
    const response = await pending;
    expect(response.status, await response.text()).toBe(409);
  });

  it('marks a timed-out render as failed and never offers its previous result for pinning', async () => {
    expect((await post('/api/render', { requestId: 1, params: { pitch: 2 }, seed: 3 })).status).toBe(200);
    runner.renderSketch.mockRejectedValue(new Error('Sketch render exceeded 15000 ms'));
    const response = await post('/api/render', { requestId: 2, params: { pitch: 3 }, seed: 3 });
    expect(response.status).toBe(504);
    expect((await response.json()).error).toMatch(/exceeded/);
    expect((await post('/api/pins', { identity: 'first' })).status).toBe(409);
  });

  it('rejects foreign origins, oversized bodies, and output inside the sketch directory', async () => {
    const foreign = await fetch(new URL('/api/render', server.url), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' }, body: '{}' });
    expect(foreign.status).toBe(403);
    const oversized = await post('/api/render', { requestId: 1, params: { pitch: 2 }, padding: 'x'.repeat(70_000) });
    expect(oversized.status).toBe(400);
    await expect(startSketchServer({ entry, outputDir: join(temporary, 'source', 'pins') })).rejects.toThrow(/outside/);
    await symlink(join(temporary, 'source'), join(temporary, 'source-link'));
    await expect(startSketchServer({ entry, outputDir: join(temporary, 'source-link', 'pins') })).rejects.toThrow(/outside/);
    await expect(access(join(temporary, 'source', 'pins'))).rejects.toThrow();
  });
});

it('uses successful render pens for the sidebar and filters only the current inspection image', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  const pens = [
    { id: 'black', color: '#111111', width: 0.3 },
    { id: 'blue', color: '#3344cc', width: 0.5 },
    { id: 'red', color: '#cc4433', width: 0.2 },
  ];
  const layered = {
    ...result('layered'),
    metadata: { ...metadata, pens },
    parts: [
      { id: 'sky', pen: 'black', paths: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]] },
      { id: 'street', pen: 'black', paths: [[{ x: 0, y: 0 }, { x: 2, y: 2 }]] },
      { id: 'sun', pen: 'red', paths: [[{ x: 0, y: 0 }, { x: 3, y: 3 }]] },
      { id: 'guide', pen: 'blue', diagnostic: true, paths: [[{ x: 0, y: 0 }, { x: 4, y: 4 }]] },
    ],
    svg: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">' +
      '<g data-pen-id="black" inkscape:groupmode="layer"><g data-part-id="sky"><path d="M0 0"/></g><g data-part-id="street"><path d="M1 1"/></g></g>' +
      '<g data-pen-id="blue" inkscape:groupmode="layer"></g>' +
      '<g data-pen-id="red" inkscape:groupmode="layer"><g data-part-id="sun"><path d="M2 2"/></g></g></svg>',
  };
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('EventSource', class { addEventListener() {} });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/metadata') return Promise.resolve(response(layered.metadata));
    if (url === '/api/finishing-options') return Promise.resolve(response({ paperSizes: { a4: { label: 'A4', w: 210, h: 297 } }, borderStyles: { simple: 'Simple' }, pngScales: [1, 2, 3, 4, 6, 8] }));
    if (url === '/api/pins') return Promise.resolve(response([]));
    if (url === '/api/render') return Promise.resolve(response({ requestId: 2, result: layered }));
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', { value: (blob: Blob) => { blobs.push(blob); return `blob:preview-${blobs.length}`; }, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  try {
    await import('../../cli/sketch/viewer.js');
    await vi.waitFor(() => expect(document.getElementById('pen-count')?.textContent).toBe('3 layers · 3 passes'));
    expect(document.getElementById('paper-size')?.textContent).toBe('100 × 150 mm');
    const initialPreview = new DOMParser().parseFromString(await readBlob(blobs.at(-1)!), 'image/svg+xml');
    expect(initialPreview.querySelector('[data-diagnostic-part-id="guide"] path')?.getAttribute('d')).toBe('M0,0L4,4');
    expect(document.getElementById('inspection-note')?.textContent).toMatch(/diagnostic geometry preview only, excluded from pin and export/);
    expect([...document.querySelectorAll('.pen-details')].map(row => row.textContent)).toEqual([
      '1. black0.3 mm · 2 plotted paths', '2. blue0.5 mm · 0 plotted paths', '3. red0.2 mm · 1 plotted path',
    ]);
    const blue = document.querySelector<HTMLInputElement>('input[aria-label="Show blue pen layer"]')!;
    blue.focus();
    blue.click();
    expect(document.activeElement).toBe(blue);
    const part = document.getElementById('part') as HTMLSelectElement;
    part.value = 'street';
    part.dispatchEvent(new Event('change'));
    const inspected = new DOMParser().parseFromString(await readBlob(blobs.at(-1)!), 'image/svg+xml');
    expect(inspected.querySelector('[data-pen-id="blue"]')?.getAttribute('display')).toBe('none');
    expect(inspected.querySelector('[data-part-id="sky"]')?.getAttribute('display')).toBe('none');
    expect(inspected.querySelector('[data-part-id="street"]')?.getAttribute('display')).toBeNull();
    expect(inspected.querySelector('[data-inspection-diagnostics]')).toBeNull(); // isolating a plotted part hides diagnostics
    expect(document.getElementById('inspection-note')?.textContent).toMatch(/1 of 3 pen layers hidden/);
    document.querySelector<HTMLInputElement>('input[aria-label="Show black pen layer"]')!.click();
    document.querySelector<HTMLInputElement>('input[aria-label="Show red pen layer"]')!.click();
    expect(document.getElementById('inspection-note')?.textContent).toMatch(/all pen layers hidden/);
    expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(false);
    const previewWithDiagnostics = new DOMParser().parseFromString(await readBlob(blobs.at(-1)!), 'image/svg+xml');
    expect(previewWithDiagnostics.querySelector('[data-inspection-diagnostics]')).toBeNull(); // all pens are hidden
    expect(layered.svg).not.toContain('data-inspection-diagnostics');
    expect(layered.svg).not.toContain('data-part-id="guide"');
    expect(layered.svg).not.toContain('display="none"');
  } finally {
    vi.unstubAllGlobals();
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.replaceChildren();
  }
});

it('keeps a failed new render stale when an earlier pin request completes', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  let finishPin: ((value: Response) => void) | undefined;
  let renders = 0;
  let pinSaved = false;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('EventSource', class { addEventListener() {} });
  vi.stubGlobal('fetch', vi.fn());
  // The mocked POST /api/pins needs a different branch from the pins list.
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (url === '/api/metadata') return Promise.resolve(response(metadata));
    if (url === '/api/finishing-options') return Promise.resolve(response({ paperSizes: { a4: { label: 'A4', w: 210, h: 297 } }, borderStyles: { simple: 'Simple' }, pngScales: [1, 2, 3, 4, 6, 8] }));
    if (url === '/api/pins' && options?.method === 'POST') return new Promise<Response>(resolve => { finishPin = resolve; });
    if (url === '/api/pins') return Promise.resolve(response(pinSaved ? [{
      pinId: 'old-pin', pinnedAt: '2026-10-02T12:00:00.000Z', identity: 'first', name: 'Test study',
      page: { width: 80, height: 80, paper: '#f0d0c0' }, params: { pitch: 2 }, seed: 0, stats: result('first').stats,
    }] : []));
    if (url === '/api/render') {
      renders++;
      return Promise.resolve(renders === 1 ? response({ requestId: 2, result: result('first') }) :
        renders === 2 ? response({ requestId: 4, error: 'bad geometry' }, 422) : response({ requestId: 6, result: result('third') }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  try {
    await import('../../cli/sketch/viewer.js');
    await vi.waitFor(() => expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(false));
    (document.getElementById('pin') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(finishPin).toBeTypeOf('function'));
    const slider = document.getElementById('control-pitch') as HTMLInputElement;
    slider.value = '3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Render failed/), { timeout: 1000 });
    pinSaved = true;
    finishPin!(response({ pinId: 'old-pin' }, 201));
    await vi.waitFor(() => expect((document.getElementById('pin-select') as HTMLSelectElement).value).toBe('old-pin'), { timeout: 1000 });
    expect(document.getElementById('status')?.textContent).toMatch(/Render failed/);
    expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(true);
    const pinFrame = document.getElementById('pin-art')!.parentElement!;
    expect(pinFrame.style.getPropertyValue('--paper')).toBe('#f0d0c0');
    slider.value = '4';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Current preview is ready/), { timeout: 1000 });
    expect(pinFrame.style.getPropertyValue('--paper')).toBe('#f0d0c0');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe('/api/export.svg?identity=third');
    });
    (document.getElementById('download') as HTMLButtonElement).click();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  } finally {
    vi.unstubAllGlobals();
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.replaceChildren();
  }
});

it('keeps finishing separate from sketch controls and blocks SVG and PNG exports while a finishing render is pending', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  const source = { ...metadata, page: { width: 100, height: 150, paper: 'ivory', margin: 8 }, pens: [
    { id: 'black', color: 'black', width: 0.3 },
    { id: 'blue', color: 'rebeccapurple', width: 0.4 },
    { id: 'red', color: '#c43', width: 0.2 },
  ] };
  const requests: Array<{ requestId: number; finishing?: Record<string, unknown> }> = [];
  let finishRender: ((response: Response) => void) | undefined;
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('EventSource', class { addEventListener() {} });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/metadata') return Promise.resolve(response(source));
    if (url === '/api/finishing-options') return Promise.resolve(response({
      paperSizes: { a4: { label: 'A4', w: 297, h: 210 } },
      borderStyles: { simple: 'Simple', double: 'Double' }, pngScales: [1, 2, 3, 4, 6, 8],
    }));
    if (url === '/api/pins') return Promise.resolve(response([]));
    if (url === '/api/render') {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      const rendered = { ...result(request.finishing ? 'finished' : 'original'), metadata: { ...source,
        page: request.finishing?.page || source.page,
        pens: source.pens.map(pen => ({ ...pen, ...(request.finishing?.pens?.[pen.id] || {}) })),
      } };
      return request.finishing ? new Promise<Response>(resolve => { finishRender = resolve; }) :
        Promise.resolve(response({ requestId: request.requestId, result: rendered }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  try {
    await import('../../cli/sketch/viewer.js');
    await vi.waitFor(() => expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(false));
    await vi.waitFor(() => expect((document.getElementById('finish-page') as HTMLSelectElement).options.length).toBe(3));
    expect(requests[0].finishing).toBeUndefined();
    expect((document.getElementById('finish-paper') as HTMLInputElement).value).toBe('ivory');
    expect((document.querySelector('[aria-label="blue Color"]') as HTMLInputElement).value).toBe('rebeccapurple');
    const page = document.getElementById('finish-page') as HTMLSelectElement;
    page.value = 'a4';
    page.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(requests.length).toBe(2), { timeout: 1000 });
    expect((document.getElementById('finish-orientation') as HTMLSelectElement).value).toBe('portrait');
    expect(requests.at(-1)?.finishing?.page).toEqual({ width: 210, height: 297, margin: 8, paper: 'ivory' });
    const orientation = document.getElementById('finish-orientation') as HTMLSelectElement;
    orientation.value = 'landscape';
    orientation.dispatchEvent(new Event('change'));
    const bluePasses = document.querySelector('[aria-label="blue Passes"]') as HTMLInputElement;
    bluePasses.value = '2';
    bluePasses.dispatchEvent(new Event('change'));
    expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('download-png') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(requests.length).toBe(3), { timeout: 1000 });
    expect(finishRender).toBeTypeOf('function');
    const latest = requests.at(-1);
    expect(latest?.finishing).toEqual({ page: { width: 297, height: 210, margin: 8, paper: 'ivory' }, pens: { blue: { passes: 2 } } });
    finishRender!(response({ requestId: latest?.requestId, result: { ...result('finished'), metadata: {
      ...source, page: { width: 297, height: 210, margin: 8, paper: 'ivory' },
      pens: [source.pens[0], { ...source.pens[1], passes: 2 }, source.pens[2]],
    } } }));
    await vi.waitFor(() => expect((document.getElementById('download-png') as HTMLButtonElement).disabled).toBe(false));
    expect(document.getElementById('pen-count')?.textContent).toBe('3 layers · 4 passes');
    expect(document.querySelectorAll('.pen-details')[1].textContent).toContain('2 passes');
    expect((document.getElementById('finish-page') as HTMLSelectElement).value).toBe('a4');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe('/api/export.png?identity=finished&theme=dark&scale=8');
    });
    (document.getElementById('png-theme') as HTMLSelectElement).value = 'dark';
    (document.getElementById('png-scale') as HTMLSelectElement).value = '8';
    (document.getElementById('download-png') as HTMLButtonElement).click();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
    const border = document.getElementById('finish-border') as HTMLSelectElement;
    border.value = 'double';
    border.dispatchEvent(new Event('change'));
    const borderPen = document.getElementById('finish-border-pen') as HTMLSelectElement;
    borderPen.value = 'red';
    borderPen.dispatchEvent(new Event('change'));
    const borderInset = document.getElementById('finish-border-inset') as HTMLInputElement;
    const contentGap = document.getElementById('finish-content-gap') as HTMLInputElement;
    expect(document.getElementById('finish-border-spacing')?.hidden).toBe(false);
    expect((document.getElementById('finish-margin') as HTMLInputElement).disabled).toBe(true);
    borderInset.value = '16';
    borderInset.dispatchEvent(new Event('input'));
    contentGap.value = '9';
    contentGap.dispatchEvent(new Event('input'));
    const density = document.getElementById('finish-density-enabled') as HTMLInputElement;
    density.checked = true;
    density.dispatchEvent(new Event('change'));
    const densityMax = document.getElementById('finish-density-max') as HTMLInputElement;
    densityMax.value = '15';
    densityMax.dispatchEvent(new Event('input'));
    const densityCell = document.getElementById('finish-density-cell') as HTMLInputElement;
    densityCell.value = '12';
    densityCell.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(requests.length).toBe(4), { timeout: 1000 });
    expect(requests.at(-1)?.finishing).toEqual({ ...latest?.finishing,
      border: { style: 'double', pen: 'red', inset: 16, contentGap: 9 }, density: { maxDensity: 15, cellSize: 12 },
    });
    (document.getElementById('reset') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(requests.length).toBe(5), { timeout: 1000 });
    expect(requests.at(-1)?.finishing).toEqual(requests[3].finishing);
    (document.getElementById('finish-reset') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(requests.length).toBe(6), { timeout: 1000 });
    expect(requests.at(-1)?.finishing).toBeUndefined();
    const currentBluePasses = document.querySelector('[aria-label="blue Passes"]') as HTMLInputElement;
    currentBluePasses.value = '';
    currentBluePasses.dispatchEvent(new Event('input'));
    expect((document.getElementById('download-png') as HTMLButtonElement).disabled).toBe(true);
    const slider = document.getElementById('control-pitch') as HTMLInputElement;
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Render failed/), { timeout: 1000 });
    expect(requests.length).toBe(6);
    expect((document.getElementById('download-png') as HTMLButtonElement).disabled).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.replaceChildren();
  }
});

it('groups controls, changes conditional visibility without replacing a focused slider, and preserves group state on reload', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  const controls: SketchMetadata['controls'] = [
    { type: 'select', id: 'mode', label: 'Mode', default: 'flat', options: ['flat', 'deep'], optionLabels: { flat: 'Flat study', deep: 'Deep study' }, group: 'Composition' },
    { type: 'slider', id: 'pitch', label: 'Pitch', default: 2, min: 1, max: 5, step: 1, group: 'Composition' },
    { type: 'slider', id: 'detail', label: 'Detail', default: 1, min: 1, max: 5, step: 1, group: 'Details', showWhen: { control: 'pitch', equals: 3 } },
    { type: 'toggle', id: 'accent', label: 'Accent', default: false, group: 'Details', showWhen: { control: 'mode', equals: 'deep' } },
  ];
  let source: SketchMetadata = { ...metadata, controls };
  let sourceChanged: (() => void) | undefined;
  const requests: Array<{ requestId: number; params: Record<string, string | number | boolean> }> = [];
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('EventSource', class {
    addEventListener(name: string, callback: () => void) { if (name === 'source-change') sourceChanged = callback; }
  });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/metadata') return Promise.resolve(response(source));
    if (url === '/api/finishing-options') return Promise.resolve(response({ paperSizes: {}, borderStyles: {}, pngScales: [6] }));
    if (url === '/api/pins') return Promise.resolve(response([]));
    if (url === '/api/render') {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      return Promise.resolve(response({ requestId: request.requestId, result: { ...result(`render-${requests.length}`), metadata: source, params: request.params } }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  try {
    await import('../../cli/sketch/viewer.js');
    await vi.waitFor(() => expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(false));
    const composition = document.querySelector<HTMLDetailsElement>('.control-group[data-group="Composition"]')!;
    const details = document.querySelector<HTMLDetailsElement>('.control-group[data-group="Details"]')!;
    expect(composition.open).toBe(true);
    expect(details.hidden).toBe(true);
    expect((document.getElementById('control-mode') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Flat study');
    const mode = document.getElementById('control-mode') as HTMLSelectElement;
    mode.value = 'deep';
    mode.dispatchEvent(new Event('change'));
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(false);
    details.open = true;
    const pitch = document.getElementById('control-pitch') as HTMLInputElement;
    pitch.focus();
    pitch.value = '3';
    pitch.dispatchEvent(new Event('input'));
    expect(document.getElementById('control-pitch')).toBe(pitch);
    expect(document.activeElement).toBe(pitch);
    expect(document.getElementById('control-row-detail')?.hidden).toBe(false);
    await vi.waitFor(() => expect(requests.at(-1)?.params).toMatchObject({ mode: 'deep', pitch: 3, detail: 1, accent: false }));
    const detail = document.getElementById('control-detail') as HTMLInputElement;
    detail.value = '4';
    detail.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(requests.at(-1)?.params.detail).toBe(4));
    const prior = requests.length;
    details.querySelector<HTMLButtonElement>('.control-group-reset')!.click();
    expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(true);
    expect(details.open).toBe(true);
    await vi.waitFor(() => expect(requests.length).toBe(prior + 1));
    expect(requests.at(-1)?.params).toMatchObject({ mode: 'deep', pitch: 3, detail: 1, accent: false });
    composition.open = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    source = { ...source, controls: controls.map(control => control.id === 'pitch' && control.type === 'slider' ? { ...control, max: 6 } : control) };
    sourceChanged!();
    await vi.waitFor(() => expect((document.getElementById('control-pitch') as HTMLInputElement).max).toBe('6'));
    expect(document.querySelector<HTMLDetailsElement>('.control-group[data-group="Composition"]')?.open).toBe(false);
    expect(document.querySelector<HTMLDetailsElement>('.control-group[data-group="Details"]')?.open).toBe(true);
    expect((document.getElementById('control-mode') as HTMLSelectElement).value).toBe('deep');
    expect((document.getElementById('control-pitch') as HTMLInputElement).value).toBe('3');
  } finally {
    vi.unstubAllGlobals();
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.replaceChildren();
  }
});

it('selects a prepared derivative only for matching current operations and ignores late preparation', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  let settlePreparation: ((value: Response) => void) | undefined;
  let preparations = 0;
  let renders = 0;
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const prepared = { key: 'a'.repeat(64), sourceIdentity: 'render-1', sourceSha256: 'b'.repeat(64), preparedSha256: 'c'.repeat(64),
    report: { page: { width_mm: 100, height_mm: 150 }, pens: [{ pen_id: 'ink' }], geometry: { output: { paths: 1, pen_up_mm: 5 } }, travel: { after_mm: 5 } },
    sourceReport: { geometry: { normalized: { paths: 2, pen_up_mm: 10 } }, travel: { before_mm: 10 } } };
  vi.stubGlobal('EventSource', class { addEventListener() {} });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/metadata') return Promise.resolve(response(metadata));
    if (url === '/api/finishing-options') return Promise.resolve(response({ paperSizes: {}, borderStyles: {}, pngScales: [6], preparationEnabled: true }));
    if (url === '/api/pins') return Promise.resolve(response([]));
    if (url === '/api/render') {
      renders++;
      return Promise.resolve(response({ requestId: JSON.parse(String(options?.body)).requestId, result: result(`render-${renders}`) }));
    }
    if (url === '/api/preparation') {
      preparations++;
      if (preparations === 1) return Promise.resolve(response({ preparation: prepared }));
      return new Promise<Response>(resolve => { settlePreparation = resolve; });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.getAttribute('href')).toContain('artifact=prepared&preparedKey=' + prepared.key);
  });
  try {
    await import('../../cli/sketch/viewer.js');
    await vi.waitFor(() => expect((document.getElementById('preparation-run') as HTMLButtonElement).disabled).toBe(false));
    expect((document.getElementById('preparation') as HTMLElement).hidden).toBe(false);
    (document.getElementById('preparation-run') as HTMLButtonElement).click();
    await vi.waitFor(() => expect((document.getElementById('preparation-panel') as HTMLElement).hidden).toBe(false));
    expect(document.getElementById('preparation-detail')?.textContent).toMatch(/2 → 1 paths/);
    (document.getElementById('artifact-prepared') as HTMLInputElement).click();
    expect((document.getElementById('download') as HTMLButtonElement).dataset.preparedKey).toBe(prepared.key);
    (document.getElementById('download') as HTMLButtonElement).click();
    const merge = document.getElementById('preparation-merge') as HTMLInputElement;
    merge.value = '0.1';
    merge.dispatchEvent(new Event('input'));
    expect((document.getElementById('preparation-panel') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('artifact-prepared') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('download') as HTMLButtonElement).dataset.artifact).toBe('source');
    (document.getElementById('preparation-run') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(settlePreparation).toBeTypeOf('function'));
    (document.getElementById('reseed') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(renders).toBe(2));
    settlePreparation!(response({ preparation: prepared }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((document.getElementById('preparation-panel') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('download') as HTMLButtonElement).dataset.artifact).toBe('source');
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.replaceChildren();
  }
});
