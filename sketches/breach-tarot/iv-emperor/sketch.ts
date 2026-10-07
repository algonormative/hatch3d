import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawEmperor } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: IV The Emperor',
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
    { type: 'select', id: 'reading', label: 'Reading', default: 'agent', options: ['agent', 'empty', 'ziggurat'],
      optionLabels: { agent: 'The Seated Agent: a censored colossus on a cube throne', empty: 'The Empty Suit: the same suit, nobody in it',
        ziggurat: 'The Ziggurat: tiers of ever more, ever smaller blocks; you stand on the bottom one' }, group: 'Reading' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'throneDrop', label: 'End of the avenue below the horizon', default: 64, min: 30, max: 110, step: 1, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'headTop', label: 'Top of the head (or apex) on the card', default: 78, min: 50, max: 140, step: 1, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'cube', label: 'Avenue cube', default: 2.4, min: 1.2, max: 5, step: 0.1, group: 'Avenue' },
    { type: 'slider', id: 'gap', label: 'Gap between cubes (paving stones)', default: 2, min: 1, max: 4, step: 1, group: 'Avenue' },
    { type: 'slider', id: 'cols', label: 'Columns each side', default: 4, min: 1, max: 8, step: 1, group: 'Avenue' },
    { type: 'slider', id: 'groundGap', label: 'Closest paving joints', default: 3.2, min: 1.5, max: 8, step: 0.1, units: 'mm', group: 'Avenue' },
    { type: 'slider', id: 'tiers', label: 'Ziggurat tiers (with the paving)', default: 6, min: 5, max: 7, step: 1, group: 'Ziggurat' },
    { type: 'slider', id: 'topBlock', label: 'Top block (avenue cubes wide)', default: 3.5, min: 2, max: 6, step: 0.1, group: 'Ziggurat' },
    { type: 'slider', id: 'facet', label: 'Facet hatch spacing', default: 12, min: 6, max: 18, step: 0.1, group: 'Hatch' },
    { type: 'slider', id: 'pin', label: 'Pinstripe spacing (darkest)', default: 0.9, min: 0.6, max: 2, step: 0.05, units: 'mm', group: 'Hatch' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Hatch' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling', default: 0.9, min: 0.5, max: 1.5, step: 0.01, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'glow', label: 'Glow round the light', default: 80, min: 0, max: 140, step: 1, units: 'mm', group: 'Sky' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'you are already standing on it' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawEmperor(ctx);
  },
};

export default sketch;
