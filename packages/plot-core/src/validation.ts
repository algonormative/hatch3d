import { clipPolylineToRect } from './clip.js';
import { applyFinishing, type ResolvedFinishing } from './finishing.js';
import type { AssetDeclaration, Control, Macro, Navigator, Page, Params, Part, Pen, Point, Sketch } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

export function validateSketch(value: unknown): Sketch {
  assert(object(value), 'Sketch default export must be an object');
  assert(nonempty(value.name), 'Sketch name must be nonempty');
  assert(object(value.page), 'Sketch page is required');
  const page = value.page as unknown as Page;
  assert(finite(page.width) && page.width > 0 && finite(page.height) && page.height > 0, 'Page width and height must be positive finite millimeters');
  assert(Math.round(page.width * 1000) > 0 && Math.round(page.height * 1000) > 0, 'Page dimensions must survive millimeter quantization');
  assert(page.margin === undefined || (finite(page.margin) && page.margin >= 0 && page.margin * 2 < Math.min(page.width, page.height)), 'Page margin must fit the page');
  assert(page.paper === undefined || nonempty(page.paper), 'Page paper must be a color string');
  assert(value.pageAware === undefined || typeof value.pageAware === 'boolean', 'Sketch pageAware must be a boolean');
  assert(Array.isArray(value.pens) && value.pens.length > 0, 'Sketch needs at least one pen');
  const penIds = new Set<string>();
  for (const pen of value.pens as Pen[]) {
    assert(object(pen) && validId(pen.id) && nonempty(pen.color) && finite(pen.width) && Math.round(pen.width * 1000) > 0, 'Each pen needs a safe id, color, and width of at least 0.001 mm');
    assert(pen.passes === undefined || (Number.isSafeInteger(pen.passes) && pen.passes >= 1 && pen.passes <= 100), `Pen ${pen.id} passes must be an integer from 1 to 100`);
    assert(!penIds.has(pen.id), `Duplicate pen id: ${pen.id}`);
    penIds.add(pen.id);
  }
  assert(Array.isArray(value.controls), 'Sketch controls must be an array');
  const controlIds = new Set<string>();
  for (const control of value.controls as Control[]) {
    assert(object(control) && validId(control.id) && nonempty(control.label), 'Each control needs a safe id and label');
    assert(!controlIds.has(control.id), `Duplicate control id: ${control.id}`);
    controlIds.add(control.id);
    assert(control.units === undefined || typeof control.units === 'string', `Invalid units for ${control.id}`);
    assert(control.expensive === undefined || typeof control.expensive === 'boolean', `Invalid expensive flag for ${control.id}`);
    assert(control.group === undefined || nonempty(control.group), `Invalid group for ${control.id}`);
    assert(control.showWhen === undefined || (object(control.showWhen) && validId(control.showWhen.control)), `Invalid showWhen for ${control.id}`);
    if (control.type === 'slider') {
      assert(finite(control.min) && finite(control.max) && finite(control.step) && control.min <= control.max && control.step > 0, `Invalid slider range: ${control.id}`);
      validateControlValue(control, control.default);
    } else if (control.type === 'toggle') {
      validateControlValue(control, control.default);
    } else if (control.type === 'select') {
      assert(Array.isArray(control.options) && control.options.length > 0 && control.options.every(nonempty) && new Set(control.options).size === control.options.length, `Invalid select options: ${control.id}`);
      validateControlValue(control, control.default);
      assert(control.optionLabels === undefined || (object(control.optionLabels) && Object.entries(control.optionLabels).every(([key, label]) => control.options.includes(key) && nonempty(label))), `Invalid option labels for ${control.id}`);
    } else if (control.type === 'text') {
      assert(Number.isSafeInteger(control.maxLength) && control.maxLength >= 1 && control.maxLength <= 256, `Invalid text maxLength: ${control.id}`);
      validateControlValue(control, control.default);
    } else {
      throw new Error(`Unknown control type: ${String((control as { type: unknown }).type)}`);
    }
  }
  const controls = value.controls as Control[];
  const controlsById = new Map(controls.map((control) => [control.id, control]));
  for (const control of controls) {
    if (!control.showWhen) continue;
    const gate = controlsById.get(control.showWhen.control);
    assert(gate && gate.id !== control.id, `Invalid showWhen reference for ${control.id}`);
    validateControlValue(gate, control.showWhen.equals);
    const visited = new Set([control.id]);
    let current: Control | undefined = gate;
    while (current?.showWhen) {
      assert(!visited.has(current.id), `Cyclic showWhen reference for ${control.id}`);
      visited.add(current.id);
      current = controlsById.get(current.showWhen.control);
    }
  }
  if (value.navigators !== undefined) {
    assert(Array.isArray(value.navigators), 'Sketch navigators must be an array');
    const navigatorIds = new Set<string>();
    for (const navigator of value.navigators as Navigator[]) {
      assert(object(navigator) && validId(navigator.id) && nonempty(navigator.label) && Array.isArray(navigator.axes), 'Navigator needs a safe id, label, and axes');
      const type = navigator.type === undefined ? 'radar' : navigator.type;
      assert(type === 'radar' || type === 'xy' || type === 'xyz', `Unknown navigator type: ${String(type)}`);
      const expectedAxes = type === 'xy' ? 2 : type === 'xyz' ? 3 : undefined;
      assert(expectedAxes === undefined ? navigator.axes.length >= 3 && navigator.axes.length <= 8 : navigator.axes.length === expectedAxes,
        `${type === 'radar' ? 'Radar navigator needs 3-8 axes' : `${type.toUpperCase()} navigator needs ${expectedAxes} axes`}: ${navigator.id}`);
      const options = navigator as unknown as Record<string, unknown>;
      if (type === 'xy') {
        assert(options.yDirection === undefined || options.yDirection === 'up' || options.yDirection === 'down', `Invalid navigator yDirection: ${navigator.id}`);
      } else {
        assert(options.yDirection === undefined, `Invalid navigator yDirection: ${navigator.id}`);
      }
      if (type === 'radar') {
        assert(options.axisLabels === undefined, `Invalid navigator axisLabels: ${navigator.id}`);
      } else {
        assert(options.axisLabels === undefined || (Array.isArray(options.axisLabels) && options.axisLabels.length === expectedAxes && options.axisLabels.every(nonempty)),
          `Invalid navigator axisLabels: ${navigator.id}`);
      }
      assert(!navigatorIds.has(navigator.id), `Duplicate navigator id: ${navigator.id}`);
      navigatorIds.add(navigator.id);
      const axes = new Set<string>();
      for (const axis of navigator.axes) {
        const control = controlsById.get(axis);
        assert(validId(axis) && !axes.has(axis) && control?.type === 'slider' && control.max > control.min, `Invalid navigator axis: ${String(axis)}`);
        axes.add(axis);
      }
    }
  }
  if (value.macros !== undefined) {
    assert(Array.isArray(value.macros), 'Sketch macros must be an array');
    const macroSources = new Set<string>();
    for (const macro of value.macros as Macro[]) {
      assert(object(macro) && validId(macro.control) && Array.isArray(macro.targets) && macro.targets.length > 0, 'Macro needs a source control and targets');
      const source = controlsById.get(macro.control);
      assert(source?.type === 'slider' && source.max > source.min, `Invalid macro source: ${macro.control}`);
      assert(!macroSources.has(macro.control), `Duplicate macro source: ${macro.control}`);
      macroSources.add(macro.control);
    }
    for (const macro of value.macros as Macro[]) {
      const targets = new Set<string>();
      for (const target of macro.targets) {
        assert(object(target) && validId(target.control) && finite(target.amount), `Invalid macro target for ${macro.control}`);
        const control = controlsById.get(target.control);
        assert(control?.type === 'slider' && control.max > control.min && target.control !== macro.control && !macroSources.has(target.control), `Invalid macro target: ${target.control}`);
        assert(!targets.has(target.control), `Duplicate macro target: ${target.control}`);
        targets.add(target.control);
      }
    }
  }
  assert(value.assets === undefined || object(value.assets), 'Sketch assets must be a record');
  for (const [id, asset] of Object.entries((value.assets ?? {}) as Record<string, AssetDeclaration>)) {
    assert(validId(id) && object(asset) && nonempty(asset.path) && (asset.fit === 'contain' || asset.fit === 'cover'), `Invalid asset: ${id}`);
    assert(object(asset.box) && finite(asset.box.x) && finite(asset.box.y) && finite(asset.box.width) && finite(asset.box.height) && asset.box.width > 0 && asset.box.height > 0, `Invalid asset box: ${id}`);
  }
  assert(typeof value.draw === 'function', 'Sketch draw(ctx) must be a function');
  return value as unknown as Sketch;
}

