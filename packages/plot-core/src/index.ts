/** Browser-safe physical Sketch contract and deterministic document operations. */
export type * from './types.js';
export { validateSketch, resolveParams, finalParts } from './validation.js';
export { svgFor } from './svg.js';
export { resolveFinishing, applyFinishing, mapFinishingPoint, mapFinishingBox, mapFinishingAssetMetadata, quantizeMm } from './finishing.js';
export type { ResolvedFinishing } from './finishing.js';
export { strokeText, strokeTextOnPath, measureStrokeText } from './stroke-text.js';
export type { StrokeFace, TextStyle, PathTextStyle } from './stroke-text.js';
export { snapSliderValue, resolveMacroParams } from './control-values.js';
export * from './control-geometry.js';
