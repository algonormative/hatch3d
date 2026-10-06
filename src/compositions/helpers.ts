import type { MacroDef, ControlDef, LayeredLayer } from "./types";

import { getControlDefaults, getMacroDefaults, resolveValues } from '../../packages/plot-core/src/legacy-values.ts';
export { applyMacroFn, getControlDefaults, getMacroDefaults, resolveValues } from '../../packages/plot-core/src/legacy-values.ts';

export { lightModulatedLayers } from "./helpers-lighting";
export { lightDensityFn, curvatureDensityFn, radialDensityFn } from "./helpers-density";

const warnedMissingShowWhenKeys = new Set<string>();

/**
 * Returns true when `control` should render in the UI.
 *
 * Reads the gate from `currentValues` (raw, pre-macro). Falls back to the
 * gating control's `default` if the key is absent. If `showWhen.control`
 * doesn't exist in `controls`, returns `true` (typo-tolerant) and warns once.
 */
export function isControlVisible(
  control: ControlDef,
  currentValues: Record<string, unknown>,
  controls: Record<string, ControlDef>,
): boolean {
  if (!control.showWhen) return true;
  const gateKey = control.showWhen.control;
  const gateControl = controls[gateKey];
  if (!gateControl) {
    if (!warnedMissingShowWhenKeys.has(gateKey)) {
      warnedMissingShowWhenKeys.add(gateKey);
      console.warn(`isControlVisible: showWhen.control "${gateKey}" not found in controls`);
    }
    return true;
  }
  const fallback = gateControl.type === "image" ? null : gateControl.default;
  const actual = gateKey in currentValues ? currentValues[gateKey] : fallback;
  return actual === control.showWhen.equals;
}

/**
 * Resolve an inner composition's control values for a given layered layer.
 *
 * Combines defaults + per-layer paramOverrides + per-layer macroOverrides
 * into the final resolvedValues bag the inner composition receives.
 * Pure: no I/O, no input mutation. Tolerates an inner with no controls.
 */
export function resolveLayerInnerValues(
  inner: {
    controls?: Record<string, ControlDef>;
    macros?: Record<string, MacroDef>;
  },
  layer: LayeredLayer,
): Record<string, unknown> {
  const baseValues = {
    ...getControlDefaults(inner.controls),
    ...((layer.paramOverrides as Record<string, unknown> | undefined) ?? {}),
  };
  const macroValues = {
    ...getMacroDefaults(inner.macros),
    ...(layer.macroOverrides ?? {}),
  };
  return resolveValues(inner.controls, inner.macros, baseValues, macroValues);
}

/** Get unique groups from controls in declaration order */
export function getControlGroups(controls?: Record<string, ControlDef>): string[] {
  if (!controls) return [];
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const ctrl of Object.values(controls)) {
    if (!seen.has(ctrl.group)) {
      seen.add(ctrl.group);
      groups.push(ctrl.group);
    }
  }
  return groups;
}
