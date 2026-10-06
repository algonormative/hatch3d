import { describe, expect, it } from 'vitest';
import type { Composition2DDefinition } from '../compositions/types.ts';
import { legacyControlPack } from '../sketch/hatch3d-controls.ts';
import { createHatch3d2DLayer } from '../sketch/hatch3d.ts';
import type { Params, Sketch, SketchContext } from '../sketch/types.ts';
import twoD from '../../sketches/hatch3d-2d/sketch.ts';
import mixed from '../../sketches/hatch3d-3d/sketch.ts';

function context(sketch: Sketch, overrides: Params = {}, seed = 0): SketchContext {
  return {
    params: { ...Object.fromEntries(sketch.controls.map((control) => [control.id, control.default])), ...overrides },
    seed,
    assets: {},
    random: () => () => 0.5,
  };
}

describe('hatch3d Sketch adapters', () => {
  it('flattens XY, prefixes visibility gates, resolves macros, and rejects unbound images', () => {
    const composition: Composition2DDefinition = {
      id: 'synthetic', name: 'Synthetic', category: '2d', type: '2d',
      controls: {
        mode: { type: 'select', label: 'Mode', default: 'on', options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }], group: 'State' },
        gain: { type: 'slider', label: 'Gain', default: 2, min: 0, max: 10, group: 'State', showWhen: { control: 'mode', equals: 'on' } },
        position: { type: 'xy', label: 'Position', default: [0, 0], min: -1, max: 1, group: 'State', showWhen: { control: 'mode', equals: 'on' } },
      },
      macros: { boost: { label: 'Boost', default: 0.5, targets: [{ param: 'gain', fn: 'linear', strength: 1 }] } },
      generate: () => [],
    };
    const pack = legacyControlPack(composition, 's');
    expect(pack.navigators).toEqual([{ id: 's__control__position__xy', label: 'Position', type: 'xy', axes: ['s__control__position__x', 's__control__position__y'] }]);
    expect(pack.controls.find((control) => control.id === 's__control__position__x')?.showWhen).toEqual({ control: 's__control__mode', equals: 'on' });
    expect(pack.controls.find((control) => control.id === 's__control__mode')).toMatchObject({ options: ['on', 'off'], optionLabels: { on: 'On', off: 'Off' } });
    expect(pack.values({ s__control__mode: 'off', s__control__gain: 2, s__control__position__x: 0.3, s__control__position__y: -0.2, s__macro__boost: 1 }, {}, 0)).toMatchObject({ gain: 4, position: [0.3, -0.2] });
    expect(() => legacyControlPack({ ...composition, controls: { image: { type: 'image', label: 'Image', group: 'Source' } } }, 's')).toThrow(/explicit Sketch asset binding/);
  });

  it('maps seeded 2D geometry to millimeters and moves it by the 2D transform', async () => {
    const base = (await twoD.draw(context(twoD))) as { paths: { x: number; y: number }[][]; pen: string }[];
    const again = await twoD.draw(context(twoD));
    const seeded = await twoD.draw(context(twoD, {}, 1));
    const moved = (await twoD.draw(context(twoD, { circles__transform__panX: 10 }))) as typeof base;
    expect(again).toEqual(base);
    expect(seeded).not.toEqual(base);
    expect(twoD.navigators).toContainEqual({ id: 'circles__transform__panXY', label: 'Placement pan', type: 'xy', axes: ['circles__transform__panX', 'circles__transform__panY'], yDirection: 'down' });
    expect(base[0].pen).toBe('charcoal');
    expect(base[0].paths.length).toBeGreaterThan(20);
    const point = base[0].paths[0][0];
    expect(point.x).toBeGreaterThanOrEqual(12);
    expect(point.y).toBeGreaterThanOrEqual(12);
    expect(moved[0].paths[0][0].x - point.x).toBeCloseTo(10, 5);
  });

  it('keeps mixed 3D solids and paper-space ink in separate parts, with strict CPU depth and diagnostic mesh', async () => {
    const base = (await mixed.draw(context(mixed))) as { id: string; pen: string; paths: { x: number; y: number }[][]; diagnostic?: boolean }[];
    const again = await mixed.draw(context(mixed));
    const unoccluded = (await mixed.draw(context(mixed, { ringstudy__view__useOcclusion: false }))) as typeof base;
    const moved = (await mixed.draw(context(mixed, { ringstudy__control__ringSpacing: 2.3 }))) as typeof base;
    const mesh = (await mixed.draw(context(mixed, { ringstudy__view__showMesh: true }))) as typeof base;
    expect(again).toEqual(base);
    expect(mixed.navigators).toContainEqual({ id: 'ringstudy__view__panXY', label: 'Camera pan', type: 'xy', axes: ['ringstudy__view__panX', 'ringstudy__view__panY'], yDirection: 'up' });
    expect(mixed.navigators).toContainEqual({ id: 'ringstudy__control__ringOffset__xy', label: 'Ring Offset', type: 'xy', axes: ['ringstudy__control__ringOffset__x', 'ringstudy__control__ringOffset__y'], axisLabels: ['X', 'Z'] });
    expect(mixed.navigators).toContainEqual({ id: 'ringstudy__upperRingBase', label: 'Upper ring base position · mirrored pair', type: 'xyz', axes: ['ringstudy__control__ringOffset__x', 'ringstudy__control__ringSpacing', 'ringstudy__control__ringOffset__y'], axisLabels: ['World X', 'World Y', 'World Z'] });
    expect(base.map((part) => part.pen)).toEqual(['rings', 'curve']);
    expect(base[0].paths.length).toBeGreaterThan(0);
    expect(base[1].paths).toEqual(unoccluded[1].paths);
    expect(base[0].paths).not.toEqual(unoccluded[0].paths);
    expect(base[0].paths).not.toEqual(moved[0].paths);
    expect(mesh[2]).toMatchObject({ pen: 'rings', diagnostic: true });
    expect(mesh[2].paths.some((path) => path.length === 4 && path[0].x === path[3].x && path[0].y === path[3].y)).toBe(true);
    expect(() => mixed.draw(context(mixed, { ringstudy__view__depthRes: 10000 }))).toThrow();
  });

  it('exposes a composable 2D layer with its own pen and controls', () => {
    const layer = createHatch3d2DLayer({
      composition: { id: 'line', name: 'Line', category: '2d', type: '2d', generate: ({ width, height }) => [[{ x: 0, y: 0 }, { x: width, y: height }]] },
      page: { width: 210, height: 148, margin: 12 }, pen: { id: 'ink', color: '#000', width: 0.3 }, transform: false,
      canvas: { width: 100, height: 100 },
    });
    const part = layer.draw({ params: {}, seed: 0, assets: {}, random: () => () => 0.5 });
    expect(layer.navigators).toEqual([]);
    expect(layer.pen.id).toBe('ink');
    expect(part.paths[0]).toEqual([{ x: 43, y: 12 }, { x: 167, y: 136 }]);
  });
});
