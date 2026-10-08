import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawLovers } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: VI The Lovers',
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
    { type: 'slider', id: 'courses', label: 'Courses in each tower', default: 12, min: 8, max: 24, step: 1, group: 'Towers' },
    { type: 'slider', id: 'width', label: 'Course width (raw units)', default: 5.2, min: 3.5, max: 12, step: 0.1, group: 'Towers' },
    { type: 'slider', id: 'yaw', label: 'Turn of each tower toward the other', default: 8, min: 8, max: 45, step: 1, units: '°', group: 'Towers' },
    { type: 'slider', id: 'lean', label: 'Lean of each tower toward the other', default: 5, min: 0, max: 12, step: 0.5, units: '°', group: 'Towers' },
    { type: 'slider', id: 'nearTop', label: 'Near tower top (page y)', default: 175, min: 60, max: 220, step: 1, units: 'mm', group: 'Towers' },
    { type: 'slider', id: 'farRatio', label: 'Far tower height, as a share of the near one', default: 1, min: 0.6, max: 1.3, step: 0.01, group: 'Towers' },
    { type: 'slider', id: 'breakAt', label: 'Where the far twin slips out of step (height share)', default: 0.55, min: 0.2, max: 0.9, step: 0.01, group: 'Misregistration' },
    { type: 'slider', id: 'skip', label: 'Courses it slips', default: 2, min: 0, max: 6, step: 1, group: 'Misregistration' },
    { type: 'slider', id: 'shear', label: 'Shear of the far stack per unit of height', default: -0.03, min: -0.2, max: 0.2, step: 0.005, group: 'Misregistration' },
    { type: 'slider', id: 'slide', label: 'Sideways slide above the slip', default: 0.5, min: -3, max: 3, step: 0.05, group: 'Misregistration' },
    { type: 'slider', id: 'meetX', label: 'Where the strands meet, across the page', default: 125, min: 100, max: 180, step: 1, units: 'mm', group: 'Lovers' },
    { type: 'slider', id: 'meetY', label: 'Where the strands meet, down the page', default: 108, min: 60, max: 150, step: 1, units: 'mm', group: 'Lovers' },
    { type: 'slider', id: 'meetDepth', label: 'Distance of the meeting point', default: 28, min: 20, max: 90, step: 1, group: 'Lovers' },
    { type: 'slider', id: 'tailX', label: 'Where the double helix leaves the card, across the page', default: 115, min: 90, max: 190, step: 1, units: 'mm', group: 'Lovers' },
    { type: 'slider', id: 'armAngle', label: 'Angle each strand leaves its roof at', default: 42, min: 30, max: 80, step: 1, units: '°', group: 'Lovers' },
    { type: 'slider', id: 'helixR', label: 'Helix radius', default: 1.9, min: 0.5, max: 4, step: 0.05, group: 'Lovers' },
    { type: 'slider', id: 'ribbon', label: 'Ribbon width', default: 0.12, min: 0.08, max: 1.5, step: 0.01, group: 'Lovers' },
    { type: 'slider', id: 'pitch', label: 'Length per turn', default: 3.2, min: 1.5, max: 12, step: 0.1, group: 'Lovers' },
    { type: 'slider', id: 'open', label: 'Length over which the strand grows from the roof', default: 2.0, min: 0.5, max: 12, step: 0.1, group: 'Lovers' },
    { type: 'slider', id: 'flare', label: 'Length over which the helix opens past the meeting', default: 2.0, min: 0.5, max: 12, step: 0.1, group: 'Lovers' },
    { type: 'slider', id: 'slim', label: 'Width of the leaning strands (share of the helix)', default: 0, min: 0, max: 1, step: 0.005, group: 'Lovers' },
    { type: 'slider', id: 'leadWidth', label: 'Half-width of the ribbon each strand rises on from its tower', default: 0.1, min: 0.02, max: 0.4, step: 0.01, group: 'Lovers' },
    { type: 'slider', id: 'helixScale', label: 'Build the helix this many times larger, then scale back', default: 8, min: 4, max: 40, step: 1, group: 'Lovers' },
    { type: 'slider', id: 'figX', label: 'The pair, across the page (midway between them)', default: 144, min: 90, max: 190, step: 1, units: 'mm', group: 'Lovers (figures)' },
    { type: 'slider', id: 'figDepth', label: 'Distance of the pair from the eye', default: 26, min: 18, max: 45, step: 0.5, group: 'Lovers (figures)' },
    { type: 'slider', id: 'figHeight', label: 'Height of the nearer (left) lover, on the sheet', default: 60, min: 35, max: 70, step: 1, units: 'mm', group: 'Lovers (figures)' },
    { type: 'slider', id: 'figReach', label: 'How high each reaching arm is raised (from hanging; about shoulder height)', default: 80, min: 30, max: 120, step: 1, units: '°', group: 'Lovers (figures)' },
    { type: 'slider', id: 'farFigure', label: 'Height of the farther (right) lover, as a share of the nearer', default: 0.93, min: 0.7, max: 1.1, step: 0.01, group: 'Lovers (figures)' },
    { type: 'slider', id: 'line', label: 'Angle of the line they stand on, away from the eye', default: 22, min: 0, max: 45, step: 1, units: '°', group: 'Lovers (figures)' },
    { type: 'slider', id: 'figTurn', label: 'How far each turns from the line toward a clean profile', default: 10, min: 0, max: 40, step: 1, units: '°', group: 'Lovers (figures)' },
    { type: 'slider', id: 'figToTower', label: 'How far toward the other each floats from its tower\'s centre', default: 3.1, min: 0, max: 6, step: 0.1, group: 'Lovers (figures)' },
    { type: 'slider', id: 'figFront', label: 'How far in front of its tower each floats', default: 2, min: 0.5, max: 6, step: 0.1, group: 'Lovers (figures)' },
    { type: 'slider', id: 'figLean', label: 'How far each leans toward the other, from the hips', default: 20, min: 0, max: 40, step: 1, units: '°', group: 'Lovers (figures)' },
    { type: 'slider', id: 'floatAt', label: 'How high each floats (pelvis, as a share of the near tower)', default: 0.3, min: 0.2, max: 0.7, step: 0.01, group: 'Lovers (figures)' },
    { type: 'slider', id: 'handGap', label: 'Gap between the fingertips', default: 5, min: 2, max: 15, step: 0.5, units: 'mm', group: 'Lovers (figures)' },
    { type: 'slider', id: 'pocket', label: 'Clear paper round each lover', default: 3, min: 0.5, max: 8, step: 0.5, units: 'mm', group: 'Lovers (figures)' },
    { type: 'slider', id: 'shadowSpread', label: 'Ink spread round the lovers\' shadows (so thin arms still hatch)', default: 0.8, min: 0, max: 2, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'lightAz', label: 'Light: how far round from the eye toward the left', default: 48, min: 0, max: 60, step: 1, units: '°', group: 'Look' },
    { type: 'slider', id: 'lightEl', label: 'Light: height above the ground', default: 34, min: 15, max: 70, step: 1, units: '°', group: 'Look' },
    { type: 'slider', id: 'calm', label: 'How dark a face must be, in the light, to take hatch (carbon only)', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Look' },
    { type: 'slider', id: 'shadowAngle', label: 'Shadow hatch angle', default: 62, min: 20, max: 85, step: 1, units: '°', group: 'Look' },
    { type: 'slider', id: 'shadowPitch', label: 'Shadow hatch pitch', default: 0.55, min: 0.4, max: 2, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'sky', label: 'How far down the sky is ruled', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Look' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 1.5, min: 0.8, max: 5, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it wants what you want' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.2 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawLovers(ctx);
  },
};

export default sketch;