function validateControlValue(control: Control, value: unknown): void {
  if (control.type === 'slider') {
    assert(finite(value) && value >= control.min && value <= control.max, `Invalid value for slider ${control.id}`);
    const steps = (value - control.min) / control.step;
    assert(Math.abs(steps - Math.round(steps)) < 1e-7, `Value for slider ${control.id} does not align to step`);
  } else if (control.type === 'toggle') {
    assert(typeof value === 'boolean', `Invalid value for toggle ${control.id}`);
  } else if (control.type === 'select') {
    assert(typeof value === 'string' && control.options.includes(value), `Invalid value for select ${control.id}`);
  } else {
    assert(typeof value === 'string' && value.length <= control.maxLength, `Invalid value for text ${control.id}: maximum ${control.maxLength} UTF-16 units`);
  }
}

export function resolveParams(controls: Control[], supplied: unknown): Params {
  assert(supplied === undefined || object(supplied), 'Parameters must be a JSON object');
  const provided = supplied ?? {};
  const ids = new Set(controls.map((c) => c.id));
  for (const id of Object.keys(provided)) assert(ids.has(id), `Unknown parameter: ${id}`);
  const params: Params = {};
  for (const control of controls) {
    const value = Object.prototype.hasOwnProperty.call(provided, control.id) ? provided[control.id] : control.default;
    validateControlValue(control, value);
    params[control.id] = value as number | boolean | string;
  }
  return params;
}

