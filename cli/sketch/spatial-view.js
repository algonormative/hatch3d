import { snapSliderValue } from './control-values.js';
import { CUBE_EDGES, CUBE_VERTICES, cubeEdgeOpacity, denormalizeXY, normalizeXY, projectCubePoint,
  solveCubePlaneDelta } from './control-geometry.js';
import { formatSliderValue, pointerSession, sliderKeyValue, svgElement, svgPoint } from './svg-controls.js';

const SIZE = 300;
const PAD_MIN = 40;
const PAD_SPAN = 220;
const CUBE_THETA = 0.68;
const CUBE_PHI = 0.58;
const CUBE_SCALE = SIZE * 0.28;
const AXIS_KEYS = ['x', 'y', 'z'];

function buildCard(host, navigator, helpText, chartClass) {
  const card = document.createElement('section');
  card.className = 'spatial-card';
  card.dataset.navigatorId = navigator.id;
  const title = document.createElement('h3');
  title.textContent = navigator.label;
  const help = document.createElement('p');
  help.className = 'spatial-help';
  help.textContent = helpText;
  const unavailable = document.createElement('p');
  unavailable.className = 'spatial-unavailable';
  unavailable.textContent = 'This map is unavailable while one of its conditional controls is hidden.';
  unavailable.hidden = true;
  const svg = svgElement('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: `spatial-chart ${chartClass}`,
    'aria-label': `${navigator.label} position controls` });
  card.append(title, help, unavailable, svg);
  host.append(card);
  return { card, svg, unavailable };
}

function buildFocusButtons(card, axes, labels, handles) {
  const buttons = document.createElement('div');
  buttons.className = 'spatial-axis-labels';
  axes.forEach((control, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'spatial-axis-label';
    button.textContent = `${labels[index]} · ${control.label}`;
    button.title = `Focus ${control.label} position handle`;
    button.addEventListener('click', () => handles[index].focus());
    buttons.append(button);
  });
  card.append(buttons);
  return buttons;
}

function axisSlider(svg, navigator, control, label, onKey) {
  const handle = svgElement('g', { class: 'spatial-handle', role: 'slider', tabindex: '0',
    'data-axis-id': control.id, 'data-navigator-id': navigator.id,
    'aria-label': `${navigator.label}: ${label} · ${control.label}`, 'aria-valuemin': control.min,
    'aria-valuemax': control.max });
  handle.append(svgElement('circle', { class: 'spatial-hit', r: 15 }),
    svgElement('circle', { class: 'spatial-axis-dot', r: 6 }));
  handle.addEventListener('keydown', onKey);
  svg.append(handle);
  return handle;
}

function applyPatch(axes, patch, readValue, onChange, active) {
  const changed = {};
  let expensive = false;
  for (const control of axes) {
    if (Object.hasOwn(patch, control.id) && patch[control.id] !== Number(readValue(control.id))) {
      changed[control.id] = patch[control.id];
      expensive ||= Boolean(control.expensive);
    }
  }
  if (!Object.keys(changed).length) return false;
  if (active) {
    active.changed = true;
    active.expensive ||= expensive;
  }
  onChange(changed, active?.gestureExpensive || expensive);
  return true;
}

function keyHandler(control, readValue, onChange, onRelease) {
  return event => {
    const current = Number(readValue(control.id));
    const value = sliderKeyValue(control, current, event.key);
    if (value === null) return;
    event.preventDefault();
    if (value === current) return;
    onChange({ [control.id]: value }, Boolean(control.expensive));
    if (control.expensive) onRelease();
  };
}

function viewActions(card, svg, unavailable, buttons, pointer, update, handles, axes) {
  return {
    update,
    setAvailable(available) {
      if (!available) pointer.release();
      card.hidden = !available;
      svg.toggleAttribute('hidden', !available);
      buttons.hidden = !available;
      unavailable.hidden = available;
    },
    focusAxis(id) {
      const index = axes.findIndex(control => control.id === id);
      if (index < 0 || svg.hasAttribute('hidden')) return false;
      handles[index].focus();
      return true;
    },
    release: pointer.release,
    cancel: pointer.cancel,
    dispose: pointer.dispose,
  };
}

