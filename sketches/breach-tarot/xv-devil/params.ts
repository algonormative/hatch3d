import type { Control, SketchContext } from '../../../src/sketch/types.ts';
import { n } from '../../kit/params.ts';

/**
 * Every number this card reads, in one table: the sketch's controls are made from it and the
 * geometry reads through `param`, so the two cannot drift apart.
 */
interface Def { id: string; label: string; default: number; min: number; max: number; step: number; units?: string; group: string }

const PILLAR = 'Pillar', FIGURES = 'Figures', DOORS = 'Doors', LEASH = 'Leashes (helix)', LOOK = 'Look', CAMERA = 'Camera';

const DEFS: Def[] = [
  { id: 'pillarW', label: 'Pillar width', default: 7.1, min: 5, max: 11, step: 0.1, units: 'units', group: PILLAR },
  { id: 'pillarH', label: 'Pillar height', default: 12.5, min: 6, max: 16, step: 0.1, units: 'units', group: PILLAR },
  { id: 'pillarD', label: 'Pillar depth', default: 5, min: 3, max: 8, step: 0.1, units: 'units', group: PILLAR },
  { id: 'pillarDist', label: 'Distance of the pillar from the eye', default: 38, min: 30, max: 60, step: 0.5, group: PILLAR },
  { id: 'shaft', label: 'Courses in the shaft', default: 2, min: 2, max: 7, step: 1, group: PILLAR },
  { id: 'stonePitch', label: 'Stone hatch pitch', default: 0.4, min: 0.4, max: 1.5, step: 0.05, units: 'mm', group: PILLAR },
  { id: 'figX', label: 'Figures, across the page from the middle', default: 84, min: 50, max: 120, step: 1, units: 'mm', group: FIGURES },
  { id: 'figDist', label: 'Distance of the figures from the eye', default: 36, min: 25, max: 60, step: 0.5, group: FIGURES },
  { id: 'figHeight', label: 'Figure height', default: 4.8, min: 2.5, max: 6, step: 0.05, units: 'units', group: FIGURES },
  { id: 'figTurn', label: 'How far each turns from a clean profile toward us', default: 18, min: 0, max: 60, step: 1, units: '°', group: FIGURES },
  { id: 'figSlack', label: 'Hidden-line slack on the figures', default: 0.08, min: 0.01, max: 0.4, step: 0.01, group: FIGURES },
  { id: 'doorX', label: 'Doors, across the page from the middle', default: 84, min: 40, max: 118, step: 1, units: 'mm', group: DOORS },
  { id: 'doorDist', label: 'Distance of the doors from the eye', default: 26, min: 15, max: 60, step: 0.5, group: DOORS },
  { id: 'doorW', label: 'Door opening width', default: 2.7, min: 1.2, max: 5, step: 0.05, units: 'units', group: DOORS },
  { id: 'doorH', label: 'Door opening height', default: 9.2, min: 3, max: 12, step: 0.05, units: 'units', group: DOORS },
  { id: 'doorTurn', label: 'How far each frame turns toward the pillar from facing us', default: 20, min: 0, max: 80, step: 1, units: '°', group: DOORS },
  { id: 'doorHatch', label: 'Door hatch pitch', default: 2.2, min: 1, max: 6, step: 0.1, units: 'mm', group: DOORS },
  { id: 'doorOpen', label: 'How far open each door is swung', default: 100, min: 60, max: 150, step: 1, units: '°', group: DOORS },
  { id: 'leashR', label: 'Leash radius', default: 0.16, min: 0.05, max: 0.6, step: 0.01, group: LEASH },
  { id: 'leashPitch', label: 'Leash length per turn', default: 1.0, min: 0.3, max: 4, step: 0.05, group: LEASH },
  { id: 'leashSlack', label: 'How much slack the leash carries', default: 1, min: 0.3, max: 2, step: 0.05, group: LEASH },
  { id: 'leashAt', label: 'Where the leash leaves the pillar (share of its height)', default: 0.3, min: 0.15, max: 0.97, step: 0.01, group: LEASH },
  { id: 'leashHide', label: 'Hidden-line slack where the pillar, figures and doors hide the leashes', default: 0.1, min: 0.005, max: 0.2, step: 0.005, group: LEASH },
  { id: 'leashDensity', label: 'Leash lamination density', default: 0.25, min: 0.1, max: 1, step: 0.05, group: LEASH },
  { id: 'helixScale', label: 'Build the helix this many times larger, then scale back', default: 24, min: 8, max: 60, step: 1, group: LEASH },
  { id: 'variety', label: 'How much the seed moves the layout', default: 1, min: 0, max: 2, step: 0.05, group: LOOK },
  { id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: LOOK },
  { id: 'pocket', label: 'Clear paper round each figure', default: 3, min: 0.5, max: 8, step: 0.5, units: 'mm', group: LOOK },
  { id: 'slabSlack', label: 'Hidden-line slack on the slabs', default: 0.6, min: 0.1, max: 2, step: 0.05, group: LOOK },
  { id: 'shadowPitch', label: 'Shadow ruling pitch', default: 1.1, min: 0.5, max: 3, step: 0.05, units: 'mm', group: LOOK },
  { id: 'groundBand', label: 'Share of the sky that is black ground at the top', default: 0.2, min: 0, max: 0.5, step: 0.01, group: LOOK },
  { id: 'groundPitch', label: 'Black ground ruling pitch', default: 0.75, min: 0.5, max: 2, step: 0.05, units: 'mm', group: LOOK },
  { id: 'skyPitch', label: 'Sky ruling pitch', default: 3.0, min: 0.8, max: 6, step: 0.1, units: 'mm', group: LOOK },
  { id: 'sky', label: 'How far down the sky is ruled', default: 0.85, min: 0, max: 1.4, step: 0.01, group: LOOK },
  { id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: CAMERA },
];

const BY_ID = new Map(DEFS.map(d => [d.id, d]));

/** A numeric param by id, clamped to its control's range. */
export function param(ctx: SketchContext, id: string): number {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown param ${id}`);
  return n(ctx, id, d.default, d.min, d.max);
}

export function paramControls(): Control[] {
  return DEFS.map((d): Control => ({ type: 'slider', id: d.id, label: d.label, default: d.default, min: d.min, max: d.max, step: d.step, units: d.units, group: d.group }));
}
