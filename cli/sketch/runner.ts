import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Params, RenderResult, SketchMetadata } from '../../src/sketch/types.ts';

export interface RenderOptions { entry: string; params?: Params; seed?: number; timeoutMs?: number; signal?: AbortSignal }
export interface InspectOptions { entry: string; timeoutMs?: number; signal?: AbortSignal }

export class SketchRunnerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SketchRunnerError'; }
}

type ChildResponse<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } };

function run<T>(mode: 'inspect' | 'render', options: RenderOptions): Promise<T> {
  const { entry, params, seed, signal } = options;
  if (typeof entry !== 'string' || !entry.trim()) return Promise.reject(new SketchRunnerError('invalid_entry', 'Entry must be a file path'));
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new SketchRunnerError('invalid_timeout', 'Timeout must be a positive number of milliseconds'));
  if (signal?.aborted) return Promise.reject(new SketchRunnerError('aborted', 'Sketch render was aborted'));
  // Vitest rewrites import.meta.url to a virtual module URL; the CLI uses the file URL.
  let childFile: string;
  try { childFile = fileURLToPath(new URL('./child.ts', import.meta.url)); }
  catch { childFile = resolve(process.cwd(), 'cli/sketch/child.ts'); }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const child = fork(childFile, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let settled = false;
    let stderr = '';
    child.stdout?.resume(); // Sketch console output must not fill the pipe and stall rendering.
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill('SIGKILL'); };
    const finish = (error: SketchRunnerError | null, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(value as T);
    };
    const abort = () => finish(new SketchRunnerError('aborted', 'Sketch render was aborted'));
    const timer = setTimeout(() => finish(new SketchRunnerError('timeout', `Sketch ${mode} exceeded ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('message', (message: ChildResponse<T>) => {
      if (message?.ok) finish(null, message.value);
      else if (message && !message.ok) finish(new SketchRunnerError('sketch_error', message.error?.message ?? 'Sketch failed'));
      else finish(new SketchRunnerError('protocol_error', 'Sketch child returned an invalid message'));
    });
    child.on('error', (error) => finish(new SketchRunnerError('spawn_error', error.message)));
    child.on('exit', (code, signalName) => {
      const detail = stderr.trim();
      finish(new SketchRunnerError('child_exit', `Sketch child exited (${signalName ?? code})${detail ? `: ${detail}` : ''}`));
    });
    child.send({ mode, entry: resolve(entry), params, seed }, (error) => { if (error) finish(new SketchRunnerError('ipc_error', error.message)); });
  });
}

/** Each invocation starts a fresh TypeScript child process, including transitive imports. */
export function renderSketch(options: RenderOptions): Promise<RenderResult> { return run<RenderResult>('render', options); }
export function inspectSketch(options: InspectOptions): Promise<SketchMetadata> { return run<SketchMetadata>('inspect', options); }
