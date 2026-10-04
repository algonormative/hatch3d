import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RenderResult } from '../../src/sketch/types.ts';
import type { ExperimentBatchOptions, ExperimentCandidate, ExperimentManifest, ExperimentMatrix, ExperimentInputFingerprint } from '../../packages/plot-host/src/experiment-types.js';
import { exportSketchPng } from './export-png.ts';
import { fingerprintSketchInputs } from './checkpoint.ts';
import { readBounded } from './checkpoint-external.ts';
import { renderSketch } from './runner.ts';

const PIPELINE_VERSION = 1;
const MAX_CANDIDATES = 32;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  throw new Error('Experiment matrix must contain only finite JSON values');
}

function validate(matrix: ExperimentMatrix): void {
  if (!object(matrix) || Object.keys(matrix).some(key => !['sources', 'regimes', 'seeds', 'finishing', 'png'].includes(key))) throw new Error('Invalid experiment matrix fields');
  if (!Array.isArray(matrix.sources) || !Array.isArray(matrix.regimes) || !Array.isArray(matrix.seeds) ||
      matrix.sources.length < 1 || matrix.regimes.length < 1 || matrix.seeds.length < 1 ||
      matrix.sources.length * matrix.regimes.length * matrix.seeds.length > MAX_CANDIDATES) throw new Error('Experiment matrix must contain 1–32 candidates');
  for (const [label, values] of [['source', matrix.sources], ['regime', matrix.regimes]] as const) {
    const ids = new Set<string>();
    for (const value of values) {
      if (!object(value) || !ID.test(value.id as string) || (value.id as string).includes('--') || ids.has(value.id as string)) throw new Error(`Invalid or duplicate ${label} ID; consecutive hyphens are reserved`);
      ids.add(value.id as string);
      if (label === 'source' && (typeof value.entry !== 'string' || !value.entry.trim() || Object.keys(value).some(key => !['id', 'entry'].includes(key)))) throw new Error('Invalid experiment source');
      if (label === 'regime' && (!object(value.params) || Object.keys(value).some(key => !['id', 'params'].includes(key)))) throw new Error('Invalid experiment regime');
    }
  }
  if (new Set(matrix.seeds).size !== matrix.seeds.length || matrix.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0)) throw new Error('Experiment seeds must be unique nonnegative safe integers');
  if (matrix.finishing !== undefined && !object(matrix.finishing)) throw new Error('Experiment finishing must be an object');
  if (matrix.png !== undefined && (!object(matrix.png) || Object.keys(matrix.png).some(key => !['theme', 'scale'].includes(key)))) throw new Error('Invalid experiment PNG options');
  const theme = matrix.png?.theme ?? 'paper';
  const scale = matrix.png?.scale ?? 2;
  if (!['paper', 'light', 'dark'].includes(theme) || ![1, 2, 3, 4, 6, 8].includes(scale)) throw new Error('Invalid experiment PNG theme or scale');
  stable(matrix);
}

