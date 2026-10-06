import { snapSliderValue } from './control-values.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function svgPoint(svg, event, width, height) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (event.clientX - rect.left) * width / rect.width,
    y: (event.clientY - rect.top) * height / rect.height,
  };
}

export function sliderKeyValue(control, current, key) {
  let proposed;
  if (key === 'ArrowUp' || key === 'ArrowRight') proposed = current + control.step;
  else if (key === 'ArrowDown' || key === 'ArrowLeft') proposed = current - control.step;
  else if (key === 'Home') proposed = control.min;
  else if (key === 'End') proposed = control.max;
  else return null;
  return snapSliderValue(control, proposed);
}

export function formatSliderValue(control, value) {
  return `${value}${control.units ? ` ${control.units}` : ''}`;
}

/** A capture belongs to its SVG and cannot outlive its view. */
export function pointerSession(svg, onMove, onFinish) {
  let active = null;
  let disposed = false;
  const move = event => {
    if (active && event.pointerId === active.pointerId) onMove(event, active);
  };
  const end = event => {
    if (active && event.pointerId === active.pointerId) finish(true);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('lostpointercapture', end);

  function finish(flush) {
    if (!active) return;
    const completed = active;
    active = null;
    if (svg.hasPointerCapture?.(completed.pointerId)) svg.releasePointerCapture(completed.pointerId);
    if (flush) onFinish(completed);
  }

  return {
    begin(event, details) {
      if (disposed || active || event.button !== 0) return false;
      event.preventDefault();
      active = { pointerId: event.pointerId, changed: false, ...details };
      svg.setPointerCapture?.(event.pointerId);
      onMove(event, active);
      return true;
    },
    release() { finish(true); },
    cancel() { finish(false); },
    dispose() {
      disposed = true;
      finish(false);
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', end);
      svg.removeEventListener('pointercancel', end);
      svg.removeEventListener('lostpointercapture', end);
    },
  };
}
