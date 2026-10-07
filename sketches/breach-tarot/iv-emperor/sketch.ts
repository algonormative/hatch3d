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
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'baseDrop', label: 'Foot of the plinth below the horizon', default: 10, min: 3, max: 40, step: 0.5, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'throneX', label: 'Throne right of centre', default: 46, min: 0, max: 100, step: 1, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'headTop', label: 'Top of the head on the card', default: 80, min: 50, max: 140, step: 1, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'turn', label: 'Turned toward the viewer\'s left', default: 36, min: 0, max: 60, step: 1, units: '°', group: 'Figure' },
    { type: 'slider', id: 'density', label: 'Suit line density', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'figureSlack', label: 'Figure hidden-line slack (of its scale)', default: 0.45, min: 0.05, max: 2, step: 0.05, group: 'Figure' },
    { type: 'slider', id: 'censorAngle', label: 'Censor bar off true', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'value', label: 'Value far from the head', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'glow', label: 'Reach of the head\'s light', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'impression', label: 'Breakup of the value', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'skyGlow', label: 'Sky opening round the head', default: 95, min: 0, max: 160, step: 1, units: 'mm', group: 'Light' },
    { type: 'slider', id: 'cube', label: 'Avenue cube (eye height 6)', default: 2.5, min: 1, max: 6, step: 0.1, group: 'Avenue' },
    { type: 'slider', id: 'gap', label: 'Gap between cubes (paving stones)', default: 2, min: 1, max: 4, step: 1, group: 'Avenue' },
    { type: 'slider', id: 'lane', label: 'Lane half-width (eye height 6)', default: 4, min: 1, max: 20, step: 0.5, group: 'Avenue' },
    { type: 'slider', id: 'cols', label: 'Columns each side', default: 3, min: 1, max: 8, step: 1, group: 'Avenue' },
    { type: 'slider', id: 'groundGap', label: 'Closest paving joints', default: 3.2, min: 1.5, max: 8, step: 0.1, units: 'mm', group: 'Avenue' },
    { type: 'slider', id: 'avenueTone', label: 'Avenue hatch loudness', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Hatch' },
    { type: 'slider', id: 'avenueFacet', label: 'Avenue facet hatch spacing', default: 22, min: 6, max: 40, step: 0.5, group: 'Hatch' },
    { type: 'slider', id: 'outlineBelow', label: 'Cubes only outlined below', default: 5, min: 0, max: 20, step: 0.5, units: 'mm', group: 'Hatch' },
    { type: 'slider', id: 'facet', label: 'Facet hatch spacing', default: 12, min: 6, max: 18, step: 0.1, group: 'Hatch' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Hatch' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling', default: 0.9, min: 0.5, max: 1.5, step: 0.01, units: 'mm', group: 'Hatch' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'you are already standing on it' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawEmperor(ctx);
  },
};

export default sketch;