const html = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function contactSheet(manifest: ExperimentManifest): string {
  const cards = manifest.candidates.map(candidate => {
    const label = `${candidate.sourceId} · ${candidate.regimeId} · seed ${candidate.seed}`;
    const image = candidate.status === 'success' && candidate.artifacts
      ? `<a href="${html(candidate.artifacts.png)}"><img src="${html(candidate.artifacts.png)}" alt="${html(label)} preview" loading="lazy"></a><p><a href="${html(candidate.artifacts.svg)}">SVG</a> · <a href="${html(candidate.artifacts.result)}">Result JSON</a></p>`
      : `<div class="empty" role="img" aria-label="No current preview">${html(candidate.status)}</div>`;
    return `<article><h2>${html(label)}</h2>${image}<p>${html(candidate.status)}${candidate.reused ? ' · reused' : ''}${candidate.identity ? ` · ${html(candidate.identity.slice(0, 12))}` : ''}</p>${candidate.error ? `<pre>${html(candidate.error)}</pre>` : ''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plot experiment contact sheet</title><style>body{font:16px system-ui;background:#eee;color:#222;margin:2rem}h1{font-size:1.5rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}article{background:#fff;padding:1rem;border:1px solid #ccc}h2{font-size:1rem}img,.empty{display:block;width:100%;aspect-ratio:4/3;object-fit:contain;background:#fafafa}.empty{display:grid;place-items:center;color:#666}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Plot experiment contact sheet</h1><p>${html(manifest.status)} · ${manifest.candidates.length} candidates · no ranking</p><main class="grid">${cards}</main></html>`;
}

async function saveManifest(outputDir: string, manifest: ExperimentManifest): Promise<void> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('Experiment manifest exceeds size limit');
  const pending = join(outputDir, `.manifest-${randomUUID()}.tmp`);
  const sheetPending = join(outputDir, `.sheet-${randomUUID()}.tmp`);
  try {
    await writeFile(pending, manifestBytes, { flag: 'wx' });
    await writeFile(sheetPending, contactSheet(manifest), { flag: 'wx' });
    await rename(sheetPending, join(outputDir, 'contact-sheet.html'));
    await rename(pending, join(outputDir, 'manifest.json'));
  } finally { await rm(pending, { force: true }); await rm(sheetPending, { force: true }); }
}

async function previousManifest(outputDir: string, name = 'manifest.json'): Promise<ExperimentManifest | undefined> {
  let bytes: Buffer;
  try { bytes = await readBounded(join(outputDir, name), MAX_MANIFEST_BYTES); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(value) || value.version !== 1 || !Array.isArray(value.candidates)) throw new Error('Existing experiment manifest is incompatible');
  return value as unknown as ExperimentManifest;
}

async function reusable(outputDir: string, candidate: ExperimentCandidate): Promise<boolean> {
  if (candidate.status !== 'success' || !candidate.artifacts || !candidate.identity) return false;
  const base = `candidates/${candidate.id}-${candidate.key.slice(0, 16)}`;
  if (candidate.artifacts.svg !== `${base}/render.svg` || candidate.artifacts.png !== `${base}/render.png` || candidate.artifacts.result !== `${base}/result.json`) return false;
  try {
    const [svg, png, result] = await Promise.all([
      readBounded(join(outputDir, candidate.artifacts.svg), MAX_ARTIFACT_BYTES),
      readBounded(join(outputDir, candidate.artifacts.png), MAX_ARTIFACT_BYTES),
      readBounded(join(outputDir, candidate.artifacts.result), MAX_ARTIFACT_BYTES),
    ]);
    if (sha256(svg) !== candidate.artifacts.sha256.svg || sha256(png) !== candidate.artifacts.sha256.png || sha256(result) !== candidate.artifacts.sha256.result) return false;
    const parsed = JSON.parse(result.toString('utf8')) as RenderResult;
    return parsed.identity === candidate.identity && parsed.svg === svg.toString('utf8');
  } catch { return false; }
}

async function writeCandidate(outputDir: string, candidate: ExperimentCandidate, result: RenderResult, png: Buffer, verify: () => Promise<boolean>): Promise<ExperimentCandidate['artifacts']> {
  const base = `candidates/${candidate.id}-${candidate.key.slice(0, 16)}`;
  const final = join(outputDir, base);
  const pending = `${final}.pending-${randomUUID()}`;
  const svg = Buffer.from(result.svg);
  const resultBytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  if ([svg, png, resultBytes].some(bytes => bytes.length > MAX_ARTIFACT_BYTES)) throw new Error('Experiment artifact exceeds 64 MiB');
  await mkdir(dirname(final), { recursive: true });
  await mkdir(pending);
  try {
    await Promise.all([writeFile(join(pending, 'render.svg'), svg), writeFile(join(pending, 'render.png'), png), writeFile(join(pending, 'result.json'), resultBytes)]);
    if (!(await verify())) throw new Error('Source or dependency inputs changed before artifact publication');
    const displaced = `${final}.replaced-${randomUUID()}`;
    let hadPrevious = false;
    try { await rename(final, displaced); hadPrevious = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(pending, final); }
    catch (error) { if (hadPrevious) await rename(displaced, final); throw error; }
    if (hadPrevious) await rm(displaced, { recursive: true, force: true });
    return { svg: `${base}/render.svg`, png: `${base}/render.png`, result: `${base}/result.json`,
      sha256: { svg: sha256(svg), png: sha256(png), result: sha256(resultBytes) } };
  } finally { await rm(pending, { recursive: true, force: true }); }
}

export async function runExperimentBatch(options: ExperimentBatchOptions): Promise<ExperimentManifest> {
  const matrix = structuredClone(options.matrix);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal;
  validate(matrix);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('Experiment render timeout must be between 1 and 60000 ms');
  const outputDir = resolve(options.outputDir);
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const sources = matrix.sources.map(source => ({ ...source, entry: resolve(baseDir, source.entry) }));
  const snapshots: Record<string, ExperimentInputFingerprint> = {};
  for (const source of sources) snapshots[source.id] = await fingerprintSketchInputs(source.entry, outputDir, timeoutMs);
  await mkdir(outputDir, { recursive: true });
  const lockPath = join(outputDir, '.experiment.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); await lock.writeFile(`${process.pid}\n`); }
  catch { throw new Error(`Experiment output is already in use; inspect ${lockPath}`); }
  try {
    const previous = await previousManifest(outputDir);
    const older = await previousManifest(outputDir, 'manifest.previous.json');
    const priorMap = new Map<string, ExperimentCandidate>();
    for (const candidate of [...(previous?.candidates ?? []), ...(older?.candidates ?? [])]) {
      const key = `${candidate.id}\0${candidate.key}`;
      if (candidate.status === 'success' && !priorMap.has(key)) priorMap.set(key, candidate);
    }
    const priorCandidates = [...priorMap.values()].slice(0, 128);
    if (previous) {
      let backup = Buffer.from(JSON.stringify({ ...previous, candidates: priorCandidates }, null, 2) + '\n');
      while (backup.length > MAX_MANIFEST_BYTES && priorCandidates.length) {
        priorCandidates.pop();
        backup = Buffer.from(JSON.stringify({ ...previous, candidates: priorCandidates }, null, 2) + '\n');
      }
      if (backup.length <= MAX_MANIFEST_BYTES) {
        const backupPending = join(outputDir, `.previous-${randomUUID()}.tmp`);
        try { await writeFile(backupPending, backup, { flag: 'wx' }); await rename(backupPending, join(outputDir, 'manifest.previous.json')); }
        finally { await rm(backupPending, { force: true }); }
      }
    }
    const manifest: ExperimentManifest = { version: 1, pipelineVersion: PIPELINE_VERSION, matrixSha256: sha256(stable(matrix)),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      matrix: structuredClone(matrix), status: 'running', sources: snapshots, candidates: [] };
    await saveManifest(outputDir, manifest);
    const stop = async (candidate: ExperimentCandidate, status: 'stale' | 'cancelled', message: string): Promise<never> => {
      candidate.status = status; candidate.error = message;
      manifest.candidates.push(candidate); manifest.status = 'stopped'; await saveManifest(outputDir, manifest);
      throw new Error(`${message}; see ${join(outputDir, 'manifest.json')}`);
    };
    const pngTheme = matrix.png?.theme ?? 'paper';
    const pngScale = matrix.png?.scale ?? 2;
    const allCurrent = async () => {
      try {
        for (const item of sources) if ((await fingerprintSketchInputs(item.entry, outputDir, timeoutMs)).fingerprint !== snapshots[item.id].fingerprint) return false;
        return true;
      } catch { return false; }
    };
    for (const source of sources) for (const regime of matrix.regimes) for (const seed of matrix.seeds) {
      const id = `${source.id}--${regime.id}--s${seed}`;
      const request = { params: regime.params, seed, ...(matrix.finishing === undefined ? {} : { finishing: matrix.finishing }) };
      const requestSha256 = sha256(stable(request));
      const key = sha256(stable({ pipelineVersion: PIPELINE_VERSION, id, entry: source.entry,
        sourceFingerprint: snapshots[source.id].fingerprint, requestSha256, pngTheme, pngScale }));
      const candidate: ExperimentCandidate = { id, sourceId: source.id, regimeId: regime.id, seed, entry: source.entry,
        key, request: structuredClone(request), requestSha256, sourceFingerprint: snapshots[source.id].fingerprint, status: 'failed' };
      if (signal?.aborted) await stop(candidate, 'cancelled', 'Experiment cancelled before render');
      if (!(await allCurrent())) {
        await stop(candidate, 'stale', 'Source or dependency inputs changed before render');
      }
      const prior = priorCandidates.find(item => item.id === id && item.key === key && item.status === 'success');
      if (prior && await reusable(outputDir, prior)) {
        if (signal?.aborted) await stop(candidate, 'cancelled', 'Experiment cancelled during resume validation');
        if (!(await allCurrent())) {
          await stop(candidate, 'stale', 'Source or dependency inputs changed during resume validation');
        }
        manifest.candidates.push({ ...prior, reused: true });
        await saveManifest(outputDir, manifest);
        continue;
      }
      let result: RenderResult | undefined;
      let failure: string | undefined;
      try { result = await renderSketch({ entry: source.entry, ...request, timeoutMs, signal }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      if (signal?.aborted) await stop(candidate, 'cancelled', 'Experiment cancelled during render');
      if (!(await allCurrent())) {
        await stop(candidate, 'stale', 'Source or dependency inputs changed during render');
      }
      if (failure || !result) { candidate.error = failure ?? 'Render returned no result'; manifest.candidates.push(candidate); await saveManifest(outputDir, manifest); continue; }
      try {
        const png = exportSketchPng(result, pngTheme, pngScale);
        candidate.artifacts = await writeCandidate(outputDir, candidate, result, png, async () => {
          if (signal?.aborted) throw new Error('Experiment cancelled');
          return allCurrent();
        });
        if (signal?.aborted) throw new Error('Experiment cancelled');
        if (!(await allCurrent())) throw new Error('Source or dependency inputs changed before artifact publication');
        candidate.identity = result.identity;
        candidate.status = 'success';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Experiment cancelled') await stop(candidate, 'cancelled', message);
        if (message.includes('inputs changed')) {
          await stop(candidate, 'stale', message);
        }
        candidate.error = message;
      }
      manifest.candidates.push(candidate);
      await saveManifest(outputDir, manifest);
    }
    if (signal?.aborted) { manifest.status = 'stopped'; await saveManifest(outputDir, manifest); throw new Error(`Experiment cancelled; see ${join(outputDir, 'manifest.json')}`); }
    if (!(await allCurrent())) {
      manifest.status = 'stopped'; await saveManifest(outputDir, manifest);
      throw new Error(`Source or dependency inputs changed before batch completion; see ${join(outputDir, 'manifest.json')}`);
    }
    manifest.status = 'complete';
    await saveManifest(outputDir, manifest);
    return manifest;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