/** Two independent slider ranges share a position dot, with a directional Y map. */
export function createXYNavigator(host, navigator, controls, readValue, onChange, onRelease) {
  const axes = navigator.axes.map(id => controls.find(control => control.id === id));
  const labels = navigator.axisLabels || ['X', 'Y'];
  const { card, svg, unavailable } = buildCard(host, navigator,
    'Drag the dot to set both values. Use the axis handles or sliders below for exact steps.', 'xy-chart');
  const frame = svgElement('rect', { x: PAD_MIN, y: PAD_MIN, width: PAD_SPAN, height: PAD_SPAN, class: 'xy-frame' });
  const midX = svgElement('line', { x1: 150, x2: 150, y1: PAD_MIN, y2: PAD_MIN + PAD_SPAN, class: 'xy-midline' });
  const midY = svgElement('line', { x1: PAD_MIN, x2: PAD_MIN + PAD_SPAN, y1: 150, y2: 150, class: 'xy-midline' });
  const xCross = svgElement('line', { y1: PAD_MIN, y2: PAD_MIN + PAD_SPAN, class: 'xy-crosshair' });
  const yCross = svgElement('line', { x1: PAD_MIN, x2: PAD_MIN + PAD_SPAN, class: 'xy-crosshair' });
  const hit = svgElement('rect', { x: PAD_MIN, y: PAD_MIN, width: PAD_SPAN, height: PAD_SPAN, class: 'xy-hit',
    'data-drag-plane': 'xy' });
  const dot = svgElement('circle', { r: 7, class: 'xy-position-dot', 'data-drag-plane': 'xy' });
  svg.append(frame, midX, midY, xCross, yCross, hit, dot);
  const handles = axes.map((control, index) => axisSlider(svg, navigator, control, labels[index],
    keyHandler(control, readValue, onChange, onRelease)));
  const readouts = axes.map((control, index) => {
    const text = svgElement('text', { x: index === 0 ? 52 : 248, y: 27,
      'text-anchor': index === 0 ? 'start' : 'end', class: 'spatial-readout', 'data-axis-label': control.id });
    text.textContent = labels[index];
    svg.append(text);
    return text;
  });
  const pointer = pointerSession(svg, (event, active) => {
    const position = svgPoint(svg, event, SIZE, SIZE);
    if (!position) return;
    const nx = Math.max(0, Math.min(1, (position.x - PAD_MIN) / PAD_SPAN));
    const ny = Math.max(0, Math.min(1, (position.y - PAD_MIN) / PAD_SPAN));
    const values = denormalizeXY(nx, ny, axes[0].min, axes[0].max, axes[1].min, axes[1].max,
      navigator.yDirection || 'up');
    const patch = {};
    if (active.mode !== 'y') patch[axes[0].id] = snapSliderValue(axes[0], values.x);
    if (active.mode !== 'x') patch[axes[1].id] = snapSliderValue(axes[1], values.y);
    applyPatch(axes, patch, readValue, onChange, active);
  }, active => { if (active.changed && active.expensive) onRelease(); });
  const xyExpensive = axes.some(control => control.expensive);
  hit.addEventListener('pointerdown', event => pointer.begin(event, { mode: 'both', expensive: xyExpensive,
    gestureExpensive: xyExpensive }));
  dot.addEventListener('pointerdown', event => pointer.begin(event, { mode: 'both', expensive: xyExpensive,
    gestureExpensive: xyExpensive }));
  handles.forEach((handle, index) => handle.addEventListener('pointerdown', event => {
    const expensive = Boolean(axes[index].expensive);
    if (pointer.begin(event, { mode: index === 0 ? 'x' : 'y', expensive, gestureExpensive: expensive })) handle.focus();
  }));
  function update() {
    const x = Number(readValue(axes[0].id));
    const y = Number(readValue(axes[1].id));
    const normalized = normalizeXY(x, y, axes[0].min, axes[0].max, axes[1].min, axes[1].max,
      navigator.yDirection || 'up');
    const px = PAD_MIN + normalized.x * PAD_SPAN;
    const py = PAD_MIN + normalized.y * PAD_SPAN;
    xCross.setAttribute('x1', String(px));
    xCross.setAttribute('x2', String(px));
    yCross.setAttribute('y1', String(py));
    yCross.setAttribute('y2', String(py));
    dot.setAttribute('cx', String(px));
    dot.setAttribute('cy', String(py));
    handles[0].setAttribute('transform', `translate(${px} 271)`);
    handles[1].setAttribute('transform', `translate(29 ${py})`);
    axes.forEach((control, index) => {
      const value = index ? y : x;
      handles[index].setAttribute('aria-valuenow', String(value));
      handles[index].setAttribute('aria-valuetext', formatSliderValue(control, value));
      readouts[index].textContent = `${labels[index]} ${formatSliderValue(control, value)}`;
    });
  }
  const buttons = buildFocusButtons(card, axes, labels, handles);
  update();
  return viewActions(card, svg, unavailable, buttons, pointer, update, handles, axes);
}

function position(axes, readValue) {
  return axes.map(control => 2 * (Number(readValue(control.id)) - control.min) / (control.max - control.min) - 1);
}

