import { createRadarNavigator } from './radar-view.js';
import { createXYNavigator, createXYZNavigator } from './spatial-view.js';

const factories = {
  radar: (host, navigator, controls, readValue, onChange, onRelease) =>
    createRadarNavigator(host, navigator, controls, readValue,
      (id, value, expensive) => onChange({ [id]: value }, expensive), onRelease),
  xy: createXYNavigator,
  xyz: createXYZNavigator,
};

/** All navigators edit the same canonical raw slider values. */
export function createNavigatorView(host, navigator, controls, readValue, onChange, onRelease) {
  const factory = factories[navigator.type || 'radar'];
  if (!factory) throw new Error(`Unknown navigator type: ${navigator.type}`);
  return factory(host, navigator, controls, readValue, onChange, onRelease);
}
