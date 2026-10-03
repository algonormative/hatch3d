import { inspectSvg, penPathCounts, reconcileControls, reconcileHiddenPens } from './viewer-state.js';

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const state = { metadata: null, params: {}, seed: 0, result: null, hiddenPenIds: new Set(), stale: true, sequence: 0, pending: null, timer: null, imageUrl: null, pins: [], pin: null };

  function status(message, stale = false) {
    $('status').textContent = message;
    $('status').classList.toggle('stale', stale);
    $('current-label').textContent = stale ? (state.result ? 'Previous inputs · stale preview' : 'No current preview') : 'Current inputs';
    $('pin').disabled = stale || !state.result;
    $('download').disabled = stale || !state.result;
    state.stale = stale;
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = false;
  }

  function clearError() { $('error').hidden = true; $('error').textContent = ''; }

  function markDirty(message = 'Rendering current settings…') {
    clearTimeout(state.timer);
    status(state.result ? `${message} Previous preview is from earlier settings.` : message, true);
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function formatValue(control, value) {
    return `${value}${control.units ? ` ${control.units}` : ''}`;
  }

  function renderControls() {
    const host = $('controls');
    host.replaceChildren();
    for (const control of state.metadata.controls) {
      const row = document.createElement('div');
      row.className = 'control';
      if (control.type === 'toggle') {
        const label = document.createElement('label');
        label.className = 'check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(state.params[control.id]);
        input.addEventListener('change', () => { state.params[control.id] = input.checked; queueRender(false); });
        label.append(input, document.createTextNode(control.label));
        row.append(label);
      } else {
        const heading = document.createElement('div');
        heading.className = 'control-head';
        const label = document.createElement('label');
        label.textContent = control.label;
        label.htmlFor = `control-${control.id}`;
        heading.append(label);
        if (control.type === 'slider') {
          const value = document.createElement('span');
          value.className = 'value';
          value.textContent = formatValue(control, state.params[control.id]);
          heading.append(value);
          const input = document.createElement('input');
          input.id = `control-${control.id}`;
          input.type = 'range';
          input.min = control.min;
          input.max = control.max;
          input.step = control.step;
          input.value = state.params[control.id];
          input.addEventListener('input', () => {
            state.params[control.id] = Number(input.value);
            value.textContent = formatValue(control, input.value);
            queueRender(Boolean(control.expensive));
          });
          if (control.expensive) input.addEventListener('change', () => scheduleRender(0));
          const range = document.createElement('div');
          range.className = 'range';
          const minimum = document.createElement('span');
          const maximum = document.createElement('span');
          minimum.textContent = formatValue(control, control.min);
          maximum.textContent = formatValue(control, control.max);
          range.append(minimum, maximum);
          row.append(heading, input, range);
        } else {
          const input = document.createElement('select');
          input.id = `control-${control.id}`;
          for (const optionValue of control.options) {
            const option = document.createElement('option');
            option.value = optionValue;
            option.textContent = optionValue;
            input.append(option);
          }
          input.value = state.params[control.id];
          input.addEventListener('change', () => { state.params[control.id] = input.value; queueRender(false); });
          row.append(heading, input);
        }
      }
      host.append(row);
    }
  }

  function queueRender(expensive) {
    state.sequence++;
    markDirty(expensive ? 'Release to redraw.' : 'Redrawing…');
    state.pending?.abort();
    if (!expensive) scheduleRender(130);
  }

  function scheduleRender(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(render, delay);
  }

  function setPage(metadata) {
    const frame = $('page-frame');
    frame.style.setProperty('--page-ratio', metadata.page.width / metadata.page.height);
    frame.style.setProperty('--paper', metadata.page.paper || '#ffffff');
  }

  function renderPaperAndInks() {
    const result = state.result;
    if (!result) return;
    const { page, pens } = result.metadata;
    $('paper-swatch').style.backgroundColor = page.paper || '#ffffff';
    $('paper-size').textContent = `${page.width} × ${page.height} mm`;
    $('pen-count').textContent = `${pens.length} ${pens.length === 1 ? 'pass' : 'passes'}`;
    const counts = penPathCounts(pens, result.parts);
    const host = $('pen-layers');
    host.replaceChildren();
    for (const [index, pen] of pens.entries()) {
      const row = document.createElement('label');
      row.className = 'pen-layer';
      row.classList.toggle('is-hidden', state.hiddenPenIds.has(pen.id));
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !state.hiddenPenIds.has(pen.id);
      input.setAttribute('aria-label', `Show ${pen.id} pen layer`);
      input.addEventListener('change', () => {
        if (input.checked) state.hiddenPenIds.delete(pen.id);
        else state.hiddenPenIds.add(pen.id);
        row.classList.toggle('is-hidden', !input.checked);
        showArt();
      });
      const swatch = document.createElement('span');
      swatch.className = 'pen-swatch';
      swatch.style.backgroundColor = pen.color;
      swatch.setAttribute('aria-hidden', 'true');
      const details = document.createElement('span');
      details.className = 'pen-details';
      const name = document.createElement('strong');
      name.textContent = `${index + 1}. ${pen.id}`;
      const spec = document.createElement('span');
      spec.textContent = `${pen.width} mm · ${counts.get(pen.id).toLocaleString()} plotted ${counts.get(pen.id) === 1 ? 'path' : 'paths'}`;
      details.append(name, spec);
      row.append(input, swatch, details);
      host.append(row);
    }
  }

  function referenceOverlay() {
    const layer = $('reference-layer');
    layer.replaceChildren();
    const shownMetadata = state.result?.metadata || state.metadata;
    const assets = Object.values(shownMetadata?.assets || {});
    $('overlay').disabled = assets.length === 0;
    layer.hidden = !$('overlay').checked || assets.length === 0;
    if (layer.hidden) { updateInspectionNote(); return; }
    for (const asset of assets) {
      const img = document.createElement('img');
      img.src = asset.dataUrl;
      img.alt = '';
      img.style.left = `${100 * asset.box.x / shownMetadata.page.width}%`;
      img.style.top = `${100 * asset.box.y / shownMetadata.page.height}%`;
      img.style.width = `${100 * asset.box.width / shownMetadata.page.width}%`;
      img.style.height = `${100 * asset.box.height / shownMetadata.page.height}%`;
      img.style.objectFit = asset.fit;
      layer.append(img);
    }
    updateInspectionNote();
  }

  function updateInspectionNote() {
    const active = [];
    if ($('overlay').checked && !$('overlay').disabled) active.push('source image overlay');
    if ($('part').value) active.push(`isolated part “${$('part').value}”`);
    const penCount = state.result?.metadata.pens.length || 0;
    if (state.hiddenPenIds.size && penCount) active.push(state.hiddenPenIds.size === penCount ?
      'all pen layers hidden from this preview' : `${state.hiddenPenIds.size} of ${penCount} pen layers hidden from this preview`);
    $('inspection-note').hidden = active.length === 0;
    $('inspection-note').textContent = active.length ? `Inspection only: ${active.join(' and ')}. Pin and export keep every pen layer and drawing part.` : '';
  }

  function visibleSvg(result) {
    return inspectSvg(result.svg, $('part').value, state.hiddenPenIds);
  }

  function showArt() {
    if (!state.result) return;
    const svg = visibleSvg(state.result);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    $('art').src = url;
    $('art').hidden = false;
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = url;
    updateInspectionNote();
  }

  function updateParts() {
    const selector = $('part');
    const selected = selector.value;
    selector.replaceChildren(new Option('Full composition', ''));
    for (const part of state.result.parts.filter(part => !part.diagnostic)) selector.add(new Option(part.id, part.id));
    selector.value = state.result.parts.some(part => part.id === selected && !part.diagnostic) ? selected : '';
  }

  async function render() {
    if (!state.metadata) return;
    const sequence = ++state.sequence;
    state.pending?.abort();
    const controller = new AbortController();
    state.pending = controller;
    markDirty('Rendering current settings…');
    try {
      const payload = await api('/api/render', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ requestId: sequence, params: state.params, seed: state.seed }),
      });
      if (sequence !== state.sequence || payload.requestId !== sequence) return;
      state.result = payload.result;
      state.params = { ...payload.result.params };
      state.hiddenPenIds = reconcileHiddenPens(state.hiddenPenIds, state.result.metadata.pens);
      updateParts();
      renderPaperAndInks();
      setPage(payload.result.metadata);
      referenceOverlay();
      showArt();
      clearError();
      const stats = payload.result.stats;
      $('summary').textContent = `${stats.pathCount.toLocaleString()} paths · ${Math.round(stats.lengthMm).toLocaleString()} mm of line · ${Math.round(payload.result.durationMs)} ms drawing time`;
      status('Current preview is ready. Full SVG is available to pin or export.');
    } catch (error) {
      if (sequence !== state.sequence || controller.signal.aborted) return;
      showError(error.message || String(error));
      status(state.result ? 'Render failed. Showing the previous inputs; pin and export are unavailable.' : 'Render failed; no preview available.', true);
    } finally {
      if (state.pending === controller) state.pending = null;
    }
  }

  async function loadMetadata(sourceChanged = false) {
    const sequence = ++state.sequence;
    state.pending?.abort();
    markDirty(sourceChanged ? 'Source changed. Checking controls…' : 'Loading sketch…');
    try {
      const next = await api('/api/metadata');
      if (sequence !== state.sequence) return;
      const previous = state.metadata;
      const reconciliation = previous ? reconcileControls(previous.controls, state.params, next.controls) :
        { params: Object.fromEntries(next.controls.map(control => [control.id, control.default])), incompatible: [] };
      state.metadata = next;
      state.params = reconciliation.params;
      $('title').textContent = next.name;
      document.title = `${next.name} · Sketch study`;
      setPage(state.result?.metadata || next);
      renderControls();
      referenceOverlay();
      const notice = $('incompatible');
      notice.hidden = reconciliation.incompatible.length === 0;
      notice.textContent = reconciliation.incompatible.length ?
        `Some values no longer fit the edited controls and were reset: ${reconciliation.incompatible.map(item => `${item.id} (${item.oldValue})`).join(', ')}.` : '';
      clearError();
      scheduleRender(0);
    } catch (error) {
      if (sequence !== state.sequence) return;
      showError(`Could not load the edited sketch: ${error.message || error}`);
      status(state.result ? 'Source could not load. Previous preview is stale.' : 'Sketch could not load.', true);
    }
  }

  async function refreshPins() {
    state.pins = await api('/api/pins');
    const selector = $('pin-select');
    const old = selector.value;
    selector.replaceChildren(new Option('No comparison', ''));
    for (const pin of state.pins) selector.add(new Option(`${pin.name} · ${new Date(pin.pinnedAt).toLocaleString()}`, pin.pinId));
    selector.value = state.pins.some(pin => pin.pinId === old) ? old : '';
  }

  async function selectPin(id) {
    const panel = $('pin-panel');
    panel.hidden = !id;
    $('comparison').classList.toggle('has-pin', Boolean(id));
    if (!id) return;
    const pin = state.pins.find(item => item.pinId === id);
    if (!pin) return;
    $('pin-art').parentElement.style.setProperty('--paper', pin.page.paper || '#ffffff');
    $('pin-art').parentElement.style.setProperty('--page-ratio', pin.page.width / pin.page.height);
    $('pin-art').src = `/api/pins/${encodeURIComponent(id)}/svg`;
    $('pin-date').textContent = new Date(pin.pinnedAt).toLocaleString();
    $('pin-detail').textContent = `Seed ${pin.seed} · ${pin.stats.pathCount.toLocaleString()} paths · ${Object.entries(pin.params).map(([key, value]) => `${key}: ${value}`).join(' · ')}`;
  }

  $('overlay').addEventListener('change', referenceOverlay);
  $('part').addEventListener('change', showArt);
  $('pin-select').addEventListener('change', event => selectPin(event.target.value));
  $('reset').addEventListener('click', () => {
    if (!state.metadata) return;
    state.params = Object.fromEntries(state.metadata.controls.map(control => [control.id, control.default]));
    $('incompatible').hidden = true;
    renderControls();
    queueRender(false);
  });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 0x7fffffff);
    $('seed').value = state.seed;
    queueRender(false);
  });
  $('seed').addEventListener('change', () => {
    const seed = Number($('seed').value);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0x7fffffff) {
      $('seed').value = state.seed;
      showError('Seed must be a whole number between 0 and 2147483647.');
      return;
    }
    if (seed !== state.seed) { state.seed = seed; queueRender(false); }
  });
  $('download').addEventListener('click', () => {
    if (state.stale || !state.result) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/export.svg?identity=${encodeURIComponent(state.result.identity)}`;
    anchor.download = `${state.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'sketch'}.svg`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  $('pin').addEventListener('click', async () => {
    if (state.stale || !state.result) return;
    const sequence = state.sequence;
    const identity = state.result.identity;
    $('pin').disabled = true;
    try {
      const saved = await api('/api/pins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity }) });
      await refreshPins();
      $('pin-select').value = saved.pinId;
      selectPin(saved.pinId);
      if (state.sequence === sequence && !state.stale && state.result?.identity === identity) status('Pinned this exact full SVG and settings.');
    } catch (error) { showError(error.message || String(error)); }
    finally { $('pin').disabled = state.stale; }
  });
  const events = new EventSource('/api/events');
  events.addEventListener('source-change', () => loadMetadata(true));
  loadMetadata();
  refreshPins().catch(error => showError(`Could not load pins: ${error.message || error}`));
}
