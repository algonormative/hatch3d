import type { Sketch } from '../../sketch/types.ts';

/** A diagonal whose slope and weight follow two controls, so a sweep's cells visibly differ. */
const sketch: Sketch = {
  name: 'Sweep fixture',
  page: { width: 60, height: 40, margin: 4, paper: '#f4f0e6' },
  pens: [{ id: 'ink', color: '#22282c', width: 0.3 }],
  controls: [
    { type: 'slider', id: 'tilt', label: 'Tilt', default: 10, min: 0, max: 40, step: 1 },
    { type: 'slider', id: 'rows', label: 'Rows', default: 2, min: 1, max: 6, step: 1 },
  ],
  draw: ({ params }) => {
    const tilt = Number(params.tilt), rows = Number(params.rows);
    return [{ id: 'lines', pen: 'ink', paths: Array.from({ length: rows }, (_, i) => [{ x: 8, y: 10 + i * 6 }, { x: 52, y: 10 + i * 6 + tilt / 2 }]) }];
  },
};

export default sketch;
