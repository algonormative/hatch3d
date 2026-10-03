import { getControlDefaults, getMacroDefaults, resolveValues } from '../compositions/helpers.ts';
import type { CompositionMetadata, ControlDef, HatchGroupConfig } from '../compositions/types.ts';
import { HATCH_GROUP_DEFAULT } from '../compositions/types.ts';
import type { AssetDeclaration, Control, Params, RasterAsset } from './types.ts';

const FAMILIES = ['inherit', 'u', 'v', 'diagonal', 'rings', 'hex', 'crosshatch', 'spiral'];
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
  values(params: Params, assets: Record<string, RasterAsset>, seed: number): Record<string, unknown>;
}

/** Converts legacy metadata to scalar Sketch controls without hiding unsupported image inputs. */
export function legacyControlPack(
  composition: Pick<CompositionMetadata, 'controls' | 'macros' | 'name'>,
  prefix: string,
  options: {
    defaults?: Record<string, number | boolean | string>;
    assets?: Record<string, AssetDeclaration>;
    imageBindings?: Record<string, string>;
    seedValueKey?: string;
  } = {},
): LegacyControlPack {
  const controls: Control[] = [];
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

export interface HatchGroupPack {
  controls: Control[];
  values(params: Params): Record<string, HatchGroupConfig>;
}

export function hatchGroupPack(groups: string[] | undefined, prefix: string): HatchGroupPack {
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const group of groups ?? []) {
    const key = safe(group);
    if (seen.has(key)) throw new Error(`Hatch group id collision: ${group}`);
    seen.add(key);
    const base = id(prefix, 'hatchgroup', group);
    const common = { group: `Hatching / ${group}` };
    controls.push({ type: 'toggle', id: `${base}__override`, label: 'Override hatching', default: false, ...common });
    const gate = { showWhen: { control: `${base}__override`, equals: true } };
    controls.push({ type: 'select', id: `${base}__family`, label: 'Family', default: 'u', options: FAMILIES.filter((f) => f !== 'inherit'), ...common, ...gate });
    controls.push({ type: 'slider', id: `${base}__count`, label: 'Count', default: 30, min: 5, max: 80, step: 1, ...common, ...gate });
    controls.push({ type: 'slider', id: `${base}__samples`, label: 'Samples', default: 50, min: 10, max: 120, step: 1, ...common, ...gate });
    controls.push({ type: 'slider', id: `${base}__angle`, label: 'Angle (diagonal / crosshatch)', default: 0.7, min: 0, max: 3.14, step: 0.01, units: 'rad', ...common, ...gate });
  }
  return {
    controls,
    values(params) {
      const result: Record<string, HatchGroupConfig> = {};
      for (const group of groups ?? []) {
        const base = id(prefix, 'hatchgroup', group);
        result[group] = {
          family: params[`${base}__override`] === true ? (params[`${base}__family`] as HatchGroupConfig['family']) : 'inherit',
          count: Number(params[`${base}__count`] ?? HATCH_GROUP_DEFAULT.count),
          samples: Number(params[`${base}__samples`] ?? HATCH_GROUP_DEFAULT.samples),
          angle: Number(params[`${base}__angle`] ?? HATCH_GROUP_DEFAULT.angle),
        };
      }
      return result;
    },
  };
}
