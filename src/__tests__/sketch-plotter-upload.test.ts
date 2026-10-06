import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { RenderResult } from '../sketch/types.ts';
import { plotterQueueConfig, plotterQueueId, queueSketchRender, validatePlotterUploadConfig } from '../../cli/sketch/plugins/plotter-upload.ts';

const runner = vi.hoisted(() => ({ inspectSketch: vi.fn(), renderSketch: vi.fn() }));
vi.mock('../../cli/sketch/runner.js', () => ({ ...runner }));
vi.mock('../../cli/sketch/source-stamp.js', () => ({ sourceStamp: vi.fn().mockResolvedValue('test-source-stamp') }));
import { startSketchServer, type SketchServer } from '../../cli/sketch/server.ts';

const result: RenderResult = {
  schemaVersion: 1,
  metadata: { name: 'Two pens', page: { width: 10, height: 8, paper: '#f0ede5' }, pens: [
    { id: 'black', color: '#222222', width: 0.3, passes: 2 },
    { id: 'red', color: '#ff0000', width: 0.4, passes: 3 },
  ], controls: [], assets: {} },
  params: { pitch: 2 }, seed: 17,
  finishing: { pens: { red: { passes: 3 } } },
  parts: [
    { id: 'grid', pen: 'black', paths: [[{ x: 1, y: 1 }, { x: 8, y: 1 }]] },
    { id: 'accent', pen: 'red', paths: [[{ x: 1, y: 2 }, { x: 8, y: 2 }]] },
  ],
  // Whitespace and layer attributes must survive the upload without reserialization.
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="8mm">\n<g data-pen-id="black" data-passes="2" />\n<g data-pen-id="red" data-passes="3" /></svg>',
  identity: 'render-one', diagnostics: [],
  stats: { pathCount: 2, pointCount: 4, lengthMm: 14, partCount: 2 }, durationMs: 1,
};

const ack = (url: string | URL | Request, options?: RequestInit) => new Response(JSON.stringify({ ok: true, id: String(url).endsWith('/print-queue') ? JSON.parse(options!.body as string).id : 'image' }), { status: 201, headers: { 'content-type': 'application/json' } });

describe('plotter upload service', () => {
  it('keeps exact SVG bytes, PNG export pixels, layers and pass counts; retries under one stable ID', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    let count = 0;
    const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), options: options! });
      count++;
      return count === 3 ? new Response('UPSTREAM_PRIVATE_TOKEN', { status: 503 }) : ack(url, options);
    }) as unknown as typeof fetch;
    const config = { baseUrl: 'https://queue.example/', token: 'SERVER_PRIVATE_TOKEN', fetchImpl: fakeFetch };
    await expect(queueSketchRender(result, config)).rejects.toThrow('Print queue request failed (503)');
    const id = await queueSketchRender(result, config);
    expect(id).toBe(plotterQueueId(result));
    expect(calls).toHaveLength(6);
    expect(calls[0].url).toBe(`https://queue.example/image/plotter/${id}.svg`);
    expect(calls[1].url).toBe(`https://queue.example/image/plotter/${id}.png`);
    expect(calls[2].url).toBe('https://queue.example/print-queue');
    expect(new TextDecoder().decode(calls[0].options.body as Uint8Array)).toBe(result.svg);
    expect(new TextDecoder().decode(calls[3].options.body as Uint8Array)).toBe(result.svg);
    expect(PNG.sync.read(Buffer.from(calls[1].options.body as Uint8Array))).toMatchObject({ width: 60, height: 48 });
    const queued = JSON.parse(calls[5].options.body as string);
    expect(queued.id).toBe(id);
    expect(JSON.parse(calls[2].options.body as string)).toEqual(queued);
    expect(JSON.parse(queued.config)).toMatchObject({
      identity: 'render-one', page: result.metadata.page, pens: result.metadata.pens,
      layers: [{ id: 'black', passes: 2, parts: ['grid'] }, { id: 'red', passes: 3, parts: ['accent'] }],
      params: result.params, seed: 17, finishing: result.finishing,
    });
    expect(calls.every(call => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal)).toBe(true);
    expect(plotterQueueId({ ...result, svg: result.svg + ' ' })).not.toBe(id);
    expect(plotterQueueConfig(result, queued.svg_key, queued.png_key)).toEqual(JSON.parse(queued.config));
  });

  it('rejects HTML and wrong-ID success responses as unacknowledged', async () => {
    for (const queueResponse of [new Response('<html>login</html>', { status: 200 }), new Response(JSON.stringify({ ok: true, id: 'other' }), { status: 200 })]) {
      const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) =>
        String(url).endsWith('/print-queue') ? queueResponse : ack(url, options)) as unknown as typeof fetch;
      await expect(queueSketchRender(result, { baseUrl: 'https://queue.example', token: 'secret', fetchImpl: fakeFetch }))
        .rejects.toThrow('Print queue did not acknowledge upload');
    }
  });

  it('rejects credential URLs and never includes upstream responses in errors', async () => {
    expect(() => validatePlotterUploadConfig({ baseUrl: 'https://user:secret@queue.example/', token: 'x' })).toThrow(/without credentials/);
    expect(() => validatePlotterUploadConfig({ baseUrl: 'https://queue.example/api/', token: 'x' })).toThrow(/without credentials/);
    const fakeFetch = vi.fn(async () => { throw new Error('SERVER_PRIVATE_TOKEN'); }) as unknown as typeof fetch;
    await expect(queueSketchRender(result, { baseUrl: 'https://queue.example', token: 'SERVER_PRIVATE_TOKEN', fetchImpl: fakeFetch }))
      .rejects.toThrow('Print queue request failed or timed out');
  });
});

