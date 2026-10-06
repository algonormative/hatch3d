import { mountControlPanel } from '@hatch3d/plot-core/controls';

const controls = [
  { type: 'slider', id: 'x', label: 'Horizontal', min: -100, max: 100, step: 5, default: 0, group: 'Placement' },
  { type: 'slider', id: 'y', label: 'Vertical', min: -60, max: 60, step: 5, default: 0, group: 'Placement' },
  { type: 'slider', id: 'rings', label: 'Contours', min: 2, max: 24, step: 1, default: 10, group: 'Shape', expensive: true },
  { type: 'toggle', id: 'accent', label: 'Draw accent', default: true, group: 'Shape' },
  { type: 'select', id: 'ink', label: 'Ink', default: 'sepia', options: ['sepia', 'blue'], group: 'Shape' },
  { type: 'text', id: 'caption', label: 'Caption', default: 'Contour', maxLength: 24, group: 'Shape' },
];
const navigators = [{ type: 'xy', id: 'position', label: 'Position', axes: ['x', 'y'], yDirection: 'down' }];
let params = Object.fromEntries(controls.map(control => [control.id, control.default]));
const art = document.querySelector('#art');
const status = document.querySelector('#status');

function draw() {
  const ink = params.ink === 'blue' ? '#254861' : '#805236';
  const paths = [];
  for (let ring = 0; ring < params.rings; ring++) {
    const radius = 16 + ring * 5;
    paths.push(`<ellipse cx="${150 + params.x}" cy="${150 + params.y}" rx="${radius}" ry="${radius * .65}" fill="none" stroke="${ink}" stroke-width=".8"/>`);
  }
  if (params.accent) paths.push(`<line x1="30" y1="270" x2="270" y2="270" stroke="${ink}" stroke-width="1.2"/>`);
  art.innerHTML = paths.join('');
  art.setAttribute('aria-label', `${params.caption} with ${params.rings} contours`);
  status.textContent = `${params.caption} · ${params.rings} contours`;
}

const panel = mountControlPanel({
  controlsHost: document.querySelector('#controls'),
  navigatorsHost: document.querySelector('#navigators'),
  controls, navigators, params,
  resetFocus: document.querySelector('#reset'),
  onChange(patch, { expensive }) {
    params = { ...params, ...patch };
    if (!expensive) draw();
    else status.textContent = 'Release to redraw';
  },
  onCommit: draw,
});
document.querySelector('#reset').addEventListener('click', () => panel.reset());
draw();