const quantize = (n: number): number => Math.round(n * 1000) / 1000;
function validatePoints(paths: unknown, label: string, min: number): asserts paths is Point[][] {
  assert(Array.isArray(paths), `${label} must be an array of paths`);
  for (const path of paths) {
    assert(Array.isArray(path) && path.length >= min, `${label} path needs at least ${min} points`);
    for (const point of path) assert(object(point) && finite(point.x) && finite(point.y), `${label} contains a non-finite point`);
  }
}

export function finalParts(raw: unknown, sketch: Sketch, finishing?: ResolvedFinishing, seed = 0): Part[] {
  assert(Array.isArray(raw), 'Sketch draw(ctx) must return an array of parts');
  const ids = new Set<string>();
  const pens = new Set(sketch.pens.map((p) => p.id));
  const margin = sketch.page.margin ?? 0;
  const rect = { xMin: margin, yMin: margin, xMax: sketch.page.width - margin, yMax: sketch.page.height - margin };
  const parts = raw.map((part: Part) => {
    assert(object(part) && validId(part.id) && nonempty(part.pen) && pens.has(part.pen), 'Part needs a unique safe id and declared pen');
    assert(!ids.has(part.id), `Duplicate part id: ${part.id}`); ids.add(part.id);
    assert(part.diagnostic === undefined || typeof part.diagnostic === 'boolean', `Invalid diagnostic flag for ${part.id}`);
    validatePoints(part.paths, `Part ${part.id}`, 2);
    if (part.boundary !== undefined) validatePoints(part.boundary, `Boundary of ${part.id}`, 3);
    if (finishing) return { id: part.id, pen: part.pen, paths: part.paths, ...(part.boundary ? { boundary: part.boundary } : {}), ...(part.diagnostic === undefined ? {} : { diagnostic: part.diagnostic }) };
    let paths = part.paths.flatMap((path) => clipPolylineToRect(path, rect));
    paths = paths.map((path) => path.map((p) => ({ x: quantize(p.x), y: quantize(p.y) }))).filter((path) => path.some((p, i) => i > 0 && (p.x !== path[i - 1].x || p.y !== path[i - 1].y)));
    const boundary = part.boundary?.map((ring) => ring.map((p) => ({ x: quantize(p.x), y: quantize(p.y) })));
    for (const path of [...paths, ...(boundary ?? [])]) for (const point of path) assert(finite(point.x) && finite(point.y), `Part ${part.id} overflowed while clipping or quantizing`);
    return { id: part.id, pen: part.pen, paths, ...(boundary ? { boundary } : {}), ...(part.diagnostic === undefined ? {} : { diagnostic: part.diagnostic }) };
  });
  return finishing ? applyFinishing(parts, finishing, seed) : parts;
}

