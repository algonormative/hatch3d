import type { LegacyCompositionMetadata, ControlDef } from './legacy-types.js';
import type { AssetDeclaration, Control, Navigator, Params, RasterAsset } from './types.js';
import { getControlDefaults, getMacroDefaults, resolveValues } from './legacy-values.js';

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
const id = (prefix: string, section: string, key: string): string => `${safe(prefix)}__${section}__${safe(key)}`;

/** Native sliders require defaults to sit exactly on the min/step lattice. */
function stepFor(min: number, value: number, requested?: number): number {
  let step = requested ?? 0.01;
  while (Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-7 && step > 0.000001) step /= 10;
  if (Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-7) {
    throw new Error(`Cannot place default ${value} on slider lattice from ${min}`);
  }
  return step;
}

export interface LegacyControlPack {
  controls: Control[];
  navigators: Navigator[];
  values(params: Params, assets: Record<string, RasterAsset>, seed: number): Record<string, unknown>;
}

/** Converts legacy metadata to scalar Sketch controls without hiding unsupported image inputs. */
export function legacyControlPack(
  composition: Pick<LegacyCompositionMetadata, 'controls' | 'macros' | 'name'>,
  prefix: string,
  options: {
    defaults?: Record<string, number | boolean | string>;
    assets?: Record<string, AssetDeclaration>;
    imageBindings?: Record<string, string>;
    seedValueKey?: string;
    xyAxisLabels?: Record<string, [string, string]>;
  } = {},
): LegacyControlPack {
  const controls: Control[] = [];
  const navigators: Navigator[] = [];
  const defs = composition.controls ?? {};
  const defaults = options.defaults ?? {};
  const used = new Set<string>();
  const add = (control: Control) => {
    if (used.has(control.id)) throw new Error(`Duplicate converted control: ${control.id}`);
    used.add(control.id);
    controls.push(control);
  };
  const gate = (def: ControlDef): Pick<Control, 'showWhen'> => {
    if (!def.showWhen) return {};
    const equals = def.showWhen.equals;
    if (!['number', 'string', 'boolean'].includes(typeof equals)) throw new Error(`Unsupported showWhen value in ${composition.name}`);
    if (!(def.showWhen.control in defs)) throw new Error(`Unknown showWhen control ${def.showWhen.control} in ${composition.name}`);
    if (defs[def.showWhen.control].type === 'xy' || defs[def.showWhen.control].type === 'image') {
      throw new Error(`showWhen cannot target ${defs[def.showWhen.control].type} control ${def.showWhen.control}`);
    }
    return { showWhen: { control: id(prefix, 'control', def.showWhen.control), equals: equals as string | number | boolean } };
  };
  for (const [key, def] of Object.entries(defs)) {
    const common = { group: `${composition.name} / ${def.group}`, ...gate(def) };
    const controlId = id(prefix, 'control', key);
    if (def.type === 'slider') {
      const value = (defaults[key] ?? def.default) as number;
      add({ type: 'slider', id: controlId, label: def.label, default: value, min: def.min, max: def.max, step: stepFor(def.min, value, def.step ?? (def.max - def.min > 10 ? 1 : 0.01)), ...common });
    } else if (def.type === 'toggle') {
      add({ type: 'toggle', id: controlId, label: def.label, default: (defaults[key] ?? def.default) as boolean, ...common });
    } else if (def.type === 'select') {
      add({ type: 'select', id: controlId, label: def.label, default: (defaults[key] ?? def.default) as string, options: def.options.map((o) => o.value), optionLabels: Object.fromEntries(def.options.map((o) => [o.value, o.label])), ...common });
    } else if (def.type === 'xy') {
      const pair = def.default;
      for (const [axis, value] of [['x', pair[0]], ['y', pair[1]]] as const) {
        add({ type: 'slider', id: `${controlId}__${axis}`, label: `${def.label} ${axis.toUpperCase()}`, default: value, min: def.min, max: def.max, step: stepFor(def.min, value), ...common });
      }
      navigators.push({ id: `${controlId}__xy`, label: def.label, type: 'xy', axes: [`${controlId}__x`, `${controlId}__y`], ...(options.xyAxisLabels?.[key] ? { axisLabels: options.xyAxisLabels[key] } : {}) });
    } else {
      const assetId = options.imageBindings?.[key];
      if (!assetId || !options.assets?.[assetId]) throw new Error(`Image control ${key} in ${composition.name} needs an explicit Sketch asset binding`);
    }
  }
  for (const [key, macro] of Object.entries(composition.macros ?? {})) {
    add({ type: 'slider', id: id(prefix, 'macro', key), label: macro.label, default: macro.default, min: 0, max: 1, step: stepFor(0, macro.default, 0.01), group: `${composition.name} / Macros` });
  }

  return {
    controls,
    navigators,
    values(params, assets, seed) {
      const base = getControlDefaults(defs);
      for (const [key, def] of Object.entries(defs)) {
        if (def.type === 'xy') base[key] = [Number(params[`${id(prefix, 'control', key)}__x`]), Number(params[`${id(prefix, 'control', key)}__y`])];
        else if (def.type === 'image') {
          const assetId = options.imageBindings![key];
          const asset = assets[assetId];
          if (!asset) throw new Error(`Missing declared Sketch asset ${assetId} for ${key}`);
          base[key] = { brightness: asset.brightness, width: asset.width, height: asset.height, name: assetId };
        } else base[key] = params[id(prefix, 'control', key)] ?? defaults[key] ?? def.default;
      }
      const macroValues = getMacroDefaults(composition.macros);
      for (const key of Object.keys(composition.macros ?? {})) macroValues[key] = Number(params[id(prefix, 'macro', key)] ?? macroValues[key]);
      const resolved = resolveValues(defs, composition.macros, base, macroValues);
      // The Sketch seed offsets the legacy seed control/default so both affect output.
      if (options.seedValueKey) {
        const old = resolved[options.seedValueKey];
        if (typeof old !== 'number') throw new Error(`seedValueKey ${options.seedValueKey} must resolve to a number`);
        resolved[options.seedValueKey] = old + seed;
      }
      return resolved;
    },
  };
}

