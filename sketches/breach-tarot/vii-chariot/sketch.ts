// First: the fit this card prefers on a small card, declared before the format loads.
import './prefers.ts';
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawChariot } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: VII The Chariot',
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
    { type: 'slider', id: 'vanishX', label: 'Road vanishes at page x', default: 60, min: 18, max: 130, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'liftX', label: 'Lift-off at page x', default: 100, min: 40, max: 200, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'liftY', label: 'Lift-off at page y', default: 312, min: 262, max: 330, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'liftLean', label: 'Road lean at the lift-off (x per unit of depth)', default: -1.6, min: -4, max: 0.5, step: 0.01, group: 'Road' },
    { type: 'slider', id: 'liftEase', label: 'Lean eases to the vanishing point over (depth)', default: 20, min: 3, max: 80, step: 1, group: 'Road' },
    { type: 'slider', id: 'endX', label: 'Front edge at page x', default: 170, min: 110, max: 245, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'endY', label: 'Front edge at page y', default: 160, min: 80, max: 210, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'endT', label: 'Front edge depth', default: 38, min: 22, max: 90, step: 0.5, group: 'Road' },
    { type: 'slider', id: 'endHeading', label: 'Heading at the front edge (0 toward us, 90 right)', default: 45, min: -80, max: 100, step: 1, units: '°', group: 'Road' },
    { type: 'slider', id: 'endClimb', label: 'Climb at the front edge', default: 40, min: 0, max: 70, step: 1, units: '°', group: 'Road' },
    { type: 'slider', id: 'rampSweep', label: 'Ramp sweep', default: 0.5, min: 0.1, max: 0.9, step: 0.01, group: 'Road' },
    { type: 'slider', id: 'bankLead', label: 'Bank starts before the lift-off by', default: 0, min: 0, max: 20, step: 0.5, group: 'Road' },
    { type: 'slider', id: 'bankOver', label: 'Bank comes on over (share of the ramp)', default: 0.5, min: 0.05, max: 1, step: 0.01, group: 'Road' },
    { type: 'slider', id: 'bank', label: 'Bank toward the eye', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Road' },
    { type: 'slider', id: 'contX', label: 'Unbuilt road heads for page x', default: 110, min: 30, max: 330, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'contY', label: 'Unbuilt road heads for page y', default: 40, min: -120, max: 200, step: 1, units: 'mm', group: 'Road' },
    { type: 'slider', id: 'contT', label: 'Unbuilt road heads for depth', default: 60, min: 10, max: 120, step: 0.5, group: 'Road' },
    { type: 'slider', id: 'unbuiltRows', label: 'Rows of road not yet laid', default: 6, min: 2, max: 12, step: 1, group: 'Road' },
    { type: 'slider', id: 'contHeading', label: 'Unbuilt road arrives heading (0 toward us, 90 right)', default: -130, min: -270, max: 270, step: 1, units: '°', group: 'Road' },
    { type: 'slider', id: 'contClimb', label: 'Unbuilt road arrives climbing', default: 10, min: -60, max: 80, step: 1, units: '°', group: 'Road' },
    { type: 'slider', id: 'kneeTurn', label: 'Most a slab turns at the knee', default: 20, min: 5, max: 90, step: 1, units: '°', group: 'Road' },
    { type: 'slider', id: 'laneW', label: 'Lane width', default: 2.6, min: 1.2, max: 5, step: 0.05, group: 'Road' },
    { type: 'slider', id: 'thick', label: 'Slab thickness', default: 0.4, min: 0.15, max: 0.8, step: 0.01, group: 'Road' },
    { type: 'slider', id: 'row', label: 'Row length', default: 1.6, min: 0.8, max: 4, step: 0.05, group: 'Road' },
    { type: 'slider', id: 'flyers', label: 'Slabs in flight (dark first, then pale)', default: 4, min: 2, max: 6, step: 1, group: 'Flight' },
    { type: 'slider', id: 'tumble', label: 'Tumble in flight', default: 0.9, min: 0, max: 3, step: 0.05, group: 'Flight' },
    { type: 'slider', id: 'arc', label: 'Height of the arcs', default: 5, min: 0, max: 20, step: 0.1, group: 'Flight' },
    { type: 'slider', id: 'askew', label: 'Skew of the landed slabs', default: 1, min: 0, max: 2, step: 0.05, group: 'Flight' },
    { type: 'slider', id: 'lightAzimuth', label: 'Light from the side (+ right)', default: -5, min: -70, max: 70, step: 1, units: '°', group: 'Ink' },
    { type: 'slider', id: 'lightElevation', label: 'Light elevation', default: 28, min: 10, max: 70, step: 1, units: '°', group: 'Ink' },
    { type: 'slider', id: 'shadowPitch', label: 'Shadow hatch spacing', default: 0.7, min: 0.5, max: 3, step: 0.05, units: 'mm', group: 'Ink' },
    { type: 'slider', id: 'darkTone', label: 'Dark slabs: tone', default: 0.9, min: 0.2, max: 1.5, step: 0.05, group: 'Ink' },
    { type: 'slider', id: 'darkPitch', label: 'Dark slabs: hatch spacing', default: 12, min: 6, max: 30, step: 0.5, group: 'Ink' },
    { type: 'slider', id: 'hatch', label: 'Hatch spacing (more is lighter)', default: 1, min: 0.6, max: 3, step: 0.05, group: 'Ink' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Ink' },
    { type: 'slider', id: 'sky', label: 'Ruled sky', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Ink' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius at the head', default: 1.1, min: 0.3, max: 3, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixPitch', label: 'Helix length per turn below the head', default: 12, min: 8, max: 200, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixWidth', label: 'Helix ribbon half-width (times its radius)', default: 0.65, min: 0.2, max: 2, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixTwist', label: 'Helix ribbon twist', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixStart', label: 'Strands at the head, off the road normal', default: 20, min: -180, max: 180, step: 5, units: '°', group: 'Helix' },
    { type: 'slider', id: 'helixFlat', label: 'Helix pressed flat toward the road (1 is round)', default: 0.45, min: 0.15, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixLamination', label: 'Helix lamination spacing (the depth it is tuned to)', default: 52, min: 20, max: 200, step: 1, group: 'Helix' },
    { type: 'slider', id: 'helixHead', label: 'Helix head swelling', default: 0.65, min: 0, max: 2, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixHeadLength', label: 'Helix head length', default: 10, min: 2, max: 40, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixEase', label: 'Helix eased round the knee over', default: 8, min: 0, max: 15, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixHold', label: 'Helix pitch held long over the head (times)', default: 3.5, min: 0, max: 6, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'helixHoldLength', label: 'Over the first (units below the head)', default: 3, min: 1, max: 40, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixTailStretch', label: 'Helix pitch stretched along the ground (times)', default: 6, min: 0, max: 20, step: 0.5, group: 'Helix' },
    { type: 'slider', id: 'helixTaper', label: 'Helix width at its tail (of the head)', default: 0.12, min: 0.01, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixReach', label: 'Helix tail depth', default: 100, min: 80, max: 330, step: 10, group: 'Helix' },
    { type: 'slider', id: 'helixLift', label: 'Helix clearance over the road', default: 0.3, min: 0.05, max: 2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'eye', label: 'Eye height', default: 6, min: 3, max: 12, step: 0.5, group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'the road is still being built' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawChariot(ctx);
  },
};

export default sketch;
