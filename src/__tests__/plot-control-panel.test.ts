import { afterEach, expect, it, vi } from 'vitest';
import { mountControlPanel } from '../../packages/plot-core/src/controls.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const slider = (id: string, min = 0, max = 10, step = 1, extra = {}) =>
  ({ type: 'slider', id, label: id.toUpperCase(), default: min, min, max, step, ...extra });

function hosts() {
  const controlsHost = document.createElement('div');
  const navigatorsHost = document.createElement('div');
  document.body.append(navigatorsHost, controlsHost);
  return { controlsHost, navigatorsHost };
}

function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
  return event;
}

it('mounts isolated controls, handles silent updates, gates, group reset, and teardown', () => {
  const schema = [
    slider('x', -2, 2, 0.5, { group: 'Position', expensive: true }),
    slider('y', 10, 30, 5, { group: 'Position', showWhen: { control: 'on', equals: true } }),
    { type: 'toggle', id: 'on', label: 'On', default: true },
    { type: 'select', id: 'mode', label: 'Mode', default: 'a', options: ['a', 'b'] },
    { type: 'text', id: 'name', label: 'Name', default: 'A', maxLength: 10 },
  ];
  const params = { x: 0, y: 20, on: true, mode: 'a', name: 'A' };
  const a = hosts();
  const b = hosts();
  const changesA = vi.fn();
  const changesB = vi.fn();
  const commitsA = vi.fn();
  const panelA = mountControlPanel({ ...a, controls: schema, navigators: [{ type: 'xy', id: 'map', label: 'Map', axes: ['x', 'y'] }],
    params, onChange: changesA, onCommit: commitsA });
  const panelB = mountControlPanel({ ...b, controls: schema, params, onChange: changesB });
  const xA = a.controlsHost.querySelector<HTMLInputElement>('[type=range]')!;
  const xB = b.controlsHost.querySelector<HTMLInputElement>('[type=range]')!;
  expect(xA.id).not.toBe(xB.id);
  expect(a.controlsHost.querySelector('label[for]')?.getAttribute('for')).toBe(xA.id);

  panelA.update({ params: { ...params, x: 1 } });
  expect(xA.value).toBe('1');
  expect(xB.value).toBe('0');
  expect(changesA).not.toHaveBeenCalled();

  xA.value = '1.5';
  xA.dispatchEvent(new Event('input', { bubbles: true }));
  expect(changesA).toHaveBeenCalledWith({ x: 1.5 }, { expensive: true });
  expect(changesB).not.toHaveBeenCalled();
  xA.dispatchEvent(new Event('change', { bubbles: true }));
  expect(commitsA).toHaveBeenCalledTimes(1);

  const toggle = a.controlsHost.querySelector<HTMLInputElement>('[type=checkbox]')!;
  toggle.click();
  expect(a.controlsHost.querySelector('[data-control-id=y]')?.hasAttribute('hidden')).toBe(true);
  expect(a.navigatorsHost.querySelector('.spatial-card')?.hasAttribute('hidden')).toBe(true);
  expect(b.controlsHost.querySelector('[data-control-id=y]')?.hasAttribute('hidden')).toBe(false);

  panelA.reset('Position');
  expect(changesA).toHaveBeenLastCalledWith({ x: -2, y: 10 }, { expensive: false });
  expect(a.controlsHost.querySelector<HTMLInputElement>('[type=range]')?.value).toBe('-2');
  panelA.dispose();
  xA.value = '2';
  xA.dispatchEvent(new Event('input', { bubbles: true }));
  xA.dispatchEvent(new Event('change', { bubbles: true }));
  expect(changesA).toHaveBeenCalledTimes(3);
  expect(commitsA).toHaveBeenCalledTimes(1);
  expect(a.controlsHost.childElementCount).toBe(0);
  expect(a.navigatorsHost.childElementCount).toBe(0);
  panelB.dispose();
});

