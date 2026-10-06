import { describe, expect, it } from 'vitest';
import { resolveMacroParams, snapSliderValue } from '../sketch/control-values.js';
import type { Control, Macro, Params } from '../sketch/types.ts';

const controls: Control[] = [
  { type: 'slider', id: 'a', label: 'A', min: 0, max: 10, step: 1, default: 5 },
  { type: 'slider', id: 'b', label: 'B', min: 0, max: 10, step: 1, default: 5 },
  { type: 'slider', id: 'target', label: 'Target', min: 0, max: 10, step: 3, default: 6 },
  { type: 'toggle', id: 'visible', label: 'Visible', default: true },
];

describe('native macro values', () => {
  it('preserves exact raw values at neutral settings and never mutates input', () => {
    const params: Params = { a: 5, b: 5, target: 6, visible: true };
    const result = resolveMacroParams(controls, params, [{ control: 'a', targets: [{ control: 'target', amount: 8 }] }]);
    expect(result).toEqual(params);
    expect(result).not.toBe(params);
    expect(params.target).toBe(6);
  });

  it('sums signed overlapping contributions in stable source order before one snap', () => {
    const params = { a: 10, b: 10, target: 6, visible: true };
    const positive: Macro = { control: 'a', targets: [{ control: 'target', amount: 8 }] };
    const negative: Macro = { control: 'b', targets: [{ control: 'target', amount: -8 }] };
    expect(resolveMacroParams(controls, params, [negative, positive])).toEqual(params);
    expect(resolveMacroParams(controls, params, [positive, negative])).toEqual(params);
    expect(resolveMacroParams(controls, { ...params, b: 5 }, [negative, positive]).target).toBe(9);
  });

  it('clamps and snaps to a legal lattice point below an unaligned maximum', () => {
    const macro: Macro[] = [{ control: 'a', targets: [{ control: 'target', amount: 40 }] }];
    expect(resolveMacroParams(controls, { a: 10, b: 5, target: 6, visible: true }, macro).target).toBe(9);
    expect(resolveMacroParams(controls, { a: 0, b: 5, target: 6, visible: true }, macro).target).toBe(0);
    expect(snapSliderValue({ type: 'slider', id: 'fraction', label: 'Fraction', min: 0, max: 0.3, step: 0.1, default: 0.2 }, 0.29)).toBe(0.3);
    expect(snapSliderValue({ type: 'slider', id: 'fraction', label: 'Fraction', min: 0, max: 0.35, step: 0.1, default: 0.2 }, 0.35)).toBe(0.3);
    expect(snapSliderValue({ type: 'slider', id: 'negative', label: 'Negative', min: -1, max: -0.3, step: 0.07, default: -0.3 }, -0.3)).toBe(-0.3);
  });

  it('rejects finite arithmetic that overflows during resolution', () => {
    const huge: Control[] = [
      { type: 'slider', id: 'source', label: 'Source', min: 0, max: 1, step: 1, default: 0 },
      { type: 'slider', id: 'target', label: 'Target', min: 0, max: 1e308, step: 1e307, default: 1e308 },
    ];
    expect(() => resolveMacroParams(huge, { source: 1, target: 1e308 }, [{ control: 'source', targets: [{ control: 'target', amount: 1e308 }] }])).toThrow(/overflowed/);
  });
});
