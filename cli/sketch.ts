import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { createCheckpoint, replayCheckpoint } from './sketch/checkpoint.ts';
import { comparePreserved } from './sketch/preserve.ts';
import { inspectSketch, renderSketch, SketchRunnerError } from './sketch/runner.ts';
import type { Params, RenderResult } from '../src/sketch/types.ts';

function usage(): string {
  return 'Usage: npm run sketch -- <inspect|render|open|checkpoint|replay|compare> <entry.ts|checkpoint-dir|before-result.json> [options]. See docs/sketches.md';
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const flagsByCommand: Record<string, string[]> = {
  inspect: ['timeout'], render: ['params', 'config', 'seed', 'out', 'timeout'], open: ['port', 'out'],
  checkpoint: ['result', 'out'], replay: ['out'], compare: ['after', 'parts', 'boundaries'],
};

function options(command: string, args: string[]): { entry: string; flags: Record<string, string> } {
  const [entry, ...rest] = args;
  if (!entry || entry.startsWith('--')) throw new SketchRunnerError('usage', usage());
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new SketchRunnerError('usage', usage());
    const key = flag.slice(2);
    if (!flagsByCommand[command].includes(key) || key in flags) throw new SketchRunnerError('usage', `Unknown or repeated option ${flag} for ${command}. ${usage()}`);
    flags[key] = value;
  }
  return { entry, flags };
}

function required(flags: Record<string, string>, key: string): string {
  if (!flags[key]) throw new SketchRunnerError('usage', `--${key} is required. ${usage()}`);
  return flags[key];
}

function ids(value: string, flag: string): string[] {
  const list = value.split(',').map((id) => id.trim());
  if (list.some((id) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id))) throw new SketchRunnerError('invalid_option', `--${flag} must be comma-separated part IDs`);
  return list;
}

async function loadResult(path: string): Promise<RenderResult> {
  let value: unknown;
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new SketchRunnerError('invalid_result', `Cannot read render result JSON: ${path}`); }
  if (!object(value)) throw new SketchRunnerError('invalid_result', `Invalid render result: ${path}`);
  const record = value;
  const result = 'pinId' in record && 'pinnedAt' in record ? record.result : value;
  if (!object(result)) throw new SketchRunnerError('invalid_result', `Invalid render result: ${path}`);
  const r = result;
  if (r.schemaVersion !== 1 || typeof r.identity !== 'string' || !Array.isArray(r.parts) || !r.parts.every((part) => object(part) && typeof part.id === 'string' && typeof part.pen === 'string' && Array.isArray(part.paths)) || typeof r.svg !== 'string' || !object(r.metadata) || !object(r.metadata.page) || !Array.isArray(r.metadata.pens) || !object(r.params) || !Number.isSafeInteger(r.seed) || (r.seed as number) < 0) {
    throw new SketchRunnerError('invalid_result', `Expected a successful RenderResult or pin manifest: ${path}`);
  }
  return result as unknown as RenderResult;
}

async function writeArtifacts(result: RenderResult, outputDir: string): Promise<{ svg: string; png: string; result: string }> {
  await mkdir(outputDir, { recursive: true });
  const svgPath = resolve(outputDir, 'render.svg');
  const pngPath = resolve(outputDir, 'render.png');
  const resultPath = resolve(outputDir, 'result.json');
  const widthPx = Math.max(1, Math.round(result.metadata.page.width / 25.4 * 150));
  const png = new Resvg(result.svg, { background: result.metadata.page.paper ?? '#ffffff', fitTo: { mode: 'width', value: widthPx } }).render().asPng();
  await Promise.all([writeFile(svgPath, result.svg), writeFile(pngPath, png), writeFile(resultPath, JSON.stringify(result, null, 2))]);
  return { svg: svgPath, png: pngPath, result: resultPath };
}

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new SketchRunnerError('invalid_option', `${label} must be a nonnegative safe integer`);
  return n;
}

