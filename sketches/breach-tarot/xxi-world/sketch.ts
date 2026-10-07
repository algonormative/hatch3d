import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawWorld } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XXI The World',
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
    { type: 'slider', id: 'tilt', label: 'Looking down', default: 40, min: 20, max: 90, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 45, min: 25, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'centreY', label: 'Centre down the card', default: 0.64, min: 0.3, max: 0.85, step: 0.01, group: 'Camera' },
    { type: 'slider', id: 'fit', label: 'Labyrinth across the card', default: 0.94, min: 0.6, max: 1.05, step: 0.01, group: 'Labyrinth' },
    { type: 'slider', id: 'courses', label: 'Wall courses', default: 2, min: 1, max: 4, step: 1, group: 'Labyrinth' },
    { type: 'select', id: 'figure', label: 'At the centre', default: 'arrived', options: ['arrived', 'fool', 'dancer'],
      optionLabels: { arrived: 'The Fool, arrived: grown into his suit', fool: 'The Fool as he set out, in the big suit', dancer: 'A bare dancer' }, group: 'Figure' },
    { type: 'slider', id: 'suitSize', label: 'Suit fit (1 = fitted)', default: 1.05, min: 1, max: 1.6, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'figureHeight', label: 'Figure height', default: 56, min: 30, max: 90, step: 1, group: 'Figure' },
    { type: 'slider', id: 'turn', label: 'Figure turned', default: 10, min: -90, max: 90, step: 1, units: '°', group: 'Figure' },
    { type: 'slider', id: 'figureSlack', label: 'Figure hidden-line slack', default: 1.2, min: 0, max: 4, step: 0.1, group: 'Figure' },
    { type: 'slider', id: 'glow', label: 'His light above the floor (of his height)', default: 1.5, min: 1.05, max: 4, step: 0.05, group: 'Light' },
    { type: 'slider', id: 'shadowPitch', label: 'Shadow hatch pitch', default: 0.62, min: 0.4, max: 1.5, step: 0.01, units: 'mm', group: 'Light' },
    { type: 'slider', id: 'figureClear', label: 'Paper round the figure', default: 1.7, min: 0.5, max: 6, step: 0.1, units: 'mm', group: 'Figure' },
    { type: 'slider', id: 'quietFrom', label: 'Bricks only indicated above (mm below the centre)', default: 12, min: -60, max: 100, step: 1, units: 'mm', group: 'Labyrinth' },
    { type: 'slider', id: 'quietTo', label: 'Every brick drawn below (mm below the centre)', default: 48, min: -40, max: 140, step: 1, units: 'mm', group: 'Labyrinth' },
    { type: 'slider', id: 'indication', label: 'Bricks kept where indicated', default: 0.22, min: 0, max: 1, step: 0.01, group: 'Labyrinth' },
    { type: 'slider', id: 'settling', label: 'Last blocks settling', default: 6, min: 0, max: 24, step: 1, group: 'Labyrinth' },
    { type: 'slider', id: 'cornerSize', label: 'Corner marks', default: 9, min: 4, max: 18, step: 0.5, units: 'mm', group: 'Corners' },
    { type: 'slider', id: 'cornerInset', label: 'Corner marks in from the edges', default: 20, min: 10, max: 40, step: 0.5, units: 'mm', group: 'Corners' },
    { type: 'slider', id: 'density', label: 'Line density', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'taper', label: 'Helix wider at the top (times)', default: 30, min: 1, max: 60, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'flare', label: 'Widening held for the top', default: 2.2, min: 1, max: 5, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'pitchGrowth', label: 'Turns stretch as it widens', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixSway', label: 'Helix sway', default: 1, min: -1.5, max: 1.5, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixClear', label: 'Paper round the helix', default: 1.4, min: 0, max: 4, step: 0.1, units: 'mm', group: 'Helix' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'and now it all fits' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawWorld(ctx);
  },
};

export default sketch;
