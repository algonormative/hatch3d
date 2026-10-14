// First: the fit this card prefers on a small card, declared before the format loads.
import './prefers.ts';
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawHierophant } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: V The Hierophant',
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
    { type: 'select', id: 'side', label: 'Which way the wall turns', default: 'seed', options: ['seed', 'left', 'right'],
      optionLabels: { seed: 'By the seed', left: 'Near on the left, gate in the left third', right: 'Near on the right, gate in the right third' }, group: 'Wall' },
    { type: 'slider', id: 'angle', label: 'Wall angle to the picture plane', default: 36, min: 18, max: 60, step: 1, units: '°', group: 'Wall' },
    { type: 'slider', id: 'gateAt', label: 'Gate across the card from the near edge', default: 0.3, min: 0.12, max: 0.4, step: 0.01, group: 'Wall' },
    { type: 'slider', id: 'gateDist', label: 'Gate distance', default: 46, min: 26, max: 80, step: 1, group: 'Wall' },
    { type: 'slider', id: 'endAt', label: 'Far end of the wall across the card', default: 0.86, min: 0.6, max: 1.1, step: 0.01, group: 'Wall' },
    { type: 'slider', id: 'wallH', label: 'Wall height', default: 18, min: 10, max: 40, step: 0.5, group: 'Wall' },
    { type: 'slider', id: 'wallT', label: 'Wall thickness', default: 2.2, min: 1.5, max: 6, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'gateW', label: 'Gate width', default: 3.6, min: 1.6, max: 6, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'pierW', label: 'Pier width', default: 4.2, min: 2, max: 9, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'capH', label: 'Pier height above the wall', default: 2.5, min: 0.5, max: 8, step: 0.1, group: 'Wall' },
    { type: 'slider', id: 'lanes', label: 'Lanes', default: 12, min: 3, max: 16, step: 1, group: 'Lanes' },
    { type: 'slider', id: 'threadHeight', label: 'Thread height at the slot', default: 6.2, min: 3, max: 10, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'threadNear', label: 'Radius at the near end', default: 0.3, min: 0.1, max: 0.8, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'threadThin', label: 'Radius at the pinch', default: 0.022, min: 0.008, max: 0.08, step: 0.001, group: 'Helix' },
    { type: 'slider', id: 'threadParted', label: 'Radius where the strands part in the slot', default: 0.5, min: 0.03, max: 0.8, step: 0.005, group: 'Helix' },
    { type: 'slider', id: 'threadFar', label: 'Radius at the far end', default: 11, min: 2, max: 15, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'slotFlare', label: 'How early the strands part in the slot', default: 0.55, min: 0.3, max: 1.5, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'slotPitch', label: 'Length per turn in the slot', default: 5, min: 2, max: 12, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'climbStart', label: 'Radius where the climb comes out over the wall', default: 0.16, min: 0.05, max: 0.5, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'tipLength', label: 'Length over which each strand comes to a point', default: 10, min: 3, max: 30, step: 0.5, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'endMargin', label: 'Clear margin where the strands end', default: 9, min: 3, max: 20, step: 0.5, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'climbPitch', label: 'Length per turn where it climbs', default: 6, min: 3, max: 30, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'threadFlare', label: 'How late the far end opens', default: 1.3, min: 0.8, max: 4, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'threadPitch', label: 'Length per turn, near piece', default: 5, min: 2, max: 12, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixClear', label: 'Paper round the thread', default: 0.9, min: 0, max: 3, step: 0.05, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'printLine', label: 'Fine print line height', default: 1.6, min: 1.2, max: 1.6, step: 0.05, units: 'mm', group: 'Fine print' },
    { type: 'slider', id: 'printPitch', label: 'Fine print row pitch', default: 2.5, min: 2, max: 3.6, step: 0.1, units: 'mm', group: 'Fine print' },
    { type: 'slider', id: 'print', label: 'Share of paragraphs printed', default: 0.9, min: 0, max: 1, step: 0.05, group: 'Fine print' },
    { type: 'slider', id: 'margin', label: 'Print clearance inside the facet rings', default: 1.2, min: 0.5, max: 6, step: 0.1, units: 'mm', group: 'Fine print' },
    { type: 'select', id: 'accent', label: 'Accent', default: 'ultramarine', options: ['ultramarine', 'vermilion', 'none'],
      optionLabels: { ultramarine: 'Gate in ultramarine', vermilion: 'Gate in vermilion', none: 'No accent (carbon gate)' }, group: 'Look' },
    { type: 'slider', id: 'ringScale', label: 'Facet ring spacing (x the Tower)', default: 1, min: 1, max: 3, step: 0.05, group: 'Look' },
    { type: 'slider', id: 'pierHatch', label: 'Pier hatch spacing at the foot', default: 1.35, min: 0.8, max: 2.5, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'gatePitch', label: 'Gate fill pitch', default: 0.5, min: 0.35, max: 1.2, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 1.4, min: 0.8, max: 5, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'by continuing, you agree' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 1.6 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawHierophant(ctx);
  },
};

export default sketch;
