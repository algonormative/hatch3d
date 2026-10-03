import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapSliderValue } from '../sketch/control-values.js';
import { createRadarNavigator } from '../../cli/sketch/radar-view.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
  return event;
}

it('snaps radar pointer and keyboard edits to legal steps, with distinct keyboard access at the center', () => {
  document.body.replaceChildren();
  const controls = [
    { type: 'slider', id: 'a', label: 'A', min: 0, max: 1, step: 0.3, default: 0, expensive: true },
    { type: 'slider', id: 'b', label: 'B', min: 0, max: 10, step: 1, default: 0 },
    { type: 'slider', id: 'c', label: 'C', min: 0, max: 10, step: 1, default: 0 },
  ];
  const raw: Record<string, number> = { a: 0, b: 0, c: 0 };
  const changes: string[] = [];
  const releases = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const view = createRadarNavigator(host, { id: 'shape', label: 'Shape', axes: ['a', 'b', 'c'] }, controls,
    id => raw[id], (id, value) => { raw[id] = value; changes.push(`${id}:${value}`); view.update(); }, releases);
  const svg = host.querySelector('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  Object.assign(svg, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn().mockReturnValue(false) });
  expect(snapSliderValue(controls[0], 1)).toBe(0.9);
  const track = svg.querySelector('[data-axis-id="a"]')!;
  track.dispatchEvent(pointer('pointerdown', 150, 55));
  expect(raw.a).toBe(0.9);
  expect(releases).not.toHaveBeenCalled();
  svg.dispatchEvent(pointer('pointerup', 150, 55));
  expect(releases).toHaveBeenCalledTimes(1);
  expect(changes).toEqual(['a:0.9']);
  const handle = svg.querySelector<SVGGElement>('.radar-handle[data-axis-id="a"]')!;
  handle.focus();
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(raw.a).toBe(0);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(raw.a).toBe(0.9);
  expect(releases).toHaveBeenCalledTimes(3);
  const label = [...host.querySelectorAll<HTMLButtonElement>('.radar-axis-label')].find(button => button.textContent === 'B')!;
  label.click();
  expect(document.activeElement?.getAttribute('data-axis-id')).toBe('b');
  (document.activeElement as Element).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(raw.b).toBe(1);
  view.setAvailable(false);
  expect(svg.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('.radar-unavailable')?.hasAttribute('hidden')).toBe(false);
});

it('keeps radar, precise sliders, macro readouts, gates, and source reload in sync without losing focus', async () => {
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync(join(process.cwd(), 'cli/sketch/viewer.html'), 'utf8');
  const slider = (id: string, label: string, overrides = {}) => ({ type: 'slider', id, label, min: 0, max: 10, step: 1, default: 0, ...overrides });
  const controls = [
    slider('a', 'A', { max: 1, step: 0.3, expensive: true }), slider('b', 'B'),
    slider('c', 'C', { showWhen: { control: 'gate', equals: true } }), slider('detail', 'Detail', { default: 3 }),
    { type: 'toggle', id: 'gate', label: 'Gate', default: true },
  ];
  const meta = {
    name: 'Radar study', page: { width: 100, height: 150, paper: '#fff' }, pens: [{ id: 'ink', color: '#111', width: 0.3 }], assets: {},
    controls, navigators: [{ id: 'shape', label: 'Shape', axes: ['a', 'b', 'c'] }],
    macros: [{ control: 'a', targets: [{ control: 'detail', amount: 10 }] }],
  };
  let currentMeta = meta;
  const requests: Array<Record<string, unknown>> = [];
  const listeners: Record<string, () => void> = {};
  let holdNextRender = false;
  let releaseHeld: (() => void) | undefined;
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('EventSource', class { addEventListener(name: string, listener: () => void) { listeners[name] = listener; } });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/metadata') return Promise.resolve(response(currentMeta));
    if (url === '/api/finishing-options') return Promise.resolve(response({ paperSizes: {}, borderStyles: {}, pngScales: [1, 2] }));
    if (url === '/api/pins') return Promise.resolve(response([]));
    if (url === '/api/render') {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      if (body.params.source === 1) return Promise.resolve(new Response(JSON.stringify({ error: 'Macro target overflowed: target' }), {
        status: 422, headers: { 'content-type': 'application/json' },
      }));
      const payload = { requestId: body.requestId, result: {
        schemaVersion: 1, metadata: currentMeta, params: body.params, seed: 0, identity: `render-${requests.length}`,
        parts: [], svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', diagnostics: [],
        stats: { pathCount: 0, pointCount: 0, lengthMm: 0, partCount: 0 }, durationMs: 1,
      } };
      if (holdNextRender) {
        holdNextRender = false;
        return new Promise<Response>(resolve => { releaseHeld = () => resolve(response(payload)); });
      }
      return Promise.resolve(response(payload));
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }));
  await import('../../cli/sketch/viewer.js');
  await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Current preview/));
  const svg = document.querySelector<SVGSVGElement>('.radar-chart')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  Object.assign(svg, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn().mockReturnValue(false) });
  const initialCount = requests.length;
  svg.querySelector('[data-axis-id="a"]')!.dispatchEvent(pointer('pointerdown', 150, 55));
  expect((document.getElementById('control-a') as HTMLInputElement).value).toBe('0.9');
  expect(document.querySelector('#control-row-detail .macro-value')?.textContent).toContain('Base 3 · With sketch macros 10 · at max');
  expect(requests).toHaveLength(initialCount);
  expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(true);
  holdNextRender = true;
  svg.dispatchEvent(pointer('pointercancel', 150, 55));
  await vi.waitFor(() => expect(requests).toHaveLength(initialCount + 1));
  expect((requests.at(-1)?.params as Record<string, number>).detail).toBe(3);
  expect((requests.at(-1)?.params as Record<string, number>).a).toBe(0.9);
  const b = document.querySelector<SVGGElement>('.radar-handle[data-axis-id="b"]')!;
  b.focus();
  const inputB = document.getElementById('control-b') as HTMLInputElement;
  inputB.value = '4';
  inputB.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.activeElement).toBe(b);
  expect(b.getAttribute('aria-valuenow')).toBe('4');
  await vi.waitFor(() => expect(requests).toHaveLength(initialCount + 2));
  await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Current preview/));
  releaseHeld?.();
  await Promise.resolve();
  expect(inputB.value).toBe('4');
  expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(false);
  const gate = document.getElementById('control-gate') as HTMLInputElement;
  gate.click();
  expect(svg.hasAttribute('hidden')).toBe(true);
  expect(document.querySelector('.radar-unavailable')?.hasAttribute('hidden')).toBe(false);
  gate.click();
  expect(svg.hasAttribute('hidden')).toBe(false);
  b.focus();
  listeners['source-change']();
  await vi.waitFor(() => expect(document.querySelector('.radar-handle[data-axis-id="b"]')).not.toBe(b));
  const reloadedB = document.querySelector<SVGGElement>('.radar-handle[data-axis-id="b"]')!;
  expect(document.activeElement).toBe(reloadedB);
  currentMeta = { ...meta, controls: controls.filter(control => control.id !== 'c'), navigators: [] };
  listeners['source-change']();
  await vi.waitFor(() => expect(document.getElementById('navigators')?.hasAttribute('hidden')).toBe(true));
  expect(document.activeElement).toBe(document.getElementById('reset'));
  expect((document.getElementById('control-a') as HTMLInputElement).value).toBe('0.9');
  expect(document.getElementById('control-c')).toBeNull();

  currentMeta = { ...meta,
    controls: [slider('source', 'Source', { max: 1 }), slider('target', 'Target', { max: 1e308, step: 1e307, default: 1e308 })],
    navigators: [], macros: [{ control: 'source', targets: [{ control: 'target', amount: 1e308 }] }],
  };
  listeners['source-change']();
  await vi.waitFor(() => expect(document.getElementById('control-source')).not.toBeNull());
  await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Current preview/));
  const source = document.getElementById('control-source') as HTMLInputElement;
  source.value = '1';
  source.dispatchEvent(new Event('input', { bubbles: true }));
  expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(true);
  expect((document.getElementById('pin') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('#control-row-target .macro-value')?.textContent).toContain('With sketch macros unavailable');
  await vi.waitFor(() => expect(document.getElementById('error')?.textContent).toMatch(/Macro target overflowed/));
  document.getElementById('reset')!.click();
  await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/Current preview/));
  expect((document.getElementById('download') as HTMLButtonElement).disabled).toBe(false);
});
