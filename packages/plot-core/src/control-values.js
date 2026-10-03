/** Clamp and snap once to the legal min + k * step lattice inside max. */
export function snapSliderValue(control, value) {
  if (control.type !== 'slider' || !Number.isFinite(value)) throw new Error(`Invalid slider value: ${control.id}`);
  const clamped = Math.min(control.max, Math.max(control.min, value));
  const decimals = [control.min, control.max, control.step].map(part => {
    const [mantissa, exponent = '0'] = part.toString().split('e');
    return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
  });
  const scale = 10 ** Math.max(...decimals);
  const scaled = [control.min * scale, control.max * scale, control.step * scale];
  const integerScaled = scaled.map(part => Math.round(part));
  let snapped;
  if (Number.isFinite(scale) && scaled.every((part, index) => Number.isSafeInteger(integerScaled[index]) && Math.abs(part - integerScaled[index]) <= 1e-7) && integerScaled[2] > 0) {
    const [min, max, step] = integerScaled;
    const last = Math.floor((max - min) / step);
    const index = Math.min(last, Math.max(0, Math.round((clamped * scale - min) / step)));
    snapped = (min + index * step) / scale;
  } else {
    const ratio = (control.max - control.min) / control.step;
    if (!Number.isFinite(ratio)) throw new Error(`Slider range overflowed: ${control.id}`);
    const last = Math.floor(ratio);
    const index = Math.min(last, Math.max(0, Math.round((clamped - control.min) / control.step)));
    snapped = control.min + index * control.step;
  }
  if (!Number.isFinite(snapped) || snapped > control.max) throw new Error(`Slider snap overflowed: ${control.id}`);
  return snapped;
}

/** Resolve native macro sources into effective slider values without mutating raw params. */
export function resolveMacroParams(controls, params, macros) {
  const effective = { ...params };
  if (!macros?.length) return effective;
  const byId = new Map(controls.map(control => [control.id, control]));
  const displacement = new Map();
  for (const macro of [...macros].sort((a, b) => a.control < b.control ? -1 : a.control > b.control ? 1 : 0)) {
    const source = byId.get(macro.control);
    if (!source || source.type !== 'slider' || !(source.max > source.min)) throw new Error(`Invalid macro source: ${macro.control}`);
    const raw = params[macro.control];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`Invalid macro value: ${macro.control}`);
    const travel = (raw - source.default) / (source.max - source.min);
    if (!Number.isFinite(travel)) throw new Error(`Macro travel overflowed: ${macro.control}`);
    for (const target of [...macro.targets].sort((a, b) => a.control < b.control ? -1 : a.control > b.control ? 1 : 0)) {
      if (!Number.isFinite(target.amount)) throw new Error(`Invalid macro amount for ${target.control}`);
      const contribution = target.amount * travel;
      const total = (displacement.get(target.control) ?? 0) + contribution;
      if (!Number.isFinite(contribution) || !Number.isFinite(total)) throw new Error(`Macro displacement overflowed: ${target.control}`);
      displacement.set(target.control, total);
    }
  }
  for (const [id, delta] of displacement) {
    if (delta === 0) continue; // Neutral travel (including exact cancellation) preserves the user's original number.
    const control = byId.get(id);
    const raw = params[id];
    if (!control || control.type !== 'slider' || typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`Invalid macro target: ${id}`);
    const proposed = raw + delta;
    if (!Number.isFinite(proposed)) throw new Error(`Macro target overflowed: ${id}`);
    const snapped = snapSliderValue(control, proposed);
    effective[id] = snapped === raw ? raw : snapped;
  }
  return effective;
}
