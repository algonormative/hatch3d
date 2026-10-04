import { createNavigatorView } from './navigator-view.js';
import { resolveMacroParams } from './control-values.js';

let nextPanelId = 0;

/** Mount the existing sketch editors into two caller-owned containers. */
export function mountControlPanel(options) {
  const { controlsHost, navigatorsHost, onChange, onCommit = () => {}, onError = () => {}, resetFocus } = options;
  const hadControlsClass = controlsHost.classList.contains('plot-controls');
  const hadNavigatorsClass = navigatorsHost.classList.contains('plot-navigators');
  controlsHost.classList.add('plot-controls');
  navigatorsHost.classList.add('plot-navigators');
  const prefix = options.idPrefix ?? `plot-control-${++nextPanelId}`;
  let controls = options.controls;
  let navigators = options.navigators || [];
  let macros = options.macros || [];
  let params = { ...options.params };
  let views = [];
  let disposed = false;
  let suppressCallbacks = false;
  const groupCollapsed = new Map();
  const rows = new Map();
  const inputs = new Map();
  const inputId = id => `${prefix}-${id}`;
  const rowId = id => `${prefix}-row-${id}`;
  const rowFor = id => rows.get(id);
  const inputFor = id => inputs.get(id);
  const commit = () => { if (!disposed && !suppressCallbacks) onCommit(); };
  const format = (control, value) => `${value}${control.units ? ` ${control.units}` : ''}`;

  function visibility() {
    for (const control of controls) {
      const row = rowFor(control.id);
      if (row) row.hidden = Boolean(control.showWhen && params[control.showWhen.control] !== control.showWhen.equals);
    }
    for (const panel of controlsHost.querySelectorAll('.control-group')) {
      const count = [...panel.querySelectorAll('.control')].filter(row => !row.hidden).length;
      panel.hidden = count === 0;
      panel.querySelector('summary').textContent = `${panel.dataset.group} · ${count} ${count === 1 ? 'control' : 'controls'}`;
    }
    for (const { navigator, view } of views) {
      view.setAvailable(navigator.axes.every(id => {
        const row = rowFor(id);
        return row && !row.hidden;
      }));
    }
  }

  function sync() {
    let effective = params;
    let macroError = null;
    try {
      if (macros.length) effective = resolveMacroParams(controls, params, macros);
    } catch (error) {
      macroError = error.message || String(error);
      onError(`Could not preview sketch macros: ${macroError}`);
    }
    for (const control of controls) {
      const input = inputFor(control.id);
      if (!input) continue;
      if (control.type === 'toggle') input.checked = Boolean(params[control.id]);
      else input.value = params[control.id];
      if (control.type === 'slider') {
        const row = rowFor(control.id);
        row.querySelector('.value').textContent = format(control, params[control.id]);
        const macroValue = row.querySelector('.macro-value');
        if (macroValue) {
          if (macroError) macroValue.textContent = `Base ${format(control, params[control.id])} · With sketch macros unavailable`;
          else {
            const value = Number(effective[control.id]);
            const limit = value === control.min ? ' · at min' : value === control.max ? ' · at max' : '';
            macroValue.textContent = `Base ${format(control, params[control.id])} · With sketch macros ${format(control, value)}${limit}`;
          }
        }
      }
    }
    for (const { view } of views) view.update();
    visibility();
  }

  function edit(patch, expensive = false) {
    if (disposed || suppressCallbacks) return;
    const changed = Object.fromEntries(Object.entries(patch).filter(([id, value]) => params[id] !== value));
    if (!Object.keys(changed).length) return;
    Object.assign(params, changed);
    onChange(changed, { expensive });
    if (!disposed) sync();
  }

  function focusState() {
    const element = controlsHost.ownerDocument.activeElement;
    const handle = element?.closest?.('.radar-handle, .spatial-handle');
    if (handle && navigatorsHost.contains(handle)) return { navigator: handle.dataset.navigatorId, axis: handle.dataset.axisId };
    const input = element?.closest?.('.control');
    if (input && controlsHost.contains(input)) return { control: input.dataset.controlId };
    const group = element?.closest?.('.control-group');
    if (group && controlsHost.contains(group)) return { group: group.dataset.group };
    return null;
  }

  function rebuild() {
    const focus = focusState();
    for (const { view } of views) view.dispose();
    views = [];
    rows.clear();
    inputs.clear();
    controlsHost.replaceChildren();
    navigatorsHost.replaceChildren();
    const groups = new Map();
    for (const control of controls) {
      let parent = controlsHost;
      if (control.group) {
        if (!groups.has(control.group)) {
          const panel = controlsHost.ownerDocument.createElement('details');
          panel.className = 'control-group';
          panel.dataset.group = control.group;
          panel.open = groupCollapsed.has(control.group) ? !groupCollapsed.get(control.group) : groups.size === 0;
          panel.addEventListener('toggle', () => groupCollapsed.set(control.group, !panel.open));
          const summary = controlsHost.ownerDocument.createElement('summary');
          summary.textContent = control.group;
          const body = controlsHost.ownerDocument.createElement('div');
          body.className = 'control-group-body';
          const resetButton = controlsHost.ownerDocument.createElement('button');
          resetButton.type = 'button';
          resetButton.className = 'quiet control-group-reset';
          resetButton.dataset.groupReset = control.group;
          resetButton.textContent = `Reset ${control.group}`;
          resetButton.addEventListener('click', () => reset(control.group));
          body.append(resetButton);
          panel.append(summary, body);
          controlsHost.append(panel);
          groups.set(control.group, body);
        }
        parent = groups.get(control.group);
      }
      const row = controlsHost.ownerDocument.createElement('div');
      row.className = 'control';
      row.id = rowId(control.id);
      row.dataset.controlId = control.id;
      rows.set(control.id, row);
      if (control.type === 'toggle') {
        const label = controlsHost.ownerDocument.createElement('label');
        label.className = 'check';
        const input = controlsHost.ownerDocument.createElement('input');
        input.id = inputId(control.id);
        inputs.set(control.id, input);
        input.type = 'checkbox';
        input.addEventListener('change', () => edit({ [control.id]: input.checked }));
        label.append(input, controlsHost.ownerDocument.createTextNode(control.label));
        row.append(label);
      } else {
        const heading = controlsHost.ownerDocument.createElement('div');
        heading.className = 'control-head';
        const label = controlsHost.ownerDocument.createElement('label');
        label.textContent = control.label;
        label.htmlFor = inputId(control.id);
        heading.append(label);
        if (control.type === 'slider') {
          const value = controlsHost.ownerDocument.createElement('span');
          value.className = 'value';
          heading.append(value);
          const influenced = macros.some(macro => macro.targets.some(target => target.control === control.id));
          const input = controlsHost.ownerDocument.createElement('input');
          input.id = inputId(control.id);
          inputs.set(control.id, input);
          input.type = 'range';
          input.min = control.min;
          input.max = control.max;
          input.step = control.step;
          input.addEventListener('input', () => edit({ [control.id]: Number(input.value) }, Boolean(control.expensive)));
          if (control.expensive) input.addEventListener('change', commit);
          const range = controlsHost.ownerDocument.createElement('div');
          range.className = 'range';
          const minimum = controlsHost.ownerDocument.createElement('span');
          const maximum = controlsHost.ownerDocument.createElement('span');
          minimum.textContent = format(control, control.min);
          maximum.textContent = format(control, control.max);
          range.append(minimum, maximum);
          row.append(heading);
          if (influenced) {
            const macroValue = controlsHost.ownerDocument.createElement('div');
            macroValue.className = 'macro-value';
            row.append(macroValue);
          }
          row.append(input, range);
        } else if (control.type === 'text') {
          const input = controlsHost.ownerDocument.createElement('input');
          input.id = inputId(control.id);
          inputs.set(control.id, input);
          input.type = 'text';
          input.maxLength = control.maxLength;
          input.addEventListener('input', () => edit({ [control.id]: input.value }, Boolean(control.expensive)));
          if (control.expensive) input.addEventListener('change', commit);
          row.append(heading, input);
        } else {
          const input = controlsHost.ownerDocument.createElement('select');
          input.id = inputId(control.id);
          inputs.set(control.id, input);
          for (const optionValue of control.options) {
            const option = controlsHost.ownerDocument.createElement('option');
            option.value = optionValue;
            option.textContent = control.optionLabels && Object.hasOwn(control.optionLabels, optionValue) ? control.optionLabels[optionValue] : optionValue;
            input.append(option);
          }
          input.addEventListener('change', () => edit({ [control.id]: input.value }));
          row.append(heading, input);
        }
      }
      parent.append(row);
    }
    navigatorsHost.hidden = navigators.length === 0;
    if (navigators.length) {
      const heading = navigatorsHost.ownerDocument.createElement('h2');
      heading.textContent = 'Shape map';
      navigatorsHost.append(heading);
      for (const navigator of navigators) {
        const view = createNavigatorView(navigatorsHost, navigator, controls, id => params[id],
          (patch, expensive) => edit(patch, expensive), commit);
        views.push({ navigator, view });
      }
      if (macros.length) {
        const note = navigatorsHost.ownerDocument.createElement('p');
        note.className = 'radar-macro-note';
        note.textContent = '“With sketch macros” previews slider effects. Sketch code may transform values further.';
        navigatorsHost.append(note);
      }
    }
    sync();
    if (focus?.navigator) {
      if (!views.some(({ navigator, view }) => navigator.id === focus.navigator && view.focusAxis(focus.axis))) resetFocus?.focus();
    } else if (focus?.control) {
      const input = inputFor(focus.control);
      if (input && !rowFor(focus.control)?.hidden) input.focus();
      else resetFocus?.focus();
    } else if (focus?.group) {
      [...controlsHost.querySelectorAll('[data-group-reset]')].find(button => button.dataset.groupReset === focus.group)?.focus();
    }
  }

  function reset(group) {
    if (disposed) return;
    for (const { view } of views) view.cancel();
    const patch = Object.fromEntries(controls.filter(control => group === undefined || control.group === group)
      .map(control => [control.id, control.default]));
    Object.assign(params, patch);
    onChange(patch, { expensive: false });
    if (!disposed) sync();
  }

  rebuild();
  return {
    update(next) {
      if (disposed) return;
      suppressCallbacks = true;
      try {
        const structureChanged = next.controls !== undefined || next.navigators !== undefined || next.macros !== undefined;
        if (next.controls !== undefined) controls = next.controls;
        if (next.navigators !== undefined) navigators = next.navigators;
        if (next.macros !== undefined) macros = next.macros;
        if (next.params !== undefined) params = { ...next.params };
        if (structureChanged) rebuild();
        else sync();
      } finally {
        suppressCallbacks = false;
      }
    },
    reset,
    cancel() { for (const { view } of views) view.cancel(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { view } of views) view.dispose();
      views = [];
      rows.clear();
      inputs.clear();
      controlsHost.replaceChildren();
      navigatorsHost.replaceChildren();
      if (!hadControlsClass) controlsHost.classList.remove('plot-controls');
      if (!hadNavigatorsClass) navigatorsHost.classList.remove('plot-navigators');
    },
  };
}
