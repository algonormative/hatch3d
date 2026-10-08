import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawJudgement } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XX Judgement',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
    LETTERING_PEN,
  ],
  controls: [
    { type: 'slider', id: 'turn', label: 'Grid turned from the eye', default: 34, min: 10, max: 60, step: 1, units: '°', group: 'Plain' },
    { type: 'slider', id: 'gapAcross', label: 'Gap between boxes across', default: 5, min: 1, max: 9, step: 0.1, group: 'Plain' },
    { type: 'slider', id: 'gapAlong', label: 'Gap between boxes along', default: 8, min: 1.5, max: 14, step: 0.1, group: 'Plain' },
    { type: 'slider', id: 'originX', label: 'Nearest box, across', default: -6, min: -40, max: 40, step: 0.5, group: 'Plain' },
    { type: 'slider', id: 'originZ', label: 'Nearest box, away', default: -27, min: -70, max: -9, step: 0.5, group: 'Plain' },
    { type: 'slider', id: 'openNear', label: 'Lid opening, near', default: 105, min: 60, max: 130, step: 1, units: '°', group: 'Plain' },
    { type: 'slider', id: 'openFar', label: 'Lid opening, far', default: 8, min: 2, max: 30, step: 1, units: '°', group: 'Plain' },
    { type: 'slider', id: 'openNearDepth', label: 'Distance out to which lids are fully open', default: 20, min: 9, max: 60, step: 1, group: 'Plain' },
    { type: 'slider', id: 'openFall', label: 'Distance at which lids are only cracking', default: 85, min: 60, max: 260, step: 5, group: 'Plain' },
    { type: 'slider', id: 'reach', label: 'How far the plain runs', default: 220, min: 80, max: 500, step: 10, group: 'Plain' },
    { type: 'slider', id: 'horizonEdge', label: 'Horizon kept open at each edge', default: 12, min: 0, max: 40, step: 1, units: 'mm', group: 'Plain' },
    { type: 'slider', id: 'fragments', label: 'Boxes sending fragments up', default: 8, min: 0, max: 16, step: 1, group: 'Plain' },
    { type: 'slider', id: 'grazing', label: 'Drop hatch on faces seen this edge-on (cosine)', default: 0.12, min: 0, max: 0.5, step: 0.01, group: 'Look' },
    { type: 'slider', id: 'slitBelow', label: 'Dark slit under lids opened less than', default: 28, min: 0, max: 60, step: 1, units: '°', group: 'Look' },
    { type: 'slider', id: 'lidTone', label: 'Lid darkness', default: 0.5, min: 0.3, max: 1.4, step: 0.05, group: 'Look' },
    { type: 'slider', id: 'detail', label: 'Outline-only below this size', default: 14, min: 4, max: 40, step: 1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'hatch', label: 'Facet ring spacing (x the Tower)', default: 1.6, min: 0.5, max: 3, step: 0.05, group: 'Look' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.4, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 2.4, min: 0.8, max: 6, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'enterX', label: 'Where the horn enters the top', default: 34, min: 18, max: 120, step: 1, units: 'mm', group: 'Horn' },
    { type: 'slider', id: 'hook', label: 'How hard the horn hooks down at the mouth', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Horn' },
    { type: 'slider', id: 'mouthX', label: 'Mouth across the sheet', default: 178, min: 120, max: 250, step: 1, units: 'mm', group: 'Horn' },
    { type: 'slider', id: 'mouthY', label: 'Mouth down the sheet', default: 172, min: 100, max: 230, step: 1, units: 'mm', group: 'Horn' },
    { type: 'slider', id: 'mouthDist', label: 'Mouth distance from the eye', default: 230, min: 100, max: 260, step: 1, group: 'Horn' },
    { type: 'slider', id: 'thread', label: 'Cord (helix) radius at the thin end', default: 2.2, min: 0.8, max: 5, step: 0.05, group: 'Horn' },
    { type: 'slider', id: 'bell', label: 'How much wider the mouth is', default: 13, min: 2, max: 20, step: 0.1, group: 'Horn' },
    { type: 'slider', id: 'flare', label: 'How late the horn flares', default: 2.6, min: 1, max: 6, step: 0.1, group: 'Horn' },
    { type: 'slider', id: 'pitch', label: 'Horn length per turn at the thin end', default: 11, min: 5, max: 60, step: 1, group: 'Horn' },
    { type: 'slider', id: 'growth', label: 'How much the turns lengthen as it widens', default: 0.1, min: 0, max: 1, step: 0.01, group: 'Horn' },
    { type: 'slider', id: 'laminaeMm', label: 'Closest laminations on the sheet', default: 1.1, min: 0.55, max: 4, step: 0.05, units: 'mm', group: 'Horn' },
    { type: 'slider', id: 'ribs', label: 'Cross ribs', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Horn' },
    { type: 'slider', id: 'eye', label: 'Eye height', default: 8, min: 3, max: 14, step: 0.5, group: 'Camera' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 56, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'nothing was ever really deleted' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawJudgement(ctx);
  },
};

export default sketch;
