import type { Control, Navigator, Macro, Params } from './types.js';

export interface ControlPanelOptions {
  controlsHost: HTMLElement;
  navigatorsHost: HTMLElement;
  controls: Control[];
  navigators?: Navigator[];
  macros?: Macro[];
  params: Params;
  onChange: (patch: Params, options: { expensive: boolean }) => void;
  onCommit?: () => void;
  onError?: (message: string | null) => void;
  resetFocus?: HTMLElement;
  /** Override the generated prefix when retaining an existing host's DOM IDs. */
  idPrefix?: string;
}

export interface ControlPanelUpdate {
  controls?: Control[];
  navigators?: Navigator[];
  macros?: Macro[];
  params?: Params;
}

export interface ControlPanel {
  update(next: ControlPanelUpdate): void;
  reset(group?: string): void;
  cancel(): void;
  dispose(): void;
}

export declare function mountControlPanel(options: ControlPanelOptions): ControlPanel;
