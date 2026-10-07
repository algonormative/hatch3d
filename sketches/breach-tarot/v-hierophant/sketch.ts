import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawHierophant } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: V The Hierophant',
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
    { type: 'slider', id: 'dist', label: 'Wall distance', default: 70, min: 40, max: 140, step: 1, group: 'Wall' },
    { type: 'slider', id: 'wallH', label: 'Wall height', default: 26, min: 10, max: 40, step: 0.5, group: 'Wall' },
    { type: 'slider', id: 'bay', label: 'Bow of the wings toward the eye', default: 20, min: 0, max: 40, step: 1, units: '°', group: 'Wall' },
    { type: 'slider', id: 'gateW', label: 'Gate width', default: 2.6, min: 1.4, max: 5, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'pierW', label: 'Pier width', default: 4.4, min: 2, max: 9, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'capH', label: 'Pier height above the wall', default: 3, min: 0.5, max: 8, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'lanes', label: 'Lanes', default: 20, min: 4, max: 40, step: 1, group: 'Lanes' },
    { type: 'slider', id: 'fan', label: 'Fan spread past the gate', default: 38, min: 10, max: 120, step: 1, group: 'Lanes' },
    { type: 'slider', id: 'mouth', label: 'Half-width the lanes aim at', default: 3.2, min: 0.5, max: 5, step: 0.1, group: 'Lanes' },
    { type: 'slider', id: 'rowStart', label: 'First paving course', default: 1.5, min: 0.6, max: 4, step: 0.1, units: 'mm', group: 'Lanes' },
    { type: 'slider', id: 'rowGrow', label: 'Course growth toward the eye', default: 1.12, min: 1.03, max: 1.3, step: 0.01, group: 'Lanes' },
    { type: 'slider', id: 'printLine', label: 'Fine print line height', default: 1.6, min: 1.2, max: 1.6, step: 0.05, units: 'mm', group: 'Fine print' },
    { type: 'slider', id: 'printPitch', label: 'Fine print row pitch', default: 2.5, min: 2, max: 3.6, step: 0.1, units: 'mm', group: 'Fine print' },
    { type: 'slider', id: 'print', label: 'Share of paragraphs printed', default: 0.8, min: 0, max: 1, step: 0.05, group: 'Fine print' },
    { type: 'slider', id: 'margin', label: 'Print clearance inside the facet rings', default: 1.2, min: 0.5, max: 6, step: 0.1, units: 'mm', group: 'Fine print' },
    { type: 'select', id: 'accent', label: 'Accent', default: 'ultramarine', options: ['ultramarine', 'vermilion', 'none'],
      optionLabels: { ultramarine: 'Gate in ultramarine', vermilion: 'Gate in vermilion', none: 'No accent (carbon gate)' }, group: 'Look' },
    { type: 'slider', id: 'ringScale', label: 'Facet ring spacing (x the Tower)', default: 1.5, min: 1, max: 3, step: 0.1, group: 'Look' },
    { type: 'slider', id: 'gatePitch', label: 'Gate fill pitch', default: 0.5, min: 0.35, max: 1.2, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 2.2, min: 0.8, max: 5, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'by continuing, you agree' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 1.6 } : c),
  ],
  draw(ctx) {
    return drawHierophant(ctx);
  },
};

export default sketch;
