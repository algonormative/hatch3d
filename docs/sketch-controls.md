# Sketch controls and composition navigation

An executable sketch declares its controls in ordinary TypeScript. The control IDs are also the keys in `--params`, saved render requests, and `ctx.params`. A slider's `default`, `min`, `max`, and `step` define its legal values; `group` is an optional UI heading. Keep a fine control even when a macro drives it so it remains directly editable.

```ts
import type { Sketch } from '../../src/sketch/types.ts';

const sketch: Sketch = {
  name: 'Ruled current',
  page: { width: 210, height: 148 },
  pens: [{ id: 'ink', color: '#222', width: 0.3 }],
  controls: [
    { type: 'slider', id: 'density', label: 'Density', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'pitch', label: 'Pitch', default: 3, min: 1, max: 5, step: 0.1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'bend', label: 'Bend', default: 2, min: 0, max: 6, step: 0.1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'rests', label: 'Rests', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Marks' },
  ],
  navigators: [{ id: 'composition', label: 'Composition navigator', axes: ['density', 'bend', 'rests'] }],
  macros: [{ control: 'density', targets: [{ control: 'pitch', amount: -2 }] }],
  draw(ctx) {
    const pitch = Number(ctx.params.pitch);
    // Build paths using the resolved controls.
    return [{ id: 'lines', pen: 'ink', paths: [[{ x: 12, y: 12 }, { x: 198, y: 12 + pitch }]] }];
  },
};
export default sketch;
```

`navigators` is optional. Each navigator has an ID, a label, and 3–8 axes naming existing slider control IDs. An axis can be a macro source or an ordinary fine control. A navigator changes those same control values; it does not introduce a second set of parameters. The viewer offers **Base** and **With sketch macros** views so you can see the raw fine controls alongside their resolved values. Resetting a macro source returns it to its declared default, where its contribution is zero.

`macros` is optional. Each macro names an existing slider source and one or more existing base slider targets. The `amount` is a signed change in the **target's units** over the source's full normalized span, not a multiplier. For source value `v`, default `d`, and range `min…max`, its contribution to a target is `amount × ((v - min) / (max - min) - (d - min) / (max - min))`. In the example, moving `density` from its default `0.5` to `1` lowers `pitch` from 3 to 2 mm; moving it to `0` raises `pitch` to 4 mm. A negative amount therefore reverses the direction of the target. Source defaults need not be `0.5`, but their contributions are always zero at their own defaults.

The runner starts with raw base sliders, adds all macro contributions for each target, then clamps to the target's range and snaps to its legal step once. Multiple macros can target the same slider; they add before this final clamp and snap. A macro source cannot target a native macro source. This keeps authored adjustments stable and makes the result independent of macro declaration order. `draw(ctx)` reads resolved values from `ctx.params`, while `result.json` saves raw user choices in `params` and, for sketches declaring macros, the values passed to `draw` in `effectiveParams`. A sketch without macros retains its existing result shape.

Native sketch macros resolve before `draw`. If `draw` calls a hatch3d adapter, that adapter's legacy composition macros resolve inside its helper afterward. A native sketch macro may drive any exposed slider, including an adapter's converted control or legacy macro slider, provided the target is not also a native macro source. The adapter then applies its legacy macros to the values it received.

The [Civic weather study](../sketches/civic-weather/brief.md) declares three composition axes: `compositionDensity`, `currentMotion`, and `erosion`. Its five original mark sliders remain independently editable. To inspect the declarations or render a specific composition from the repository root:

```bash
npm run sketch -- inspect sketches/civic-weather/sketch.ts
npm run sketch -- render sketches/civic-weather/sketch.ts --params '{"compositionDensity":0.75,"currentMotion":0.65,"erosion":0.5}' --out sketch-output/civic-navigation
```

`--params` also accepts `@path/to/params.json`. Omitted controls use their defaults. Save the exact raw parameter map when sharing an edit; the rendered result records its resolved counterpart.
