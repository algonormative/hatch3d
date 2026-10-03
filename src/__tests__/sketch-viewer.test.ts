import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { RenderResult, SketchMetadata } from '../sketch/types';

const runner = vi.hoisted(() => ({ inspectSketch: vi.fn(), renderSketch: vi.fn() }));
vi.mock('../../cli/sketch/runner.js', () => runner);

import { startSketchServer, type SketchServer } from '../../cli/sketch/server';
import { isolatePartSvg, reconcileControls } from '../../cli/sketch/viewer-state.js';

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
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

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

  it('isolates parts only in the inspection image while retaining canonical SVG bytes', () => {
    const full = '<svg xmlns="http://www.w3.org/2000/svg"><g data-part-id="sky"><path d="M0 0"/></g><g data-part-id="street"><path d="M1 1"/></g></svg>';
    expect(isolatePartSvg(full, '')).toBe(full);
    const inspected = isolatePartSvg(full, 'street');
    expect(inspected).toContain('data-part-id="sky" display="none"');
    expect(inspected).toContain('data-part-id="street"');
    expect(inspected).not.toContain('data-part-id="street" display="none"');
    expect(full).not.toContain('display="none"');
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

it('keeps a failed new render stale when an earlier pin request completes', async () => {
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
