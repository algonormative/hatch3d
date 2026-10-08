import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawMagician } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: I The Magician',
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
    { type: 'select', id: 'figureStyle', label: 'Figure drawn as', default: 'body', options: ['scratch', 'body'], optionLabels: { scratch: 'A few scratches', body: 'A body, as on the Lovers and the Devil' }, group: 'Figure' },
    { type: 'slider', id: 'figure', label: 'Figure height on the card', default: 40, min: 14, max: 100, step: 1, units: 'mm', group: 'Figure' },
    { type: 'slider', id: 'figureX', label: 'Figure across the card', default: 0, min: -0.3, max: 0.3, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'turn', label: 'Figure turned', default: 8, min: -60, max: 60, step: 1, units: '°', group: 'Figure' },
    { type: 'slider', id: 'pocket', label: 'Clear pocket round it', default: 1.6, min: 1, max: 3, step: 0.05, group: 'Figure' },
    { type: 'slider', id: 'veil', label: 'Fire in front hiding it', default: 0.18, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'field', label: 'Field lines', default: 64, min: 0, max: 140, step: 1, group: 'Power' },
    { type: 'slider', id: 'ribbon', label: 'Ribbon radius', default: 3.4, min: 1, max: 6, step: 0.05, group: 'Power' },
    { type: 'slider', id: 'flare', label: 'Flame width (figure heights)', default: 1.2, min: 0.5, max: 2, step: 0.05, group: 'Power' },
    { type: 'slider', id: 'flame', label: 'Flame height (figure heights)', default: 2.6, min: 1.5, max: 4, step: 0.05, group: 'Power' },
    { type: 'slider', id: 'sweep', label: 'Ribbon sweep', default: 1, min: 0.5, max: 1.6, step: 0.01, group: 'Power' },
    { type: 'slider', id: 'paving', label: 'Paving lifting at its feet', default: 16, min: 0, max: 40, step: 1, group: 'Power' },
    { type: 'slider', id: 'cracks', label: 'Cracks from its feet', default: 7, min: 0, max: 40, step: 1, group: 'Power' },
    { type: 'slider', id: 'blocks', label: 'Floating blocks', default: 44, min: 0, max: 120, step: 1, group: 'Power' },
    { type: 'slider', id: 'infinity', label: 'Lemniscate width', default: 16, min: 10, max: 50, step: 1, units: 'mm', group: 'Mark' },
    { type: 'slider', id: 'infinityLift', label: 'Lemniscate above the head', default: 15, min: 3, max: 40, step: 0.5, group: 'Mark' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'all of it, at once' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawMagician(ctx);
  },
};

export default sketch;
