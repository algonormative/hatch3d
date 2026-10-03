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

/** Keep a pen hidden by stable ID only while that pen exists in the new result. */
export function reconcileHiddenPens(previousHidden, nextPens) {
  return new Set(nextPens.map(pen => pen.id).filter(id => previousHidden.has(id)));
}

/** Count paths the runner places in each physical pen layer. */
export function penPathCounts(pens, parts) {
  const counts = new Map(pens.map(pen => [pen.id, 0]));
  for (const part of parts) {
    if (!part.diagnostic && counts.has(part.pen)) counts.set(part.pen, counts.get(part.pen) + part.paths.length);
  }
  return counts;
}

/** Make a temporary inspection image without changing the canonical SVG bytes. */
export function inspectSvg(fullSvg, selectedPartId, hiddenPenIds) {
  if (!selectedPartId && hiddenPenIds.size === 0) return fullSvg;
  const document = new DOMParser().parseFromString(fullSvg, 'image/svg+xml');
  for (const layer of document.querySelectorAll('[data-pen-id]')) {
    if (hiddenPenIds.has(layer.getAttribute('data-pen-id'))) layer.setAttribute('display', 'none');
    if (selectedPartId) {
      for (const part of layer.querySelectorAll('[data-part-id]')) {
        if (part.getAttribute('data-part-id') !== selectedPartId) part.setAttribute('display', 'none');
      }
    }
  }
  return new XMLSerializer().serializeToString(document);
}