it('uses the existing XY axes and commits a changed expensive drag once on release', () => {
  const h = hosts();
  const changes = vi.fn();
  const commits = vi.fn();
  const panel = mountControlPanel({ ...h, controls: [slider('x', -2, 2, 0.5, { expensive: true }),
    slider('y', 10, 30, 5)], navigators: [{ type: 'xy', id: 'map', label: 'Map', axes: ['x', 'y'], yDirection: 'down' }],
  params: { x: 0, y: 20 }, onChange: changes, onCommit: commits });
  const svg = h.navigatorsHost.querySelector<SVGSVGElement>('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  Object.assign(svg, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn().mockReturnValue(false) });
  svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 260, 40));
  expect(changes).toHaveBeenCalledWith({ x: 2, y: 10 }, { expensive: true });
  expect(h.controlsHost.querySelectorAll<HTMLInputElement>('[type=range]')[0].value).toBe('2');
  expect(commits).not.toHaveBeenCalled();
  svg.dispatchEvent(pointer('pointerup', 260, 40));
  expect(commits).toHaveBeenCalledTimes(1);
  panel.dispose();
});

it('keeps controlled updates silent when they hide an active expensive navigator', () => {
  const h = hosts();
  const changes = vi.fn();
  const commits = vi.fn();
  const controls = [slider('x', 0, 10, 1, { expensive: true }),
    slider('y', 0, 10, 1, { showWhen: { control: 'on', equals: true } }),
    { type: 'toggle', id: 'on', label: 'On', default: true }];
  const panel = mountControlPanel({ ...h, controls, navigators: [{ type: 'xy', id: 'map', label: 'Map', axes: ['x', 'y'] }],
    params: { x: 5, y: 5, on: true }, onChange: changes, onCommit: commits });
  const svg = h.navigatorsHost.querySelector<SVGSVGElement>('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  Object.assign(svg, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn().mockReturnValue(false) });
  svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 172, 150));
  expect(changes).toHaveBeenCalledTimes(1);
  panel.update({ params: { x: 6, y: 5, on: false } });
  expect(commits).not.toHaveBeenCalled();
  expect(changes).toHaveBeenCalledTimes(1);
  expect(svg.hasAttribute('hidden')).toBe(true);
  svg.dispatchEvent(pointer('pointerup', 172, 150));
  expect(commits).not.toHaveBeenCalled();
  panel.dispose();
});

it('always emits a full defaults patch for global and group reset, even at defaults', () => {
  const h = hosts();
  const changes = vi.fn();
  const commits = vi.fn();
  const panel = mountControlPanel({ ...h, controls: [slider('x', 0, 10, 1, { group: 'Shape', expensive: true }),
    slider('y', 0, 10, 1, { group: 'Shape' }), slider('z', 0, 10, 1, { group: 'Other' })],
  params: { x: 0, y: 0, z: 0 }, onChange: changes, onCommit: commits });

  panel.reset('Shape');
  expect(changes).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 }, { expensive: false });
  panel.reset();
  expect(changes).toHaveBeenCalledTimes(2);
  expect(changes).toHaveBeenLastCalledWith({ x: 0, y: 0, z: 0 }, { expensive: false });
  expect(commits).not.toHaveBeenCalled();
  panel.dispose();
});

it('emits one empty patch when resetting a panel without controls', () => {
  const h = hosts();
  const changes = vi.fn();
  const commits = vi.fn();
  const panel = mountControlPanel({ ...h, controls: [], params: {}, onChange: changes, onCommit: commits });
  panel.reset();
  expect(changes).toHaveBeenCalledExactlyOnceWith({}, { expensive: false });
  expect(commits).not.toHaveBeenCalled();
  panel.dispose();
});

it('cancels an expensive gesture before reset and does not commit on release', () => {
  const h = hosts();
  const changes = vi.fn();
  const commits = vi.fn();
  const panel = mountControlPanel({ ...h, controls: [slider('x', 0, 10, 1, { expensive: true }),
    slider('y', 0, 10)], navigators: [{ type: 'xy', id: 'map', label: 'Map', axes: ['x', 'y'] }],
  params: { x: 0, y: 0 }, onChange: changes, onCommit: commits });
  const svg = h.navigatorsHost.querySelector<SVGSVGElement>('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  Object.assign(svg, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn().mockReturnValue(false) });
  svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 260, 40));
  panel.reset();
  expect(changes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, { expensive: false });
  expect(h.controlsHost.querySelector<HTMLInputElement>('[type=range]')?.value).toBe('0');
  svg.dispatchEvent(pointer('pointerup', 260, 40));
  expect(commits).not.toHaveBeenCalled();
  panel.dispose();
});
