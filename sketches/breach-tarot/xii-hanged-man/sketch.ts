import './prefers.ts'; // First: the fit this card prefers on a small card, declared before the format loads.
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawHangedMan } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XII The Hanged Man',
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
    { type: 'slider', id: 'bob', label: 'Bob height', default: 84, min: 25, max: 130, step: 1, units: 'mm', group: 'Plumb line' },
    { type: 'slider', id: 'bobWidth', label: 'Bob width (of its height)', default: 0.9, min: 0.4, max: 1.3, step: 0.01, group: 'Plumb line' },
    { type: 'slider', id: 'bare', label: 'Bare thread above the bob', default: 34, min: 8, max: 120, step: 1, units: 'mm', group: 'Plumb line' },
    { type: 'slider', id: 'gap', label: 'Point above the ground', default: 3, min: 0.5, max: 15, step: 0.5, units: 'mm', group: 'Plumb line' },
    { type: 'slider', id: 'footDrop', label: 'Foot below the horizon', default: 112, min: 15, max: 140, step: 1, units: 'mm', group: 'Plumb line' },
    { type: 'slider', id: 'lineX', label: 'Line across the card', default: 0, min: -0.3, max: 0.3, step: 0.01, group: 'Plumb line' },
    { type: 'slider', id: 'thread', label: 'Line (helix) radius', default: 0.12, min: 0.05, max: 1.2, step: 0.01, group: 'Plumb line' },
    { type: 'slider', id: 'ring', label: 'Target ring radius', default: 20, min: 5, max: 40, step: 0.5, units: 'mm', group: 'Plumb line' },
    { type: 'slider', id: 'towers', label: 'Leaning towers', default: 6, min: 2, max: 14, step: 1, group: 'City' },
    { type: 'slider', id: 'lean', label: 'Most lean', default: 18, min: 3, max: 30, step: 0.5, units: '°', group: 'City' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'City' },
    { type: 'select', id: 'phrasePlace', label: 'Phrase', default: 'towers', options: ['towers', 'flat'],
      optionLabels: { towers: 'Cut into the towers, leaning with them', flat: 'Painted flat on the ground' }, group: 'City' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it is easier to see from here' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawHangedMan(ctx);
  },
};

export default sketch;
