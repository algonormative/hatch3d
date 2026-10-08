import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawHermit } from './geometry.ts';

const slider = (id: string, label: string, def: number, min: number, max: number, step: number, group: string, units?: string): Control =>
  ({ type: 'slider', id, label, default: def, min, max, step, group, ...(units ? { units } : {}) });

const sketch: Sketch = {
  name: 'Breach Tarot: IX The Hermit',
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
    slider('summitX', 'Summit across the card (page x)', 192, 120, 235, 1, 'Peak', 'mm'),
    slider('summitY', 'Summit height on the card (page y)', 136, 100, 170, 1, 'Peak', 'mm'),
    slider('turn', 'Turn of the ridge into the picture', 30, 0, 60, 1, 'Peak', '°'),
    slider('peakDistance', 'Distance to the summit', 250, 150, 450, 5, 'Peak', 'u'),
    slider('ridge', 'Length of the long stair to the left', 108, 40, 220, 1, 'Peak', 'u'),
    slider('breadth', 'Breadth of the ridge', 27, 14, 70, 1, 'Peak', 'u'),
    slider('terraceFrom', 'First column with a terrace in front of the spine', 0, 0, 6, 1, 'Peak'),
    slider('profile', 'How the stair falls (1 = straight, higher = convex crest)', 1.1, 0.8, 2.4, 0.05, 'Peak'),
    slider('dip', 'Dip of the slabs along the ridge', 16, 0, 25, 0.5, 'Peak', '°'),
    slider('slabWidth', 'Slab length along the ridge', 11, 8, 28, 0.5, 'Peak', 'u'),
    slider('slabHeight', 'Slab course height', 4.6, 3, 10, 0.1, 'Peak', 'u'),
    slider('variety', 'How far the seed moves the layout', 1, 0, 2, 0.05, 'Peak'),
    slider('figure', 'Hermit height', 33, 22, 40, 0.5, 'Hermit', 'mm'),
    slider('yaw', 'Turn of the hermit (0 faces the eye, negative looks left)', -60, -110, -20, 1, 'Hermit', '°'),
    slider('stoop', 'Stoop', 9, 0, 25, 1, 'Hermit', '°'),
    slider('raise', 'How high the lantern arm is raised', 118, 70, 160, 1, 'Hermit', '°'),
    slider('cloakLength', 'Cloak length', 0.95, 0.5, 1.1, 0.01, 'Hermit'),
    slider('cloakOpen', 'Cloak opening at the hem', 1.2, 0, 2, 0.05, 'Hermit'),
    slider('staffAhead', 'Staff planted ahead of the hand (of the height)', 0.04, -0.1, 0.2, 0.005, 'Hermit'),
    slider('pocket', 'Paper round the hermit and lantern', 1.3, 0.3, 3, 0.05, 'Hermit', 'mm'),
    slider('figureSlack', 'Hidden-line slack on the hermit', 1.2, 0.1, 3, 0.05, 'Hermit'),
    slider('lantern', 'Lantern height', 18, 6, 24, 0.5, 'Lantern', 'mm'),
    slider('coilTurns', 'Turns of the helix in the lantern', 2.5, 1.5, 6, 0.1, 'Lantern'),
    slider('helixScale', 'How many times larger the helix is built, then scaled back', 24, 4, 60, 1, 'Lantern'),
    slider('coilWidth', 'Ribbon width (of the lantern height)', 0.1, 0.04, 0.2, 0.005, 'Lantern'),
    slider('coilDensity', 'Lamination density in the helix', 0, 0, 1, 0.05, 'Lantern'),
    slider('coilRests', 'How much of the helix rests (thinner lamination)', 0, 0, 1, 0.05, 'Lantern'),
    slider('coilThin', 'Keep one in this many laminations and ribs', 6, 1, 12, 1, 'Lantern'),
    slider('coilRadius', 'Helix radius (of the lantern height)', 0.1, 0.03, 0.15, 0.005, 'Lantern'),
    slider('lanternSlack', 'Hidden-line slack on the lantern', 0.15, 0.03, 1, 0.01, 'Lantern'),
    slider('lit', 'Clear core round the lantern', 16, 8, 40, 0.5, 'Night', 'mm'),
    slider('glow', 'Width of the falloff where the ruling thins', 26, 8, 60, 0.5, 'Night', 'mm'),
    slider('night', 'Depth of the night at the top', 1, 0.3, 1.4, 0.01, 'Night'),
    slider('nightPitch', 'Ruling pitch at full darkness', 0.65, 0.5, 1.4, 0.05, 'Night', 'mm'),
    slider('slope', 'Angle of the ruling on the mountain', -38, -80, -5, 1, 'Night', '°'),
    slider('peakRule', 'Darkness of the ruling on the mountain', 0.42, 0.2, 1, 0.01, 'Night'),
    slider('knockout', 'Paper round what stands', 0.8, 0.2, 2, 0.05, 'Night', 'mm'),
    slider('slabSlack', 'Hidden-line slack on the slabs', 0.6, 0.1, 2, 0.05, 'Night'),
    slider('gridPitch', 'Rule spacing at the horizon', 0.75, 0.5, 1.5, 0.01, 'Network', 'mm'),
    slider('gridGrow', 'How fast the rows open toward the eye', 22, 8, 80, 1, 'Network', 'mm'),
    slider('gridLot', 'Size of a lot on the ground', 3.5, 2, 20, 0.5, 'Network', 'u'),
    slider('gridFill', 'Share of lots lit', 0.9, 0.2, 1, 0.01, 'Network'),
    slider('fov', 'Field of view', 54, 40, 75, 1, 'Camera', '°'),
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'there is no signal up here' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawHermit(ctx);
  },
};

export default sketch;
