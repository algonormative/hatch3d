import type { Sketch } from '../../src/sketch/types.ts';
import base from '../breach-cathedral/sketch.ts';
import { LETTERING_PEN, sloganControls, titleControls } from '../breach-cathedral-tower/slogan.ts';

/**
 * The original Breach Cathedral with opt-in full height, whole-structure fitting and spread slogans.
 * A separate entry so the original sketch's controls and render identity stay exactly as published.
 */
const sketch: Sketch = {
  ...base,
  name: 'Breach Cathedral (extended)',
  pens: [...base.pens, LETTERING_PEN],
  controls: [
    ...base.controls,
    { type: 'toggle', id: 'fullHeight', label: 'Full height (no envelope cut)', default: false, group: 'Placement' },
    { type: 'toggle', id: 'fitWhole', label: 'Fit whole structure', default: false, group: 'Placement', showWhen: { control: 'fullHeight', equals: true } },
    ...sloganControls(0),
    ...titleControls(),
  ],
};

export default sketch;
