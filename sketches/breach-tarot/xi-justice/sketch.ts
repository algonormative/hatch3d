import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawJustice } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XI Justice',
  page: TABLOID_PAGE,
  pageAware: true,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
    LETTERING_PEN,
  ],
  controls: [
    { type: 'select', id: 'side', label: 'Which side the short arm is on', default: 'seed', options: ['seed', 'left', 'right'],
      optionLabels: { seed: 'By the seed', left: 'Short arm (the heap) on the left', right: 'Short arm (the heap) on the right' }, group: 'Balance' },
    { type: 'slider', id: 'dist', label: 'Distance to the balance', default: 30, min: 24, max: 90, step: 1, units: 'u', group: 'Balance' },
    { type: 'slider', id: 'spanL', label: 'Short arm chain across the page (unmirrored)', default: 64, min: 40, max: 100, step: 1, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'spanR', label: 'Long arm chain across the page (unmirrored)', default: 236, min: 200, max: 252, step: 1, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'ratio', label: 'Long arm over short arm', default: 2.4, min: 1.6, max: 4, step: 0.05, group: 'Balance' },
    { type: 'slider', id: 'overhang', label: 'Beam past each chain', default: 10, min: 4, max: 20, step: 0.5, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'beamY', label: 'Beam centre (page y)', default: 124, min: 90, max: 170, step: 1, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'beamH', label: 'Beam height', default: 17, min: 8, max: 30, step: 0.5, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'drop', label: 'Chain drop under the beam', default: 92, min: 50, max: 140, step: 1, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'panThick', label: 'Pan thickness', default: 4.5, min: 2, max: 9, step: 0.5, units: 'mm', group: 'Balance' },
    { type: 'slider', id: 'colW', label: 'Column width', default: 31, min: 20, max: 50, step: 0.5, units: 'mm', group: 'Column' },
    { type: 'slider', id: 'courses', label: 'Column courses', default: 4, min: 3, max: 9, step: 1, group: 'Column' },
    { type: 'slider', id: 'pileW', label: 'Heap width at the foot', default: 50, min: 30, max: 70, step: 1, units: 'mm', group: 'Heap' },
    { type: 'slider', id: 'pileH', label: 'Heap height', default: 72, min: 30, max: 100, step: 1, units: 'mm', group: 'Heap' },
    { type: 'slider', id: 'pileRows', label: 'Heap rows', default: 5, min: 3, max: 9, step: 1, group: 'Heap' },
    { type: 'slider', id: 'blockW', label: 'Typical heap block width', default: 18, min: 10, max: 30, step: 0.5, units: 'mm', group: 'Heap' },
    { type: 'slider', id: 'blockSize', label: 'The single block', default: 13, min: 8, max: 24, step: 0.5, units: 'mm', group: 'Heap' },
    { type: 'slider', id: 'hatch', label: 'Finest hatch pitch on the blocks', default: 0.7, min: 0.5, max: 2, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'gradient', label: 'How far the light shades across a lit face', default: 1.1, min: 0, max: 2, step: 0.05, group: 'Look' },
    { type: 'slider', id: 'cord', label: 'Cord (helix) radius', default: 0.28, min: 0.1, max: 0.5, step: 0.01, group: 'Cord' },
    { type: 'slider', id: 'cordPitch', label: 'Cord length per turn', default: 3.2, min: 1.5, max: 8, step: 0.1, group: 'Cord' },
    { type: 'slider', id: 'flare', label: 'How much wider the cord is at the top', default: 3, min: 1, max: 4, step: 0.05, group: 'Cord' },
    { type: 'slider', id: 'chainScale', label: 'Chain width against the cord', default: 0.06, min: 0.03, max: 1.2, step: 0.01, group: 'Cord' },
    { type: 'slider', id: 'lean', label: 'Lean of the cord toward the middle at the top', default: 0, min: -60, max: 60, step: 1, units: 'mm', group: 'Cord' },
    { type: 'slider', id: 'corner', label: 'Turn radius where the cord parts', default: 11, min: 5, max: 20, step: 0.5, units: 'mm', group: 'Cord' },
    { type: 'slider', id: 'cordStand', label: 'Cord stand-off in front of the beam', default: 0.8, min: 0.5, max: 1.6, step: 0.05, units: 'u', group: 'Cord' },
    { type: 'slider', id: 'cordHalo', label: 'Paper round the cord', default: 3, min: 1, max: 8, step: 0.25, units: 'mm', group: 'Cord' },
    { type: 'slider', id: 'tilt', label: 'Tilt of the shadow\'s beam on the sheet (heavy end down)', default: 11, min: 0, max: 25, step: 0.5, units: '°', group: 'Shadow' },
    { type: 'slider', id: 'reach', label: 'How far the shadow falls toward the eye (per unit of height)', default: 0.4, min: 0.1, max: 0.8, step: 0.01, group: 'Shadow' },
    { type: 'slider', id: 'shadowShift', label: 'Shadow across the card', default: 0, min: -40, max: 40, step: 1, units: 'mm', group: 'Shadow' },
    { type: 'slider', id: 'shadowPitch', label: 'Shadow hatch pitch', default: 0.95, min: 0.5, max: 2, step: 0.05, units: 'mm', group: 'Shadow' },
    { type: 'slider', id: 'shadowAngle', label: 'Shadow hatch angle', default: 0, min: -60, max: 60, step: 1, units: '°', group: 'Shadow' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Ground and sky' },
    { type: 'slider', id: 'sky', label: 'How far the sky ruling reaches down', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Ground and sky' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 1.4, min: 0.8, max: 5, step: 0.1, units: 'mm', group: 'Ground and sky' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it all balances in the end' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.2 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawJustice(ctx);
  },
};

export default sketch;
