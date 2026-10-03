import type { Control, Macro, Params } from './types.js';

/** Return a fresh parameter record after applying validated native macros. */
export declare function resolveMacroParams(controls: Control[], params: Params, macros?: Macro[]): Params;
/** Clamp and snap once to a slider's legal lattice within its declared maximum. */
export declare function snapSliderValue(control: Extract<Control, { type: 'slider' }>, value: number): number;
