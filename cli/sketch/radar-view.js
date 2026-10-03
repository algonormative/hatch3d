import { snapSliderValue } from './control-values.js';

const NS = 'http://www.w3.org/2000/svg';
const CENTER = 150;
const RADIUS = 95;

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function point(index, count, fraction) {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
  return [CENTER + Math.cos(angle) * RADIUS * fraction, CENTER + Math.sin(angle) * RADIUS * fraction];
}

/** A second, compact editor for canonical raw slider values. */
export function createRadarNavigator(host, navigator, controls, readValue, onChange, onRelease) {
  const axes = navigator.axes.map(id => controls.find(control => control.id === id));
  const card = document.createElement('section');
  card.className = 'radar-card';
  card.dataset.navigatorId = navigator.id;
  const title = document.createElement('h3');
  title.textContent = navigator.label;
  const help = document.createElement('p');
  help.className = 'radar-help';
  help.textContent = 'Drag a point to shape the sketch. Use arrow keys for exact steps, or the sliders below.';
  const unavailable = document.createElement('p');
  unavailable.className = 'radar-unavailable';
  unavailable.textContent = 'This shape is unavailable while one of its conditional controls is hidden.';
  unavailable.hidden = true;
  const svg = svgElement('svg', { viewBox: '0 0 300 300', class: 'radar-chart', 'aria-label': `${navigator.label} shape controls` });
  const grid = svgElement('g', { class: 'radar-grid', 'aria-hidden': 'true' });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    const polygon = svgElement('polygon', { points: axes.map((_, i) => point(i, axes.length, fraction).join(',')).join(' ') });
    grid.append(polygon);
  }
  for (let index = 0; index < axes.length; index++) {
    const [x, y] = point(index, axes.length, 1);
    grid.append(svgElement('line', { x1: CENTER, y1: CENTER, x2: x, y2: y }));
  }
  const shape = svgElement('polygon', { class: 'radar-shape' });
  svg.append(grid, shape);
  const handles = [];
  const chartLabels = [];
  let active = null;

  function update() {
    shape.setAttribute('points', axes.map((control, index) => {
      const fraction = (Number(readValue(control.id)) - control.min) / (control.max - control.min);
      return point(index, axes.length, fraction).join(',');
    }).join(' '));
    handles.forEach((handle, index) => {
      const control = axes[index];
      const value = Number(readValue(control.id));
      const fraction = (value - control.min) / (control.max - control.min);
      const [x, y] = point(index, axes.length, fraction);
      handle.setAttribute('transform', `translate(${x} ${y})`);
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', `${value}${control.units ? ` ${control.units}` : ''}`);
      chartLabels[index].lastElementChild.textContent = `${value}${control.units ? ` ${control.units}` : ''}`;
    });
  }

  function pointerValue(event, index) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return Number(readValue(axes[index].id));
    const x = (event.clientX - rect.left) * 300 / rect.width - CENTER;
    const y = (event.clientY - rect.top) * 300 / rect.height - CENTER;
    const angle = -Math.PI / 2 + index * 2 * Math.PI / axes.length;
    const fraction = Math.max(0, Math.min(1, (x * Math.cos(angle) + y * Math.sin(angle)) / RADIUS));
    const control = axes[index];
    return snapSliderValue(control, control.min + fraction * (control.max - control.min));
  }

  function finish() {
    if (!active) return;
    const { changed, expensive, pointerId } = active;
    active = null;
    if (svg.hasPointerCapture?.(pointerId)) svg.releasePointerCapture(pointerId);
    if (changed && expensive) onRelease();
  }

  function begin(index, event) {
    if (event.button !== 0 || active) return;
    event.preventDefault();
    const control = axes[index];
    active = { index, pointerId: event.pointerId, changed: false, expensive: Boolean(control.expensive) };
    svg.setPointerCapture?.(event.pointerId);
    move(event);
    handles[index].focus();
  }

  function move(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    const control = axes[active.index];
    const value = pointerValue(event, active.index);
    if (value !== Number(readValue(control.id))) {
      active.changed = true;
      onChange(control.id, value, Boolean(control.expensive));
    }
  }

  const trackLayer = svgElement('g', { class: 'radar-tracks', 'aria-hidden': 'true' });
  axes.forEach((control, index) => {
    const [x, y] = point(index, axes.length, 1);
    const track = svgElement('line', { x1: CENTER, y1: CENTER, x2: x, y2: y, 'data-axis-id': control.id });
    track.addEventListener('pointerdown', event => begin(index, event));
    trackLayer.append(track);
  });
  svg.append(trackLayer);
  axes.forEach((control, index) => {
    const handle = svgElement('g', { class: 'radar-handle', role: 'slider', tabindex: '0', 'data-axis-id': control.id,
      'aria-label': `${navigator.label}: ${control.label}`, 'aria-valuemin': control.min, 'aria-valuemax': control.max });
    handle.append(svgElement('circle', { class: 'radar-hit', r: 14 }), svgElement('circle', { class: 'radar-dot', r: 5 }));
    handle.addEventListener('pointerdown', event => begin(index, event));
    handle.addEventListener('keydown', event => {
      let proposed;
      const current = Number(readValue(control.id));
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') proposed = current + control.step;
      else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') proposed = current - control.step;
      else if (event.key === 'Home') proposed = control.min;
      else if (event.key === 'End') proposed = control.max;
      else return;
      event.preventDefault();
      const value = snapSliderValue(control, proposed);
      if (value !== current) {
        onChange(control.id, value, Boolean(control.expensive));
        if (control.expensive) onRelease();
      }
    });
    handles.push(handle);
    svg.append(handle);
  });
  axes.forEach((control, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / axes.length;
    const x = Math.max(14, Math.min(286, CENTER + Math.cos(angle) * 124));
    const y = Math.max(18, Math.min(274, CENTER + Math.sin(angle) * 124));
    const anchor = x < 130 ? 'start' : x > 170 ? 'end' : 'middle';
    const label = svgElement('text', { class: 'radar-chart-label', x, y, 'text-anchor': anchor, 'data-axis-label': control.id });
    const name = svgElement('tspan', { x, dy: 0 });
    const maxLabel = axes.length >= 6 ? 10 : 18;
    name.textContent = control.label.length > maxLabel ? `${control.label.slice(0, maxLabel - 1)}…` : control.label;
    const value = svgElement('tspan', { x, dy: 14, class: 'radar-chart-value' });
    const title = svgElement('title');
    title.textContent = control.label;
    label.append(title, name, value);
    label.addEventListener('click', () => handles[index].focus());
    chartLabels.push(label);
    svg.append(label);
  });
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', event => { if (active?.pointerId === event.pointerId) finish(); });
  svg.addEventListener('pointercancel', event => { if (active?.pointerId === event.pointerId) finish(); });
  svg.addEventListener('lostpointercapture', event => { if (active?.pointerId === event.pointerId) finish(); });
  const labels = document.createElement('div');
  labels.className = 'radar-axis-labels';
  axes.forEach((control, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'radar-axis-label';
    button.textContent = control.label;
    button.title = `Focus ${control.label} radar handle`;
    button.addEventListener('click', () => handles[index].focus());
    labels.append(button);
  });
  card.append(title, help, unavailable, svg, labels);
  host.append(card);
  update();
  return {
    update,
    setAvailable(available) {
      if (!available) finish();
      svg.toggleAttribute('hidden', !available);
      labels.hidden = !available;
      unavailable.hidden = available;
    },
    focusAxis(id) {
      const index = axes.findIndex(control => control.id === id);
      if (index < 0 || svg.hasAttribute('hidden')) return false;
      handles[index].focus();
      return true;
    },
    release: finish,
  };
}
