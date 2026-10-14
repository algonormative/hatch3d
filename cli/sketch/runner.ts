import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SketchRunnerError } from '../../packages/plot-host/src/errors.js';
export { SketchRunnerError } from '../../packages/plot-host/src/errors.js';
import type { FinishingOptions, FormatOptions, Params, RenderResult, SketchMetadata } from '../../src/sketch/types.ts';

/** `format`: options for the sketch's format module, published with the requested page (see render-target.ts). */
export interface RenderOptions { entry: string; params?: Params; seed?: number; finishing?: FinishingOptions; format?: FormatOptions; timeoutMs?: number; signal?: AbortSignal }
export interface InspectOptions { entry: string; timeoutMs?: number; signal?: AbortSignal }

/** `retry: 'withholdTarget'`: the sketch is not page-aware but its modules adopted the render target; render it again without. */
type ChildResponse<T> = { ok: true; value: T } | { ok: false; retry?: 'withholdTarget'; error: { name: string; message: string } };

function run<T>(mode: 'inspect' | 'render', options: RenderOptions): Promise<T> {
  const { entry, params, seed, finishing, format, signal } = options;
  if (typeof entry !== 'string' || !entry.trim()) return Promise.reject(new SketchRunnerError('invalid_entry', 'Entry must be a file path'));
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new SketchRunnerError('invalid_timeout', 'Timeout must be a positive number of milliseconds'));
  if (signal?.aborted) return Promise.reject(new SketchRunnerError('aborted', 'Sketch render was aborted'));
  // Vitest rewrites import.meta.url to a virtual module URL; the CLI uses the file URL.
  let childFile: string;
  try { childFile = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './child.ts' : './child.js', import.meta.url)); }
  catch { childFile = resolve(process.cwd(), 'cli/sketch/child.ts'); }
  // One timer and one abort cover both attempts; whichever child is current is killed when the render settles.
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (error: SketchRunnerError | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child?.kill('SIGKILL');
      if (error) rejectPromise(error);
      else resolvePromise(value as T);
    };
    const abort = () => finish(new SketchRunnerError('aborted', 'Sketch render was aborted'));
    const timer = setTimeout(() => finish(new SketchRunnerError('timeout', `Sketch ${mode} exceeded ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const start = (withholdTarget: boolean) => {
      const current = fork(childFile, [], { execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child = current;
      const live = () => !settled && child === current;
      let stderr = '';
      current.stdout?.resume(); // Sketch console output must not fill the pipe and stall rendering.
      current.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
      current.on('message', (message: ChildResponse<T>) => {
        if (!live()) return;
        if (message?.ok) finish(null, message.value);
        else if (message && !message.ok && message.retry === 'withholdTarget' && !withholdTarget) {
          // A fresh process without the target: module state cannot be unloaded from this one.
          current.kill('SIGKILL');
          start(true);
        }
        else if (message && !message.ok) finish(new SketchRunnerError('sketch_error', message.error?.message ?? 'Sketch failed'));
        else finish(new SketchRunnerError('protocol_error', 'Sketch child returned an invalid message'));
      });
      current.on('error', (error) => { if (live()) finish(new SketchRunnerError('spawn_error', error.message)); });
      current.on('exit', (code, signalName) => {
        if (!live()) return;
        const detail = stderr.trim();
        finish(new SketchRunnerError('child_exit', `Sketch child exited (${signalName ?? code})${detail ? `: ${detail}` : ''}`));
      });
      current.send({ mode, entry: resolve(entry), params, seed, finishing, ...(format === undefined ? {} : { format }), ...(withholdTarget ? { withholdTarget } : {}) },
        (error) => { if (error && live()) finish(new SketchRunnerError('ipc_error', error.message)); });
    };
    start(false);
  });
}

/** Each invocation starts a fresh TypeScript child process, including transitive imports. */
export function renderSketch(options: RenderOptions): Promise<RenderResult> { return run<RenderResult>('render', options); }
export function inspectSketch(options: InspectOptions): Promise<SketchMetadata> { return run<SketchMetadata>('inspect', options); }
