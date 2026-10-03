import type { ControlDef, MacroDef, MacroFn } from './legacy-types.js';
export function applyMacroFn(fn: MacroFn, strength: number, macroValue: number): number {
  const delta = (macroValue - 0.5) * 2;
  switch (fn) {
    case 'linear': return 1 + strength * delta;
    case 'log': return Math.exp(strength * Math.log(3) * delta);
    case 'exp': return Math.exp(strength * delta);
    case 'sqrt': return 1 + strength * (delta >= 0 ? 1 : -1) * Math.sqrt(Math.abs(delta));
  }
}
export function getControlDefaults(controls?: Record<string, ControlDef>): Record<string, unknown> {
  if (!controls) return {};
  return Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.type === 'image' ? null : control.default]));
}
export function getMacroDefaults(macros?: Record<string, MacroDef>): Record<string, number> {
  return Object.fromEntries(Object.entries(macros ?? {}).map(([key, macro]) => [key, macro.default]));
}
export function resolveValues(controls: Record<string, ControlDef> | undefined, macros: Record<string, MacroDef> | undefined,
  baseValues: Record<string, unknown>, macroValues: Record<string, number>): Record<string, unknown> {
  if (!controls) return { ...baseValues };
  const resolved = { ...baseValues };
  for (const [key, macro] of Object.entries(macros ?? {})) {
    const value = macroValues[key] ?? macro.default;
    for (const target of macro.targets) {
      const control = controls[target.param];
      if (control?.type === 'slider') {
        const next = (resolved[target.param] as number) * applyMacroFn(target.fn, target.strength, value);
        resolved[target.param] = Math.max(control.min, Math.min(control.max, next));
      }
    }
  }
  return resolved;
}
