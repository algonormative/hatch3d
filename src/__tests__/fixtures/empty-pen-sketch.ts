import type { Sketch } from '../../sketch/types.ts';

/** Three pens, the middle one never drawn: what a small card does when a part has nothing to put on that pen. */
const sketch: Sketch = {
  name: 'Empty pen',
  page: { width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' },
  pens: [{ id: 'carbon', color: '#22282c', width: 0.25 }, { id: 'ultramarine', color: '#3c49aa', width: 0.25 }, { id: 'vermilion', color: '#d04b3c', width: 0.25 }],
  controls: [],
  draw: () => [
    { id: 'a-carbon', pen: 'carbon', paths: [[{ x: 10, y: 10 }, { x: 60, y: 30 }], [{ x: 10, y: 40 }, { x: 60, y: 60 }]] },
    { id: 'b-ultramarine', pen: 'ultramarine', paths: [] },
    { id: 'c-vermilion', pen: 'vermilion', paths: [[{ x: 10, y: 80 }, { x: 60, y: 100 }]] },
  ],
};

export default sketch;
