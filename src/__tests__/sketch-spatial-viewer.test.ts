import { afterEach, expect, it, vi } from 'vitest';
import { createXYNavigator, createXYZNavigator } from '../../cli/sketch/spatial-view.js';
import { cubeProjectedBasis } from '../controls/geometry.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const slider = (id: string, min: number, max: number, step: number, extra = {}) =>
  ({ type: 'slider', id, label: id.toUpperCase(), min, max, step, default: (min + max) / 2, ...extra });

function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId, button: 0, clientX: x, clientY: y });
  return event;
}

function mount(factory: typeof createXYNavigator | typeof createXYZNavigator, navigator: Record<string, unknown>,
  controls: ReturnType<typeof slider>[], initial: Record<string, number>) {
  const raw = { ...initial };
  const changes: Array<{ patch: Record<string, number>; expensive: boolean }> = [];
  const releases = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const view = factory(host, navigator, controls, id => raw[id], (patch, expensive) => {
    changes.push({ patch: { ...patch }, expensive });
    Object.assign(raw, patch);
    view.update();
  }, releases);
  const svg = host.querySelector<SVGSVGElement>('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(svg, { setPointerCapture, hasPointerCapture: vi.fn().mockReturnValue(true), releasePointerCapture });
  return { host, raw, changes, releases, view, svg, setPointerCapture, releasePointerCapture };
}

it('edits independent XY ranges atomically and honors Y direction and keyboard steps', () => {
  const controls = [slider('x', -2, 2, 0.5, { expensive: true }), slider('y', 10, 30, 5)];
  const up = mount(createXYNavigator, { id: 'page', label: 'Page', type: 'xy', axes: ['x', 'y'] },
    controls, { x: 0, y: 20 });
  up.svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 260, 40));
  expect(up.raw).toEqual({ x: 2, y: 30 });
  expect(up.changes).toEqual([{ patch: { x: 2, y: 30 }, expensive: true }]);
  up.svg.dispatchEvent(pointer('pointercancel', 260, 40));
  expect(up.releases).toHaveBeenCalledTimes(1);
  const yHandle = up.svg.querySelector<SVGGElement>('.spatial-handle[data-axis-id="y"]')!;
  yHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(up.raw.y).toBe(10);
  expect(up.raw.x).toBe(2);
  expect(yHandle.getAttribute('aria-valuenow')).toBe('10');
  up.view.dispose();

  const down = mount(createXYNavigator, { id: 'page2', label: 'Page down', type: 'xy', axes: ['x', 'y'],
    yDirection: 'down', axisLabels: ['Width', 'Height'] }, controls, { x: 0, y: 20 });
  down.svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 150, 40));
  expect(down.raw).toEqual({ x: 0, y: 10 });
  expect(down.host.querySelector('[data-axis-label="y"]')?.textContent).toBe('Height 10');
  down.svg.dispatchEvent(pointer('pointerup', 150, 40));
  down.view.dispose();
});

it('holds an expensive XY gesture even when only the cheap axis steps, and ignores secondary pointers', () => {
  const controls = [slider('x', 0, 10, 10, { expensive: true }), slider('y', 0, 10, 1)];
  const fixture = mount(createXYNavigator, { id: 'pad', label: 'Pad', type: 'xy', axes: ['x', 'y'] },
    controls, { x: 0, y: 5 });
  const hit = fixture.svg.querySelector('.xy-hit')!;
  hit.dispatchEvent(pointer('pointerdown', 40, 150));
  hit.dispatchEvent(pointer('pointerdown', 260, 40, 2));
  fixture.svg.dispatchEvent(pointer('pointermove', 260, 40, 2));
  expect(fixture.raw).toEqual({ x: 0, y: 5 });
  fixture.svg.dispatchEvent(pointer('pointermove', 40, 128));
  expect(fixture.raw).toEqual({ x: 0, y: 6 });
  expect(fixture.changes.at(-1)?.expensive).toBe(true);
  fixture.svg.dispatchEvent(pointer('pointerup', 40, 128));
  expect(fixture.releases).toHaveBeenCalledTimes(1);
  fixture.view.dispose();
});

