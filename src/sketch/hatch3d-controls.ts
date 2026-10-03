import type { HatchGroupConfig } from '../compositions/types.ts';
import { HATCH_GROUP_DEFAULT } from '../compositions/types.ts';
import type { Control, Params } from './types.ts';
export { legacyControlPack } from '../../packages/plot-core/src/legacy-controls.ts';
export type { LegacyControlPack } from '../../packages/plot-core/src/legacy-controls.ts';
const FAMILIES = ['inherit', 'u', 'v', 'diagonal', 'rings', 'hex', 'crosshatch', 'spiral'];
const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
const id = (prefix: string, section: string, key: string): string => `${safe(prefix)}__${section}__${safe(key)}`;

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