async function params(value: string | undefined): Promise<Params | undefined> {
  if (value === undefined) return undefined;
  const source = value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value;
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new SketchRunnerError('invalid_params', '--params must be a JSON object or @path/to/file.json'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SketchRunnerError('invalid_params', '--params must be a JSON object');
  return parsed as Params;
}

async function requestConfig(path: string | undefined): Promise<{ params?: Params; seed?: number }> {
  if (path === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new SketchRunnerError('invalid_config', '--config must be a readable JSON request document'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SketchRunnerError('invalid_config', '--config must contain an object');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'params' && key !== 'seed')) throw new SketchRunnerError('invalid_config', '--config accepts only params and seed');
  if (record.params !== undefined && (typeof record.params !== 'object' || record.params === null || Array.isArray(record.params))) throw new SketchRunnerError('invalid_config', '--config params must be an object');
  if (record.seed !== undefined && (!Number.isSafeInteger(record.seed) || (record.seed as number) < 0)) throw new SketchRunnerError('invalid_config', '--config seed must be a nonnegative safe integer');
  return { params: record.params as Params | undefined, seed: record.seed as number | undefined };
}

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || !Object.hasOwn(flagsByCommand, command)) throw new SketchRunnerError('usage', usage());
  const { entry, flags } = options(command, rest);
  if (command === 'checkpoint') {
    const outputDir = resolve(required(flags, 'out'));
    const result = await loadResult(required(flags, 'result'));
    const saved = await createCheckpoint({ entry, result, outputDir });
    console.log(JSON.stringify({ checkpoint: saved.path, identity: saved.manifest.identity, revision: saved.manifest.revision }));
    return;
  }
  if (command === 'replay') {
    const outputDir = resolve(required(flags, 'out'));
    const result = await replayCheckpoint({ checkpoint: entry });
    const paths = await writeArtifacts(result, outputDir);
    console.log(JSON.stringify({ identity: result.identity, ...paths, diagnostics: result.diagnostics, stats: result.stats }));
    return;
  }
  if (command === 'compare') {
    const before = await loadResult(entry);
    const after = await loadResult(required(flags, 'after'));
    const selection = { parts: ids(required(flags, 'parts'), 'parts'), ...(flags.boundaries ? { boundaries: ids(flags.boundaries, 'boundaries') } : {}) };
    const comparison = comparePreserved(before, after, selection);
    console.log(JSON.stringify(comparison));
    if (!comparison.ok) process.exitCode = 2;
    return;
  }
  const timeoutMs = integer(flags.timeout, 'timeout');
  if (timeoutMs === 0) throw new SketchRunnerError('invalid_option', 'timeout must be positive');
  if (command === 'inspect') {
    console.log(JSON.stringify(await inspectSketch({ entry, timeoutMs })));
    return;
  }
  if (command === 'open') {
    const port = integer(flags.port, 'port');
    const { startSketchServer } = await import('./sketch/server.ts');
    const server = await startSketchServer({ entry, ...(port === undefined ? {} : { port }), ...(flags.out === undefined ? {} : { outputDir: resolve(flags.out) }) });
    console.log(JSON.stringify({ url: server.url }));
    const shutdown = () => { void server.close().then(() => process.exit(0)); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  if (flags.config && (flags.params || flags.seed)) throw new SketchRunnerError('usage', '--config cannot be combined with --params or --seed');
  const request = flags.config ? await requestConfig(flags.config) : { params: await params(flags.params), seed: integer(flags.seed, 'seed') };
  const result = await renderSketch({ entry, ...request, timeoutMs });
  const outputDir = resolve(flags.out ?? `sketch-output/${basename(entry).replace(/\.[^.]+$/, '')}`);
  const paths = await writeArtifacts(result, outputDir);
  console.log(JSON.stringify({ identity: result.identity, ...paths, diagnostics: result.diagnostics, stats: result.stats }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof SketchRunnerError ? error.code : 'error';
    console.error(JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } }));
    process.exitCode = 1;
  });
}
