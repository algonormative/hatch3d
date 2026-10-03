import { inspectSvg, penPathCounts, reconcileControls, reconcileHiddenPens } from './viewer-state.js';

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const emptyFinish = () => ({ pageMode: 'original', orientation: null, customWidth: null, customHeight: null,
    margin: null, paper: null, borderStyle: '', borderPen: null, pens: {}, densityEnabled: false, maxDensity: 20, cellSize: 10 });
  const state = { metadata: null, params: {}, seed: 0, finishing: emptyFinish(), invalidFinishing: new Map(), finishOptions: null, finishOptionsError: null,
    result: null, hiddenPenIds: new Set(), stale: true, sequence: 0, pending: null, timer: null, imageUrl: null, pins: [], pin: null };

  function status(message, stale = false) {
    $('status').textContent = message;
    $('status').classList.toggle('stale', stale);
    $('current-label').textContent = stale ? (state.result ? 'Previous inputs · stale preview' : 'No current preview') : 'Current inputs';
    $('pin').disabled = stale || !state.result;
    $('download').disabled = stale || !state.result;
    $('download-png').disabled = stale || !state.result;
    state.stale = stale;
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = false;
  }

  function clearError() {
    if (state.finishOptionsError) { showError(state.finishOptionsError); return; }
    $('error').hidden = true;
    $('error').textContent = '';
  }

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

  function finishNumber(value, label, minimum, maximum) {
    const number = Number(value);
    if (value === '' || !Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
    }
    return number;
  }

  function finishRequest() {
    if (!state.metadata) return undefined;
    if (state.invalidFinishing.size) throw new Error(state.invalidFinishing.values().next().value.message);
    const finish = state.finishing;
    const source = state.metadata.page;
    const request = {};
    if (finish.pageMode !== 'original' || finish.orientation !== null || finish.margin !== null || finish.paper !== null) {
      let width = source.width;
      let height = source.height;
      if (finish.pageMode === 'custom') {
        width = finishNumber(finish.customWidth, 'Custom width', 1, 2000);
        height = finishNumber(finish.customHeight, 'Custom height', 1, 2000);
      } else if (finish.pageMode !== 'original') {
        const preset = state.finishOptions?.paperSizes?.[finish.pageMode];
        if (!preset) throw new Error(`Unknown sheet preset: ${finish.pageMode}.`);
        width = preset.w;
        height = preset.h;
      }
      const orientation = finish.orientation || (source.width > source.height ? 'landscape' : 'portrait');
      if (finish.pageMode !== 'custom' && orientation === 'portrait') [width, height] = [Math.min(width, height), Math.max(width, height)];
      if (finish.pageMode !== 'custom' && orientation === 'landscape') [width, height] = [Math.max(width, height), Math.min(width, height)];
      request.page = { ...source, width, height };
      if (finish.margin !== null) request.page.margin = finishNumber(finish.margin, 'Margin', 0, 500);
      if (finish.paper !== null) {
        if (!finish.paper.trim()) throw new Error('Paper color cannot be empty.');
        request.page.paper = finish.paper.trim();
      }
    }
    if (finish.borderStyle) {
      const sourcePens = state.metadata.pens.map(pen => pen.id);
      const pen = finish.borderPen || sourcePens[0];
      if (!sourcePens.includes(pen)) throw new Error(`Border pen “${pen}” is no longer in the sketch.`);
      request.border = { style: finish.borderStyle, pen };
    }
    const penOverrides = {};
    for (const [id, override] of Object.entries(finish.pens)) {
      if (Object.keys(override).length) penOverrides[id] = override;
    }
    if (Object.keys(penOverrides).length) request.pens = penOverrides;
    if (finish.densityEnabled) request.density = {
      maxDensity: finishNumber(finish.maxDensity, 'Maximum lines per cell', 1, 100000),
      cellSize: finishNumber(finish.cellSize, 'Cell size', 0.1, 500),
    };
    return Object.keys(request).length ? request : undefined;
  }

  function queueFinishingRender() {
    try {
      finishRequest();
      clearError();
      queueRender(false);
    } catch (error) {
      state.sequence++;
      state.pending?.abort();
      markDirty('Finishing settings need correction.');
      showError(error.message || String(error));
    }
  }

  function fillFinishChoices() {
    const options = state.finishOptions;
    if (!options) return;
    const page = $('finish-page');
    const selectedPage = state.finishing.pageMode;
    page.replaceChildren(new Option('Original sketch', 'original'));
    for (const [id, size] of Object.entries(options.paperSizes)) page.add(new Option(size.label, id));
    page.add(new Option('Custom size', 'custom'));
    page.value = selectedPage;
    const border = $('finish-border');
    border.replaceChildren(new Option('None', ''));
    for (const [id, label] of Object.entries(options.borderStyles)) border.add(new Option(label, id));
    border.value = state.finishing.borderStyle;
    const scale = $('png-scale');
    scale.replaceChildren(...options.pngScales.map(value => new Option(`${value}×`, String(value))));
    scale.value = '6';
  }

  function renderFinishingControls() {
    if (!state.metadata) return;
    const finish = state.finishing;
    const source = state.metadata;
    const currentPage = $('finish-page').value;
    if (currentPage !== finish.pageMode) $('finish-page').value = finish.pageMode;
    $('finish-orientation').value = finish.orientation || (source.page.width > source.page.height ? 'landscape' : 'portrait');
    $('finish-custom').hidden = finish.pageMode !== 'custom';
    $('finish-width').value = finish.customWidth ?? source.page.width;
    $('finish-height').value = finish.customHeight ?? source.page.height;
    $('finish-margin').value = finish.margin ?? source.page.margin ?? '';
    $('finish-paper').value = finish.paper ?? source.page.paper ?? '#ffffff';
    $('finish-border').value = finish.borderStyle;
    const borderPen = $('finish-border-pen');
    borderPen.replaceChildren(...source.pens.map(pen => new Option(pen.id, pen.id)));
    borderPen.value = finish.borderPen || source.pens[0]?.id || '';
    borderPen.disabled = !finish.borderStyle;
    $('finish-density-enabled').checked = finish.densityEnabled;
    $('finish-density-fields').hidden = !finish.densityEnabled;
    $('finish-density-max').value = finish.maxDensity;
    $('finish-density-cell').value = finish.cellSize;
    const host = $('finish-pens');
    host.replaceChildren();
    for (const pen of source.pens) {
      const row = document.createElement('fieldset');
      row.className = 'finish-pen';
      const legend = document.createElement('legend');
      legend.textContent = pen.id;
      row.append(legend);
      const fields = document.createElement('div');
      fields.className = 'finish-pen-fields';
      for (const [key, label, type, min, max, step] of [
        ['color', 'Color', 'text', null, null, null],
        ['width', 'Width mm', 'number', '0.01', '10', '0.01'],
        ['passes', 'Passes', 'number', '1', '100', '1'],
      ]) {
        const wrapper = document.createElement('label');
        wrapper.textContent = label;
        const input = document.createElement('input');
        input.type = type;
        input.dataset.penId = pen.id;
        input.dataset.penField = key;
        input.setAttribute('aria-label', `${pen.id} ${label}`);
        if (min) input.min = min;
        if (max) input.max = max;
        if (step) input.step = step;
        const errorKey = `pen:${pen.id}:${key}`;
        input.value = state.invalidFinishing.has(errorKey) ? state.invalidFinishing.get(errorKey).value :
          finish.pens[pen.id]?.[key] ?? pen[key] ?? 1;
        let lastInput = input.value;
        const applyPenChange = () => {
          if (input.value === lastInput) return;
          lastInput = input.value;
          const baseline = pen[key] ?? 1;
          let value = input.value;
          if (key !== 'color') {
            try { value = finishNumber(value, `${pen.id} ${label}`, Number(min), Number(max)); }
            catch (error) {
              state.invalidFinishing.set(errorKey, { value: input.value, message: error.message });
              queueFinishingRender();
              return;
            }
            if (key === 'passes' && !Number.isInteger(value)) {
              state.invalidFinishing.set(errorKey, { value: input.value, message: `${pen.id} passes must be a whole number.` });
              queueFinishingRender();
              return;
            }
          } else if (!value.trim()) {
            state.invalidFinishing.set(errorKey, { value: input.value, message: `${pen.id} color cannot be empty.` });
            queueFinishingRender();
            return;
          }
          state.invalidFinishing.delete(errorKey);
          const override = { ...(finish.pens[pen.id] || {}) };
          if (value === baseline) delete override[key];
          else override[key] = value;
          if (Object.keys(override).length) finish.pens[pen.id] = override;
          else delete finish.pens[pen.id];
          queueFinishingRender();
        };
        input.addEventListener('input', applyPenChange);
        input.addEventListener('change', applyPenChange);
        wrapper.append(input);
        fields.append(wrapper);
      }
      row.append(fields);
      host.append(row);
    }
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
    const passes = pens.reduce((sum, pen) => sum + (pen.passes ?? 1), 0);
    $('pen-count').textContent = `${pens.length} ${pens.length === 1 ? 'layer' : 'layers'} · ${passes} ${passes === 1 ? 'pass' : 'passes'}`;
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
      spec.textContent = `${pen.width} mm${(pen.passes ?? 1) > 1 ? ` · ${pen.passes} passes` : ''} · ${counts.get(pen.id).toLocaleString()} plotted ${counts.get(pen.id) === 1 ? 'path' : 'paths'}`;
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
      const finishing = finishRequest();
      const payload = await api('/api/render', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ requestId: sequence, params: state.params, seed: state.seed, ...(finishing ? { finishing } : {}) }),
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
      renderFinishingControls();
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
    $('pin-detail').textContent = `${pin.page.width} × ${pin.page.height} mm${pin.finishing?.border ? ` · ${pin.finishing.border.style} border` : ''} · Seed ${pin.seed} · ${pin.stats.pathCount.toLocaleString()} paths · ${Object.entries(pin.params).map(([key, value]) => `${key}: ${value}`).join(' · ')}`;
  }

  async function loadFinishingOptions() {
    try {
      state.finishOptions = await api('/api/finishing-options');
      state.finishOptionsError = null;
      fillFinishChoices();
      renderFinishingControls();
    } catch (error) {
      state.finishOptionsError = `Could not load finishing choices: ${error.message || error}`;
      showError(state.finishOptionsError);
    }
  }

  function bindFinish(id, field, event = 'change', convert = value => value) {
    $(id).addEventListener(event, () => {
      state.finishing[field] = convert($(id).value);
      renderFinishingControls();
      queueFinishingRender();
    });
  }

  $('finish-page').addEventListener('change', () => {
    const finish = state.finishing;
    finish.pageMode = $('finish-page').value;
    if (finish.pageMode === 'original') finish.orientation = null;
    if (finish.pageMode === 'custom') {
      const width = Number(finish.customWidth ?? state.metadata?.page.width);
      const height = Number(finish.customHeight ?? state.metadata?.page.height);
      const orientation = finish.orientation || (state.metadata.page.width > state.metadata.page.height ? 'landscape' : 'portrait');
      finish.customWidth = orientation === 'portrait' ? Math.min(width, height) : Math.max(width, height);
      finish.customHeight = orientation === 'portrait' ? Math.max(width, height) : Math.min(width, height);
    }
    renderFinishingControls();
    queueFinishingRender();
  });
  $('finish-orientation').addEventListener('change', () => {
    state.finishing.orientation = $('finish-orientation').value;
    if (state.finishing.pageMode === 'custom') {
      const width = Number(state.finishing.customWidth ?? state.metadata?.page.width);
      const height = Number(state.finishing.customHeight ?? state.metadata?.page.height);
      if (Number.isFinite(width) && Number.isFinite(height)) {
        state.finishing.customWidth = state.finishing.orientation === 'portrait' ? Math.min(width, height) : Math.max(width, height);
        state.finishing.customHeight = state.finishing.orientation === 'portrait' ? Math.max(width, height) : Math.min(width, height);
        renderFinishingControls();
      }
    }
    queueFinishingRender();
  });
  for (const [id, field] of [['finish-width', 'customWidth'], ['finish-height', 'customHeight'],
    ['finish-margin', 'margin'], ['finish-paper', 'paper'], ['finish-density-max', 'maxDensity'], ['finish-density-cell', 'cellSize']]) {
    const update = () => {
      const authored = field === 'margin' ? state.metadata?.page.margin : field === 'paper' ? (state.metadata?.page.paper ?? '#ffffff') : undefined;
      const value = (field === 'margin' || field === 'paper') && ($(id).value === '' || $(id).value === String(authored ?? '')) ?
        null : $(id).value;
      if (state.finishing[field] === value) return;
      state.finishing[field] = value;
      if (field === 'customWidth' || field === 'customHeight') {
        const width = Number(state.finishing.customWidth ?? state.metadata?.page.width);
        const height = Number(state.finishing.customHeight ?? state.metadata?.page.height);
        if (width > 0 && height > 0 && width !== height) {
          state.finishing.orientation = width > height ? 'landscape' : 'portrait';
          $('finish-orientation').value = state.finishing.orientation;
        }
      }
      queueFinishingRender();
    };
    $(id).addEventListener('input', update);
    $(id).addEventListener('change', update);
  }
  bindFinish('finish-border', 'borderStyle');
  bindFinish('finish-border-pen', 'borderPen');
  $('finish-density-enabled').addEventListener('change', () => {
    state.finishing.densityEnabled = $('finish-density-enabled').checked;
    renderFinishingControls();
    queueFinishingRender();
  });
  $('finish-reset').addEventListener('click', () => {
    state.finishing = emptyFinish();
    state.invalidFinishing.clear();
    renderFinishingControls();
    queueFinishingRender();
  });

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
  $('download-png').addEventListener('click', () => {
    if (state.stale || !state.result) return;
    const anchor = document.createElement('a');
    const query = new URLSearchParams({ identity: state.result.identity, theme: $('png-theme').value, scale: $('png-scale').value || '6' });
    anchor.href = `/api/export.png?${query}`;
    anchor.download = `${state.result.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'sketch'}.png`;
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
  loadFinishingOptions();
  loadMetadata();
  refreshPins().catch(error => showError(`Could not load pins: ${error.message || error}`));
}