describe('local sketch server upload gate', () => {
  let temporary: string;
  let entry: string;
  let server: SketchServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  async function setup(enabled: boolean, fakeFetch?: typeof fetch) {
    temporary = await mkdtemp(join(tmpdir(), 'sketch-plotter-upload-'));
    entry = join(temporary, 'source/sketch.ts');
    await mkdir(join(temporary, 'source'));
    await writeFile(entry, 'export default {}');
    runner.inspectSketch.mockReset().mockResolvedValue(result.metadata);
    runner.renderSketch.mockReset().mockResolvedValue(result);
    server = await startSketchServer({ entry, outputDir: join(temporary, 'pins'), ...(enabled ? {
      plotterUpload: { baseUrl: 'https://queue.example', token: 'SERVER_PRIVATE_TOKEN', fetchImpl: fakeFetch },
    } : {}) });
    await new Promise(resolve => setTimeout(resolve, 180));
    return server.url;
  }
  const render = (url: string) => fetch(new URL('/api/render', url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 1 }),
  });
  const upload = (url: string, identity: string, extraHeaders: Record<string, string> = {}, extraBody: Record<string, unknown> = {}) => fetch(new URL('/api/plugins/plotter-upload', url), {
    method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/json', 'x-sketch-action': 'plotter-upload', ...extraHeaders },
    body: JSON.stringify({ identity, ...extraBody }),
  });

  it('requires both flag/config and an explicit local POST; page load makes no upstream calls', async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => ack(url, options)) as unknown as typeof fetch;
    const disabledUrl = await setup(false, fakeFetch);
    expect(await (await fetch(disabledUrl)).text()).not.toContain('/plotter-upload-view.js');
    expect((await fetch(new URL('/plotter-upload-view.js', disabledUrl))).status).toBe(404);
    expect((await upload(disabledUrl, 'render-one')).status).toBe(404);
    expect(fakeFetch).not.toHaveBeenCalled();
    await server!.close(); server = undefined;
    await rm(temporary, { recursive: true, force: true });
    const enabledUrl = await setup(true, fakeFetch);
    expect(await (await fetch(enabledUrl)).text()).toContain('/plotter-upload-view.js');
    expect((await fetch(new URL('/plotter-upload-view.js', enabledUrl))).status).toBe(200);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect((await upload(enabledUrl, 'render-one')).status).toBe(409);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('enforces same-origin action header, current identity, and failed-render invalidation', async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => ack(url, options)) as unknown as typeof fetch;
    const url = await setup(true, fakeFetch);
    expect((await render(url)).status).toBe(200);
    expect((await upload(url, 'render-one', { 'x-sketch-action': '' })).status).toBe(403);
    expect((await upload(url, 'render-one', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await upload(url, 'render-one', {}, { svg: '<svg/>' })).status).toBe(400);
    expect((await upload(url, 'other-tab-render')).status).toBe(409);
    expect(fakeFetch).not.toHaveBeenCalled();
    const success = await upload(url, 'render-one');
    expect(success.status).toBe(201);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    runner.renderSketch.mockRejectedValueOnce(new Error('bad geometry'));
    expect((await render(url)).status).toBe(422);
    expect((await upload(url, 'render-one')).status).toBe(409);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects one tab’s identity after another tab renders a different study', async () => {
    const fakeFetch = vi.fn(async (remote: string | URL | Request, options?: RequestInit) => ack(remote, options)) as unknown as typeof fetch;
    const url = await setup(true, fakeFetch);
    expect((await render(url)).status).toBe(200);
    runner.renderSketch.mockResolvedValueOnce({ ...result, identity: 'render-two', svg: result.svg + '\n' });
    expect((await render(url)).status).toBe(200);
    expect((await upload(url, 'render-one')).status).toBe(409);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect((await upload(url, 'render-two')).status).toBe(201);
  });

  it('returns sanitized API failure and supports retry without changing queue identity', async () => {
    let count = 0;
    const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => (++count === 3 ? new Response('SERVER_PRIVATE_TOKEN', { status: 503 }) : ack(url, options))) as unknown as typeof fetch;
    const url = await setup(true, fakeFetch);
    expect((await render(url)).status).toBe(200);
    const failed = await upload(url, 'render-one');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('SERVER_PRIVATE_TOKEN');
    const retry = await upload(url, 'render-one');
    expect(retry.status).toBe(201);
    expect((await retry.json()).id).toBe(plotterQueueId(result));
    expect(fakeFetch).toHaveBeenCalledTimes(6);
  });
});

describe('local viewer upload button', () => {
  it('reads this tab identity, follows stale export state, and makes no fetch on load', async () => {
    document.body.innerHTML = '<div class="header-actions"><button id="download" disabled>Export</button></div>';
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => ack(url, options)) as unknown as typeof fetch;
    globalThis.fetch = fakeFetch;
    try {
      const source = await readFile(join(process.cwd(), 'cli/sketch/plugins/plotter-upload-view.js'), 'utf8');
      new Function(source)();
      const button = document.querySelector<HTMLButtonElement>('.header-actions button:last-of-type')!;
      expect(button.disabled).toBe(true);
      expect(fakeFetch).not.toHaveBeenCalled();
      document.getElementById('download')!.dataset.identity = 'tab-one';
      (document.getElementById('download') as HTMLButtonElement).disabled = false;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(button.disabled).toBe(false);
      button.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fakeFetch.mock.calls[0]![1]!.body as string).identity).toBe('tab-one');
      (document.getElementById('download') as HTMLButtonElement).disabled = true;
      await new Promise(resolve => setTimeout(resolve, 0));
      button.click();
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      document.body.innerHTML = '';
    }
  });
});