/** Fixed isometric cube; handles edit normalized base X/Y/Z values, not the orbit camera. */
export function createXYZNavigator(host, navigator, controls, readValue, onChange, onRelease) {
  const axes = navigator.axes.map(id => controls.find(control => control.id === id));
  const labels = navigator.axisLabels || ['X', 'Y', 'Z'];
  const { card, svg, unavailable } = buildCard(host, navigator,
    'Base position in each slider range. Drag a round axis handle for one value or a diamond for a two-axis plane.',
    'xyz-chart');
  const edgeLayer = svgElement('g', { class: 'xyz-edges', 'aria-hidden': 'true' });
  const vertices = CUBE_VERTICES.map(([x, y, z]) => projectCubePoint(x, y, z, CUBE_THETA, CUBE_PHI, SIZE));
  CUBE_EDGES.forEach(([a, b]) => {
    edgeLayer.append(svgElement('line', { x1: vertices[a].x, y1: vertices[a].y,
      x2: vertices[b].x, y2: vertices[b].y, opacity: cubeEdgeOpacity((vertices[a].z + vertices[b].z) / 2) }));
  });
  svg.append(edgeLayer);
  const positionDot = svgElement('circle', { r: 8, class: 'xyz-position-dot', 'aria-hidden': 'true' });
  svg.append(positionDot);
  const handles = axes.map((control, index) => axisSlider(svg, navigator, control, labels[index],
    keyHandler(control, readValue, onChange, onRelease)));
  handles.forEach((handle, index) => {
    handle.setAttribute('transform', `translate(27 ${75 + index * 75})`);
  });
  const planes = [[0, 1], [0, 2], [1, 2]];
  const planeHandles = planes.map(([a, b]) => {
    const handle = svgElement('g', { class: 'xyz-plane-handle', 'data-plane': `${labels[a]}${labels[b]}`,
      'aria-label': `${navigator.label}: drag ${labels[a]} / ${labels[b]} plane` });
    handle.append(svgElement('circle', { class: 'xyz-plane-hit', r: 16 }),
      svgElement('path', { d: 'M 0 -7 L 7 0 L 0 7 L -7 0 Z', class: 'xyz-plane-diamond' }));
    handle.setAttribute('transform', `translate(273 ${75 + planes.findIndex(pair => pair[0] === a && pair[1] === b) * 75})`);
    const marker = svgElement('text', { class: 'xyz-plane-label', 'text-anchor': 'end', x: -20, y: 4 });
    marker.textContent = `${AXIS_KEYS[a].toUpperCase()}/${AXIS_KEYS[b].toUpperCase()}`;
    const title = svgElement('title');
    title.textContent = `${labels[a]} / ${labels[b]} plane`;
    handle.append(title, marker);
    svg.append(handle);
    return handle;
  });
  const readouts = axes.map((control, index) => {
    const text = svgElement('text', { x: 49, y: 79 + index * 75, class: 'spatial-readout xyz-readout',
      'text-anchor': 'start', 'data-axis-label': control.id });
    svg.append(text);
    return text;
  });
  const pointer = pointerSession(svg, (event, active) => {
    const point = svgPoint(svg, event, SIZE, SIZE);
    if (!point) return;
    const dx = point.x - active.startPoint.x;
    const dy = point.y - active.startPoint.y;
    const patch = {};
    let delta;
    if (active.axes.length === 2) delta = solveCubePlaneDelta(dx, dy, AXIS_KEYS[active.axes[0]], AXIS_KEYS[active.axes[1]],
      CUBE_THETA, CUBE_PHI, CUBE_SCALE);
    else {
      const basis = projectCubePoint(...[0, 0, 0].map((_, i) => i === active.axes[0] ? 1 : 0),
        CUBE_THETA, CUBE_PHI, SIZE);
      const origin = projectCubePoint(0, 0, 0, CUBE_THETA, CUBE_PHI, SIZE);
      const bx = basis.x - origin.x;
      const by = basis.y - origin.y;
      delta = [(dx * bx + dy * by) / (bx * bx + by * by)];
    }
    if (!delta) return;
    active.axes.forEach((index, offset) => {
      const control = axes[index];
      const fraction = Math.max(0, Math.min(1, (active.startValues[index] + delta[offset] + 1) / 2));
      patch[control.id] = snapSliderValue(control, control.min + fraction * (control.max - control.min));
    });
    applyPatch(axes, patch, readValue, onChange, active);
  }, active => { if (active.changed && active.expensive) onRelease(); });
  function begin(event, indices, focus) {
    const startPoint = svgPoint(svg, event, SIZE, SIZE);
    if (!startPoint) return;
    const expensive = indices.some(index => axes[index].expensive);
    if (pointer.begin(event, { axes: indices, startPoint, startValues: position(axes, readValue),
      expensive, gestureExpensive: expensive })) focus?.focus();
  }
  handles.forEach((handle, index) => handle.addEventListener('pointerdown', event => begin(event, [index], handle)));
  planeHandles.forEach((handle, index) => handle.addEventListener('pointerdown', event => begin(event, planes[index])));
  function update() {
    const values = position(axes, readValue);
    const origin = projectCubePoint(...values, CUBE_THETA, CUBE_PHI, SIZE);
    positionDot.setAttribute('cx', String(origin.x));
    positionDot.setAttribute('cy', String(origin.y));
    handles.forEach((handle, index) => {
      const control = axes[index];
      const value = Number(readValue(control.id));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', formatSliderValue(control, value));
      readouts[index].textContent = `${labels[index]} · ${formatSliderValue(control, value)}`;
    });
  }
  const buttons = buildFocusButtons(card, axes, labels, handles);
  update();
  return viewActions(card, svg, unavailable, buttons, pointer, update, handles, axes);
}
