/** Stable error code returned by the Node runner and CLI. */
export class SketchRunnerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SketchRunnerError'; }
}
