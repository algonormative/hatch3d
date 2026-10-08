import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawFool } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: 0 The Fool',
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
    { type: 'slider', id: 'wander', label: 'Walk leans away from him', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Maze' },
    { type: 'slider', id: 'gridAngle', label: 'Maze turned to the view', default: 45, min: 0, max: 45, step: 1, units: '°', group: 'Maze' },
    { type: 'slider', id: 'depth', label: 'Maze rows', default: 12, min: 6, max: 24, step: 1, group: 'Maze' },
    { type: 'slider', id: 'grow', label: 'Old walls grown tall', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Maze' },
    { type: 'slider', id: 'collapse', label: 'Collapse', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Maze' },
    { type: 'slider', id: 'fray', label: 'Tall walls fraying upward', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Maze' },
    { type: 'slider', id: 'lightAngle', label: 'Light height', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Maze' },
    { type: 'toggle', id: 'sun', label: 'Sun (flat mark)', default: true, group: 'Sky' },
    { type: 'slider', id: 'radiance', label: 'Fine rays', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'sunSize', label: 'Sun radius', default: 18, min: 10, max: 40, step: 1, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'sunInset', label: 'Sun in from the right', default: 0.2, min: 0.08, max: 0.4, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'sunDrop', label: 'Sun down from the top', default: 0.13, min: 0.05, max: 0.3, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'foolX', label: 'Where he stands', default: 0.6, min: 0.3, max: 0.75, step: 0.01, group: 'Fool' },
    { type: 'slider', id: 'lookUp', label: 'Looking up', default: 12, min: 0, max: 40, step: 1, units: '°', group: 'Fool' },
    { type: 'slider', id: 'neck', label: 'Neck out of the collar', default: 1.9, min: 1, max: 2.6, step: 0.05, group: 'Fool' },
    { type: 'slider', id: 'tie', label: 'Tie reach', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Fool' },
    { type: 'slider', id: 'footY', label: 'Feet above the card foot', default: 32, min: 10, max: 80, step: 1, units: 'mm', group: 'Fool' },
    { type: 'slider', id: 'facing', label: 'Turned from the viewer', default: 38, min: 0, max: 90, step: 1, units: '°', group: 'Fool' },
    { type: 'slider', id: 'suit', label: 'Suit size', default: 1.6, min: 1, max: 2.2, step: 0.05, group: 'Fool' },
    { type: 'toggle', id: 'motley', label: 'Harlequin suit', default: false, group: 'Fool' },
    { type: 'slider', id: 'density', label: 'Line density', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Fool' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'nothing here has been decided yet' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawFool(ctx);
  },
};

export default sketch;