it.each([
  ['xy', [0, 1], 2],
  ['xz', [0, 2], 1],
  ['yz', [1, 2], 0],
] as const)('inverts %s plane drags from frozen values and preserves the untouched axis', (plane, indices, untouched) => {
  const controls = [slider('x', 0, 10, 1), slider('y', 0, 10, 1, { expensive: true }), slider('z', 0, 10, 1)];
  const fixture = mount(createXYZNavigator, { id: 'position', label: 'Position', type: 'xyz',
    axes: ['x', 'y', 'z'] }, controls, { x: 5, y: 5, z: 5 });
  const basis = cubeProjectedBasis(0.68, 0.58);
  const keys = ['x', 'y', 'z'] as const;
  const scale = 300 * 0.28 * 0.4;
  const dx = scale * (basis[keys[indices[0]]][0] + basis[keys[indices[1]]][0]);
  const dy = scale * (basis[keys[indices[0]]][1] + basis[keys[indices[1]]][1]);
  const handle = fixture.svg.querySelector(`[data-plane="${plane.toUpperCase()}"]`)!;
  handle.dispatchEvent(pointer('pointerdown', 150, 150));
  fixture.svg.dispatchEvent(pointer('pointermove', 150 + dx, 150 + dy));
  expect(fixture.raw[keys[indices[0]]]).toBe(7);
  expect(fixture.raw[keys[indices[1]]]).toBe(7);
  expect(fixture.raw[keys[untouched]]).toBe(5);
  expect(fixture.changes).toEqual([{ patch: { [keys[indices[0]]]: 7, [keys[indices[1]]]: 7 },
    expensive: indices.includes(1) }]);
  fixture.svg.dispatchEvent(pointer('pointerup', 150 + dx, 150 + dy));
  expect(fixture.releases).toHaveBeenCalledTimes(indices.includes(1) ? 1 : 0);
  fixture.view.dispose();
});

it('constrains axis drag, releases on lost capture, and disposes without flush or stale events', () => {
  const controls = [slider('x', 0, 10, 1), slider('y', 0, 10, 1, { expensive: true }), slider('z', 0, 10, 1)];
  const fixture = mount(createXYZNavigator, { id: 'position', label: 'Position', type: 'xyz',
    axes: ['x', 'y', 'z'] }, controls, { x: 5, y: 5, z: 5 });
  const basis = cubeProjectedBasis(0.68, 0.58);
  const y = fixture.svg.querySelector<SVGGElement>('.spatial-handle[data-axis-id="y"]')!;
  y.dispatchEvent(pointer('pointerdown', 150, 150));
  fixture.svg.dispatchEvent(pointer('pointermove', 150 + 0.4 * 84 * basis.y[0], 150 + 0.4 * 84 * basis.y[1]));
  expect(fixture.raw).toEqual({ x: 5, y: 7, z: 5 });
  fixture.svg.dispatchEvent(pointer('lostpointercapture', 150, 150));
  expect(fixture.releases).toHaveBeenCalledTimes(1);
  y.dispatchEvent(pointer('pointerdown', 150, 150));
  fixture.svg.dispatchEvent(pointer('pointermove', 150 + 0.4 * 84 * basis.y[0], 150 + 0.4 * 84 * basis.y[1]));
  const beforeDispose = { ...fixture.raw };
  fixture.view.dispose();
  expect(fixture.releases).toHaveBeenCalledTimes(1);
  fixture.svg.dispatchEvent(pointer('pointermove', 0, 0));
  fixture.svg.dispatchEvent(pointer('pointerup', 0, 0));
  expect(fixture.raw).toEqual(beforeDispose);
});

it('flushes a changed expensive gesture when a conditional axis hides, then cancels reset without rendering', () => {
  const controls = [slider('x', 0, 10, 1, { expensive: true }), slider('y', 0, 10, 1)];
  const fixture = mount(createXYNavigator, { id: 'conditional', label: 'Conditional', type: 'xy',
    axes: ['x', 'y'] }, controls, { x: 5, y: 5 });
  fixture.svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 172, 150));
  expect(fixture.raw.x).toBe(6);
  fixture.view.setAvailable(false);
  expect(fixture.releases).toHaveBeenCalledTimes(1);
  expect(fixture.svg.hasAttribute('hidden')).toBe(true);
  expect(fixture.host.querySelector('.spatial-card')?.hasAttribute('hidden')).toBe(true);
  fixture.svg.dispatchEvent(pointer('pointermove', 260, 40));
  expect(fixture.raw).toEqual({ x: 6, y: 5 });
  fixture.view.setAvailable(true);
  fixture.svg.querySelector('.xy-hit')!.dispatchEvent(pointer('pointerdown', 216, 150));
  expect(fixture.raw.x).toBe(8);
  fixture.view.cancel();
  const releaseCount = fixture.releases.mock.calls.length;
  fixture.svg.dispatchEvent(pointer('pointerup', 216, 150));
  expect(fixture.releases).toHaveBeenCalledTimes(releaseCount);
  fixture.view.dispose();
});
