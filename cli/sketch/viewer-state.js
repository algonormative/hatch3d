/** Preserve only values that still satisfy the new control contract. */
export function reconcileControls(previousControls, previousParams, nextControls) {
  const byId = new Map(previousControls.map(control => [control.id, control]));
  const params = {};
  const incompatible = [];
  for (const control of nextControls) {
    const old = byId.get(control.id);
    const value = previousParams[control.id];
    let compatible = old?.type === control.type;
    if (compatible && control.type === 'slider') {
      const offset = (value - control.min) / control.step;
      compatible = typeof value === 'number' && Number.isFinite(value) && value >= control.min && value <= control.max &&
        Number.isFinite(offset) && Math.abs(offset - Math.round(offset)) < 1e-7;
    } else if (compatible && control.type === 'toggle') {
      compatible = typeof value === 'boolean';
    } else if (compatible && control.type === 'select') {
      compatible = typeof value === 'string' && control.options.includes(value);
    }
    if (compatible) params[control.id] = value;
    else {
      params[control.id] = control.default;
      if (old && value !== undefined) incompatible.push({ id: control.id, oldValue: value, reason: 'Type, range, step, or option changed' });
    }
  }
  for (const old of previousControls) {
    if (!nextControls.some(control => control.id === old.id) && previousParams[old.id] !== undefined) {
      incompatible.push({ id: old.id, oldValue: previousParams[old.id], reason: 'Control removed' });
    }
  }
  return { params, incompatible };
}

/** Make a temporary inspection image without changing the canonical SVG bytes. */
export function isolatePartSvg(fullSvg, selectedPartId) {
  if (!selectedPartId) return fullSvg;
  const document = new DOMParser().parseFromString(fullSvg, 'image/svg+xml');
  for (const group of document.querySelectorAll('[data-part-id]')) {
    if (group.getAttribute('data-part-id') !== selectedPartId) group.setAttribute('display', 'none');
  }
  return new XMLSerializer().serializeToString(document);
}
