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
export function inspectSvg(fullSvg, selectedPartId, hiddenPenIds, parts = [], pens = []) {
  const diagnostics = selectedPartId ? [] : parts.filter(part => part.diagnostic && part.paths.length && !hiddenPenIds.has(part.pen));
  if (!selectedPartId && hiddenPenIds.size === 0 && diagnostics.length === 0) return fullSvg;
  const document = new DOMParser().parseFromString(fullSvg, 'image/svg+xml');
  for (const layer of document.querySelectorAll('[data-pen-id]')) {
    if (hiddenPenIds.has(layer.getAttribute('data-pen-id'))) layer.setAttribute('display', 'none');
    if (selectedPartId) {
      for (const part of layer.querySelectorAll('[data-part-id]')) {
        if (part.getAttribute('data-part-id') !== selectedPartId) part.setAttribute('display', 'none');
      }
    }
  }
  if (diagnostics.length) {
    const namespace = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(namespace, 'g');
    overlay.setAttribute('data-inspection-diagnostics', '');
    overlay.setAttribute('fill', 'none');
    overlay.setAttribute('stroke-dasharray', '1.5 1.5');
    overlay.setAttribute('opacity', '0.6');
    for (const part of diagnostics) {
      const pen = pens.find(candidate => candidate.id === part.pen);
      const group = document.createElementNS(namespace, 'g');
      group.setAttribute('data-diagnostic-part-id', part.id);
      group.setAttribute('stroke', pen?.color || '#666666');
      group.setAttribute('stroke-width', String(pen?.width || 0.2));
      for (const points of part.paths) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(''));
        group.append(path);
      }
      overlay.append(group);
    }
    document.documentElement.append(overlay);
  }
  return new XMLSerializer().serializeToString(document);
}
