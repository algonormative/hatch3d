// First: the fit this card prefers on a small card, declared before the format loads.
import './prefers.ts';
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawStrength } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: VIII Strength',
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
    { type: 'slider', id: 'damHeight', label: 'Dam height', default: 170, min: 60, max: 300, step: 1, group: 'Dam' },
    { type: 'slider', id: 'eyeRise', label: 'Eye above the crest', default: 88, min: 20, max: 160, step: 1, group: 'Dam' },
    { type: 'slider', id: 'lakeBelow', label: 'Lake below the crest', default: 1.5, min: 0.3, max: 8, step: 0.1, group: 'Dam' },
    { type: 'slider', id: 'parapet', label: 'Parapet height', default: 4.2, min: 1, max: 10, step: 0.1, group: 'Dam' },
    { type: 'slider', id: 'courses', label: 'Courses', default: 10, min: 5, max: 20, step: 1, group: 'Dam' },
    { type: 'slider', id: 'crest', label: 'Thickness at the crest', default: 9, min: 4, max: 20, step: 0.5, group: 'Dam' },
    { type: 'slider', id: 'base', label: 'Thickness at the base', default: 13, min: 4, max: 60, step: 1, group: 'Dam' },
    { type: 'slider', id: 'panel', label: 'Panel length (of its distance)', default: 0.2, min: 0.04, max: 0.3, step: 0.005, group: 'Dam' },
    { type: 'slider', id: 'nearDepth', label: 'Distance at the near end', default: 200, min: 100, max: 400, step: 5, group: 'Dam' },
    { type: 'slider', id: 'farDepth', label: 'Distance at the far end', default: 600, min: 350, max: 1500, step: 10, group: 'Dam' },
    { type: 'slider', id: 'bow', label: 'Bow upstream', default: 90, min: 0, max: 160, step: 1, group: 'Dam' },
    { type: 'slider', id: 'knockout', label: 'Paper round the wall', default: 0.6, min: 0.2, max: 2, step: 0.05, units: 'mm', group: 'Dam' },
    { type: 'slider', id: 'slabSlack', label: 'Hidden-line slack, slabs', default: 0.6, min: 0.1, max: 2, step: 0.05, group: 'Dam' },
    { type: 'slider', id: 'lightX', label: 'Light from the side', default: 0, min: -1, max: 1, step: 0.01, group: 'Dam' },
    { type: 'slider', id: 'lightZ', label: 'Light from the front', default: 0.12, min: 0.05, max: 1.5, step: 0.01, group: 'Dam' },
    { type: 'slider', id: 'gorge', label: 'Shadow rules down the wall', default: 0.5, min: 0, max: 1, step: 0.05, group: 'Dam' },
    { type: 'slider', id: 'tube', label: 'Helix radius', default: 6.5, min: 3, max: 20, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'tip', label: 'Tail tip (of its girth)', default: 0.14, min: 0.05, max: 0.4, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'coilTurns', label: 'Coil turns', default: 3.2, min: 2, max: 5, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'coilRadius', label: 'Coil radius', default: 80, min: 40, max: 140, step: 1, group: 'Helix' },
    { type: 'slider', id: 'coilRise', label: 'Coil rise per turn (girths)', default: 1.4, min: 0, max: 2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'coilDepth', label: 'Coil distance', default: 580, min: 250, max: 900, step: 5, group: 'Helix' },
    { type: 'slider', id: 'coilAcross', label: 'Coil across the card', default: 100, min: 18, max: 261, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'tailSway', label: 'Tail sway', default: 0.1, min: 0, max: 0.3, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'tailFlare', label: 'Tail thins late (higher = later)', default: 7, min: 2, max: 12, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'neckTop', label: 'Top of the neck on the card', default: 122, min: 60, max: 200, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'hookRadius', label: 'Hook radius (of the way to the person)', default: 0.3, min: 0.12, max: 0.4, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'headOffset', label: 'Head to the side of the person (on the sheet)', default: 0, min: -60, max: 60, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'headSwell', label: 'Head end swells', default: 1.5, min: 1, max: 2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'headGap', label: 'Head above the person (on the sheet)', default: 32, min: 5, max: 60, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'helixPitch', label: 'Turn length (girths)', default: 5, min: 2, max: 9, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'helixWidth', label: 'Ribbon width (of the radius)', default: 0.5, min: 0.25, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixDensity', label: 'Helix hatch density', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixSlack', label: 'Hidden-line slack, helix', default: 0.4, min: 0.1, max: 2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixKnockout', label: 'Paper round the helix', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'variety', label: 'How far the seed moves the layout', default: 1, min: 0, max: 2, step: 0.05, group: 'Seed' },
    { type: 'slider', id: 'figureAt', label: 'Person along the dam', default: 0.72, min: 0.05, max: 0.95, step: 0.01, group: 'Person' },
    { type: 'slider', id: 'figure', label: 'Person height on the card', default: 26, min: 12, max: 50, step: 1, units: 'mm', group: 'Person' },
    { type: 'select', id: 'figureStyle', label: 'How the person is drawn', default: 'body', options: ['scratch', 'body'],
      optionLabels: { scratch: 'Scratch figure (approved)', body: 'Body, as in Lovers and Devil' }, group: 'Person' },
    { type: 'slider', id: 'pocket', label: 'Clear pocket round it', default: 1.5, min: 1, max: 3.5, step: 0.05, group: 'Person' },
    { type: 'slider', id: 'figureSlack', label: 'Hidden-line slack, person', default: 1.2, min: 0.1, max: 3, step: 0.05, group: 'Person' },
    { type: 'slider', id: 'sky', label: 'How far the sky ruling reaches down', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'skyPitch', label: 'Sky rule pitch', default: 1.3, min: 0.8, max: 2.5, step: 0.05, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'skyClear', label: 'Clear paper round the neck and head', default: 2.6, min: 0.5, max: 6, step: 0.1, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'lakePitch', label: 'Lake line pitch', default: 0.54, min: 0.5, max: 1.2, step: 0.01, units: 'mm', group: 'Water' },
    { type: 'slider', id: 'wordStretch', label: 'Words stretched back from the slant', default: 0.8, min: 0, max: 1, step: 0.05, group: 'Phrase' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it lets you hold it' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawStrength(ctx);
  },
};

export default sketch;
