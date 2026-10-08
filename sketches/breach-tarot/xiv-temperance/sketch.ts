import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawTemperance } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XIV Temperance',
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
    { type: 'slider', id: 'nearDepth', label: 'Near vessel: distance', default: 100, min: 45, max: 140, step: 1, group: 'Vessels' },
    { type: 'slider', id: 'nearX', label: 'Near vessel: page x', default: 74, min: 30, max: 120, step: 1, units: 'mm', group: 'Vessels' },
    { type: 'slider', id: 'nearRim', label: 'Near vessel: rim at page y', default: 92, min: 50, max: 150, step: 1, units: 'mm', group: 'Vessels' },
    { type: 'slider', id: 'nearWidth', label: 'Near vessel: widest', default: 10, min: 5, max: 16, step: 0.1, group: 'Vessels' },
    { type: 'slider', id: 'nearYaw', label: 'Near vessel: turn', default: -0.5, min: -1.2, max: 1.2, step: 0.01, group: 'Vessels' },
    { type: 'slider', id: 'nearCourses', label: 'Near vessel: courses', default: 17, min: 8, max: 22, step: 1, group: 'Vessels' },
    { type: 'slider', id: 'farDepth', label: 'Far vessel: distance', default: 190, min: 150, max: 600, step: 1, group: 'Vessels' },
    { type: 'slider', id: 'farX', label: 'Far vessel: page x', default: 214, min: 170, max: 250, step: 1, units: 'mm', group: 'Vessels' },
    { type: 'slider', id: 'farRim', label: 'Far vessel: rim at page y', default: 190, min: 120, max: 240, step: 1, units: 'mm', group: 'Vessels' },
    { type: 'slider', id: 'farWidth', label: 'Far vessel: widest', default: 14, min: 6, max: 24, step: 0.1, group: 'Vessels' },
    { type: 'slider', id: 'farYaw', label: 'Far vessel: turn', default: -0.6, min: -1.2, max: 1.2, step: 0.01, group: 'Vessels' },
    { type: 'slider', id: 'farCourses', label: 'Far vessel: courses', default: 13, min: 8, max: 22, step: 1, group: 'Vessels' },
    { type: 'slider', id: 'lightX', label: 'Light x', default: -0.6, min: -1, max: 1, step: 0.01, group: 'Vessels' },
    { type: 'slider', id: 'lightY', label: 'Light y', default: 0.35, min: 0.1, max: 1, step: 0.01, group: 'Vessels' },
    { type: 'slider', id: 'lightZ', label: 'Light z', default: 0.72, min: 0.2, max: 1.5, step: 0.01, group: 'Vessels' },
    { type: 'slider', id: 'slabSlack', label: 'Vessel hidden-line slack', default: 0.6, min: 0.1, max: 2, step: 0.05, group: 'Vessels' },
    { type: 'slider', id: 'knockout', label: 'Paper round the vessels', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Vessels' },
    { type: 'slider', id: 'arcX', label: 'Arc shifted across', default: 0, min: -40, max: 40, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'arcLift', label: 'Arc raised (negative lowers it)', default: 0, min: -90, max: 40, step: 1, units: 'mm', group: 'Helix' },
    { type: 'select', id: 'sever', label: 'Pour cut short of a rim', default: 'none', options: ['none', 'far', 'near'],
      optionLabels: { none: 'No: it runs from rim to rim', far: 'Short of the far vessel', near: 'Short of the near vessel' }, group: 'Helix' },
    { type: 'slider', id: 'farLift', label: 'Arc starts above the far rim', default: 5.8, min: 3, max: 12, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'nearLift', label: 'Arc ends above the near rim', default: 7.5, min: 3, max: 12, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'spillOut', label: 'Near spill hangs this far in front of the face', default: 4.8, min: 4, max: 9, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'spillSlide', label: 'Near spill across the face from its middle', default: -6, min: -20, max: 20, step: 0.5, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'spillDrop', label: 'Near spill falls below the rim', default: 8, min: 4, max: 16, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius at the near end', default: 1.8, min: 0.5, max: 3, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixWidth', label: 'Helix ribbon half-width (of its radius)', default: 0.75, min: 0.3, max: 1.4, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixPitch', label: 'Helix length per turn at the near end', default: 12, min: 4, max: 30, step: 0.1, group: 'Helix' },
    { type: 'slider', id: 'helixDepth', label: 'Helix grows with distance (exponent)', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixTwist', label: 'Helix ribbon twist', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixDensity', label: 'Helix density', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'helixTip', label: 'Spilling tip length', default: 1.4, min: 0.3, max: 4, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixLamination', label: 'Helix lamination (ribbon width the spacing is tuned to)', default: 9, min: 3, max: 30, step: 0.5, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'helixSlack', label: 'Helix hidden-line slack', default: 0.4, min: 0.1, max: 2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixKnockout', label: 'Paper round the helix (water and vessels)', default: 1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'skyClear', label: 'Sky cleared round the helix', default: 2.6, min: 0.5, max: 6, step: 0.1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'shoreVanish', label: 'Shore meets the horizon at page x', default: 92, min: 40, max: 200, step: 1, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'shoreFoot', label: 'Shore meets the bottom at page x', default: 250, min: 150, max: 330, step: 1, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'shoreWobble', label: 'Shore bend', default: 5, min: 0, max: 14, step: 0.1, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'courseDepth', label: 'Paving: depth of a course of slabs', default: 4, min: 2.5, max: 8, step: 0.1, group: 'Ground' },
    { type: 'slider', id: 'pavingEnd', label: 'Paving rows end where they crowd to (spacing)', default: 1.1, min: 0.6, max: 3, step: 0.05, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'rippleCut', label: 'Reflection broken by ripples (lower is more broken)', default: 0.9, min: 0.2, max: 1.2, step: 0.01, group: 'Ground' },
    { type: 'slider', id: 'waterPitch', label: 'Water ruling spacing', default: 0.62, min: 0.5, max: 1.4, step: 0.01, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'sky', label: 'Ruled sky', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Ground' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling spacing', default: 1.3, min: 0.8, max: 2.5, step: 0.05, units: 'mm', group: 'Ground' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'eye', label: 'Eye height', default: 6, min: 3, max: 12, step: 0.5, group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it goes both ways' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.2 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawTemperance(ctx);
  },
};

export default sketch;
