/**
 * Parameter-search harness for Prescribed Weather.
 *
 *   npx tsx sketches/cloud-advection/explore.ts <space.json> <outDir> [--top 12] [--jobs 4] [--png-scale 2] [--no-png]
 *   npx tsx sketches/cloud-advection/explore.ts <space.json> <outDir> --refine <candidateId> [--radius 0.15] [--n 24]
 *
 * space.json: { base: { seed, params, finishing }, n, seed, ranges: { paramId: [min, max] }, steps: [0, 30, 60] }
 *
 * `frameStart` and `frameDelta` are extra, non-control dimensions (integers, in sim
 * steps): a candidate's frames are start, start + delta, start + 2 delta, capped at
 * min(240, the sketch's `step` slider max) by a deterministic repair (shrink delta
 * toward its range minimum, then lower start). `steps` is the fallback when they are
 * not in `ranges`. `profile` selects the scoring profile (`default` or `precise`).
 *
 * Candidate c000 is the base params; c001..cNNN are n seeded Latin-hypercube points.
 * Each candidate is rendered at every step plus once with cloudEnabled false (the
 * concealment reference, cached per structure-defining params), measured by
 * aesthetics.ts, and appended to results.jsonl (re-running resumes: ids already
 * present with identical params are skipped). ranking.json lists feasible
 * candidates first by score. The top K are re-rendered to PNG with the CLI's own
 * exporter and laid out in contact-sheet.html. The score is a shortlisting proxy;
 * humans choose.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus } from 'node:os';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { exportSketchPng } from '../../cli/sketch/export-png.ts';
import { resolveFinishing } from '../../packages/plot-core/src/index.ts';
import type { FinishingOptions, Params } from '../../src/sketch/types.ts';
import sketch from './sketch.ts';
import { studyContext } from './evidence.ts';
import { buildStudy } from './study.ts';
import { vortexStateAt } from './sim.ts';
import { CORE_CENTER } from './layout.ts';
import {
  frameGeometry, frameMetrics, jaccardDistance, latinHypercube, occupancy, score, structureInkM, sunGeometry,
  type FrameMetrics, type ProfileId, type Score,
} from './aesthetics.ts';

const entry = resolve('sketches/cloud-advection/sketch.ts');

export interface Request { seed: number; params: Params; finishing?: FinishingOptions }
export interface Space {
  base: Request;
  n: number;
  seed: number;
  ranges: Record<string, [number, number]>;
  steps: number[];
  /** Scoring profile (aesthetics.ts PROFILES); default 'default'. Use 'precise' for the sun. */
  profile?: ProfileId;
}
export interface Candidate { id: string; params: Params; varied: Record<string, number>; steps: number[] }
export interface ResultRecord {
  id: string;
  params: Params;
  varied: Record<string, number>;
  steps: number[];
  profile?: ProfileId;
  metrics?: { frames: FrameMetrics[]; change01: number; change12: number };
  score?: Score;
  /** Sum of child-process render durations for this candidate, seconds. */
  renderSeconds?: number;
  /** Wall-clock seconds for this candidate (including waiting on the shared off-state render). */
  wallSeconds?: number;
  error?: string;
}

// Params that only affect the cloud (or how it is drawn). The off-state render
// ignores them, so they are dropped from its cache key; anything else (structure
// params, seed, finishing) stays in the key so a new structure control is safe.
const CLOUD_ONLY = new Set([
  'step', 'turbulence', 'drift', 'windX', 'windY', 'eddyX', 'eddyY', 'eddyCirculation', 'eddyCore', 'dispersion', 'boundary',
  'sourceX', 'sourceY', 'sourceSize', 'sourceEnabled', 'frontAmplitude', 'frontScale', 'frontCoverage', 'fillInterior',
  'referenceDensity', 'cloudHatchPitch', 'markStyle', 'cloudPen', 'streakPen', 'streakSpacing', 'obscure',
  'coreRadius', 'coreX', 'coreY', 'cloudEnabled',
  'eddyDrift', 'trainEnabled', 'trainPeriod', 'trainCirculation', 'trainCore', 'trainAlternate', 'trainJitter',
]);

const stable = (value: unknown): string => JSON.stringify(value, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Non-control search dimensions: integer frame timing, in simulation steps. */
export const FRAME_DIMS = ['frameStart', 'frameDelta'] as const;
const isFrameDim = (id: string) => (FRAME_DIMS as readonly string[]).includes(id);
/** Latest frame the harness may ask for: 240, or the sketch's own `step` slider max if lower. */
export function stepCap(): number {
  const control = sketch.controls.find(c => c.id === 'step');
  return Math.min(240, control && control.type === 'slider' ? control.max : 240);
}

/** Snap to the slider's step grid and range (the runner rejects unaligned values); frame dims snap to integers. */
export function snapToControl(id: string, value: number): number {
  if (isFrameDim(id)) return Math.round(value);
  const control = sketch.controls.find(c => c.id === id);
  if (!control || control.type !== 'slider') throw new Error(`Range parameter ${id} is not a slider control of the sketch`);
  const clamped = Math.min(control.max, Math.max(control.min, value));
  const snapped = control.min + Math.round((clamped - control.min) / control.step) * control.step;
  return Math.min(control.max, Math.max(control.min, Number(snapped.toFixed(6))));
}

/** Range clamped to the slider's own min/max; frame ranges are clamped jointly so start + 2 delta can fit under the cap. */
export function clampRange(id: string, range: [number, number], all: Record<string, [number, number]> = {}): [number, number] {
  if (isFrameDim(id)) {
    const cap = stepCap();
    const delta = all.frameDelta ?? [1, Math.floor(cap / 2)];
    const dlo = Math.max(1, Math.round(delta[0]));
    if (id === 'frameDelta') return [dlo, Math.min(Math.round(range[1]), Math.floor(cap / 2))];
    return [Math.max(0, Math.round(range[0])), Math.min(Math.round(range[1]), cap - 2 * dlo)];
  }
  const control = sketch.controls.find(c => c.id === id);
  if (!control || control.type !== 'slider') throw new Error(`Range parameter ${id} is not a slider control of the sketch`);
  return [Math.max(control.min, range[0]), Math.min(control.max, range[1])];
}

/** Frames for a start and delta, repaired deterministically to fit the cap: delta shrinks toward `minDelta` first, then start drops. */
export function repairFrames(start: number, delta: number, minDelta = 1): { start: number; delta: number; steps: number[] } {
  const cap = stepCap();
  let d = Math.max(minDelta, delta);
  let st = Math.max(0, start);
  if (st + 2 * d > cap) d = Math.max(minDelta, Math.floor((cap - st) / 2));
  if (st + 2 * d > cap) st = cap - 2 * d;
  return { start: st, delta: d, steps: [st, st + d, st + 2 * d] };
}

function clampAll(ranges: Record<string, [number, number]>): Record<string, [number, number]> {
  return Object.fromEntries(Object.entries(ranges).map(([id, r]) => [id, clampRange(id, r, ranges)]));
}

export function buildCandidates(space: Space, prefix = 'c'): Candidate[] {
  const ids = Object.keys(space.ranges);
  const clamped = clampAll(space.ranges);
  const baseSteps = space.steps;
  const baseVaried = Object.fromEntries(ids.map(id => [id,
    id === 'frameStart' ? baseSteps[0] : id === 'frameDelta' ? baseSteps[1] - baseSteps[0]
      : Number(space.base.params[id] ?? sketch.controls.find(c => c.id === id)?.default)]));
  const out: Candidate[] = [{ id: `${prefix}000`, params: { ...space.base.params }, varied: baseVaried, steps: [...baseSteps] }];
  latinHypercube(space.n, ids.length, space.seed).forEach((point, i) => {
    const varied: Record<string, number> = {};
    ids.forEach((id, d) => { varied[id] = snapToControl(id, clamped[id][0] + point[d] * (clamped[id][1] - clamped[id][0])); });
    let steps = [...baseSteps];
    if ('frameStart' in varied || 'frameDelta' in varied) {
      const fr = repairFrames(varied.frameStart ?? baseSteps[0], varied.frameDelta ?? baseSteps[1] - baseSteps[0], clamped.frameDelta?.[0] ?? 1);
      if ('frameStart' in varied) varied.frameStart = fr.start;
      if ('frameDelta' in varied) varied.frameDelta = fr.delta;
      steps = fr.steps;
    }
    const params = { ...space.base.params, ...Object.fromEntries(Object.entries(varied).filter(([id]) => !isFrameDim(id))) };
    out.push({ id: `${prefix}${String(i + 1).padStart(3, '0')}`, params, varied, steps });
  });
  return out;
}

function readResults(path: string): Map<string, ResultRecord> {
  const map = new Map<string, ResultRecord>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as ResultRecord;
    map.set(record.id, record);
  }
  return map;
}

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

interface RunContext { space: Space; jobs: number; offCache: Map<string, Promise<number>> }

async function evaluate(candidate: Candidate, ctx: RunContext): Promise<ResultRecord> {
  const { space } = ctx;
  const started = Date.now();
  const finishing = resolveFinishing(sketch.page, sketch.pens, space.base.finishing ?? {});
  const study = buildStudy(studyContext({ seed: space.base.seed, params: candidate.params }));
  const geometry = frameGeometry(sketch.page, finishing, candidate.params);
  const sunLayout = study.layout === 'sun';
  if (sunLayout) geometry.sun = sunGeometry(study.config.transforms.worldToPage, finishing, candidate.params, CORE_CENTER);
  const timeoutMs = 180_000;
  const request = { entry, seed: space.base.seed, finishing: space.base.finishing, timeoutMs };
  let renderSeconds = 0;
  const offKey = stable(Object.fromEntries(Object.entries(candidate.params).filter(([id]) => !CLOUD_ONLY.has(id))));
  let off = ctx.offCache.get(offKey);
  if (!off) {
    off = renderSketch({ ...request, params: { ...candidate.params, cloudEnabled: false } }).then(result => {
      renderSeconds += result.durationMs / 1000;
      return structureInkM(result.parts);
    });
    ctx.offCache.set(offKey, off);
  }
  const offInk = await off;
  const frames: FrameMetrics[] = [];
  const grids: Set<number>[] = [];
  const pitch = Number(candidate.params.cloudHatchPitch ?? 2);
  for (const step of candidate.steps) {
    const result = await renderSketch({ ...request, params: { ...candidate.params, step } });
    renderSeconds += result.durationMs / 1000;
    const metrics = frameMetrics({ parts: result.parts, geometry, cloudHatchPitch: pitch }, offInk);
    if (sunLayout) {
      // Report only: nearest active train eddy to the sun centre, in metres.
      const trains = vortexStateAt(study.config, step).filter(v => v.key.startsWith('train-'));
      metrics.eddyNear = trains.length ? Math.min(...trains.map(v => Math.hypot(v.center.x - CORE_CENTER.x, v.center.y - CORE_CENTER.y))) : null;
    }
    frames.push(metrics);
    grids.push(occupancy(result.parts, geometry.content));
  }
  const metrics = { frames, change01: jaccardDistance(grids[0], grids[1]), change12: jaccardDistance(grids[1], grids[2]) };
  const profile = space.profile ?? 'default';
  return {
    id: candidate.id, params: candidate.params, varied: candidate.varied, steps: candidate.steps, profile, metrics, score: score(metrics, profile),
    renderSeconds: Number(renderSeconds.toFixed(2)), wallSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
  };
}

export function rank(records: ResultRecord[]): ResultRecord[] {
  return records.filter(r => r.score).sort((a, b) => {
    if (a.score!.feasible !== b.score!.feasible) return a.score!.feasible ? -1 : 1;
    if (!a.score!.feasible && a.score!.violations.length !== b.score!.violations.length) return a.score!.violations.length - b.score!.violations.length;
    return b.score!.desirability - a.score!.desirability;
  });
}

const f = (n: number, digits = 3) => Number(n.toFixed(digits));

export function summaryRow(record: ResultRecord, rank: number) {
  const m = record.metrics!;
  const range = (pick: (fm: FrameMetrics) => number, digits = 3) => m.frames.map(fm => f(pick(fm), digits));
  return {
    rank, id: record.id, steps: record.steps, feasible: record.score!.feasible, score: f(record.score!.desirability),
    violations: record.score!.violations,
    ropeIndex: range(x => x.ropeIndex), spacingCV: range(x => x.spacingCV), frameContact: range(x => x.frameContact),
    coreHalo: range(x => x.coreHalo), concealment: range(x => x.concealment), balance: range(x => x.balance),
    fill: range(x => x.fill, 1), coherence: range(x => x.coherence, 0), largestShare: range(x => x.largestShare, 2),
    interiorInk: range(x => x.interiorInk ?? 0, 1), eddyNear: m.frames.map(fm => (fm.eddyNear == null ? null : f(fm.eddyNear, 1))), cloudInkM: range(x => x.cloudInkM, 2), points: range(x => x.points, 0),
    change01: f(m.change01), change12: f(m.change12), parts: Object.fromEntries(Object.entries(record.score!.parts).map(([k, v]) => [k, f(v)])),
    varied: record.varied,
  };
}

async function renderPngs(records: ResultRecord[], space: Space, dir: string, scale: number, jobs: number): Promise<void> {
  mkdirSync(join(dir, 'png'), { recursive: true });
  const todo = records.flatMap(record => record.steps.map(step => ({ record, step })))
    .filter(({ record, step }) => !existsSync(join(dir, 'png', `${record.id}-s${String(step).padStart(2, '0')}.png`)));
  await pool(todo, jobs, async ({ record, step }) => {
    const result = await renderSketch({ entry, seed: space.base.seed, finishing: space.base.finishing, params: { ...record.params, step }, timeoutMs: 180_000 });
    writeFileSync(join(dir, 'png', `${record.id}-s${String(step).padStart(2, '0')}.png`), exportSketchPng(result, 'paper', scale));
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function contactSheet(records: ResultRecord[], title: string): string {
  const rows = records.map((record, i) => {
    const row = summaryRow(record, i + 1);
    const imgs = record.steps.map(step => `<figure><img loading="lazy" src="png/${record.id}-s${String(step).padStart(2, '0')}.png" alt="${record.id} step ${step}"><figcaption>step ${step}</figcaption></figure>`).join('');
    const metric = (label: string, v: number[] | number | string) => `<tr><th>${label}</th><td>${Array.isArray(v) ? v.join(' / ') : v}</td></tr>`;
    const params = Object.entries(row.varied).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
    return `<section class="${row.feasible ? '' : 'infeasible'}"><h2>#${row.rank} ${esc(record.id)} <small>steps ${record.steps.join(' / ')} · score ${row.score} ${row.feasible ? 'feasible' : 'INFEASIBLE'}</small></h2>
<div class="frames">${imgs}</div>
<div class="tables"><table>${metric('ropeIndex', row.ropeIndex)}${metric('spacingCV', row.spacingCV)}${metric('frameContact', row.frameContact)}${metric('coreHalo', row.coreHalo)}${metric('concealment', row.concealment)}${metric('balance', row.balance)}${metric('fill', row.fill)}${metric('coherence', row.coherence)}${metric('largestShare', row.largestShare)}${row.interiorInk.some(v => v > 0) ? metric('interiorInk', row.interiorInk) + metric('eddyNear m', row.eddyNear.map(v => v ?? '-').join(' / ')) : ''}${metric('ink m', row.cloudInkM)}${metric('points', row.points)}${metric('change 0-30 / 30-60', [row.change01, row.change12])}</table>
<table>${params}</table>${row.violations.length ? `<p class="v">${row.violations.map(esc).join('<br>')}</p>` : ''}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#f2f0ea;color:#222}h1{font-size:18px}h2{font-size:15px;margin:24px 0 6px}small{font-weight:400;color:#666}
.frames{display:flex;gap:8px}figure{margin:0;flex:1 1 0;min-width:0}img{width:100%;height:auto;background:#fff;box-shadow:0 1px 4px #0003}figcaption{text-align:center;color:#666;font-size:11px}
.tables{display:flex;gap:24px;flex-wrap:wrap;margin-top:6px}table{border-collapse:collapse}th{text-align:left;padding:1px 10px 1px 0;font-weight:500;color:#555}td{font-variant-numeric:tabular-nums}
.infeasible h2{color:#a33}.v{color:#a33;margin:0}p.note{max-width:70ch;color:#555}</style></head><body><h1>${esc(title)}</h1>
<p class="note">Metric triples are the three frames of each row (steps shown per candidate). The score is a proxy for shortlisting; humans choose.</p>${rows}</body></html>`;
}

async function runSet(space: Space, candidates: Candidate[], dir: string, opts: { top: number; jobs: number; pngScale: number; png: boolean; title: string }): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const resultsPath = join(dir, 'results.jsonl');
  const existing = readResults(resultsPath);
  const todo = candidates.filter(c => {
    const prior = existing.get(c.id);
    return !(prior && !prior.error && stable(prior.params) === stable(c.params) && stable(prior.steps) === stable(c.steps) && (prior.profile ?? 'default') === (space.profile ?? 'default'));
  });
  console.log(`${candidates.length} candidates, ${candidates.length - todo.length} already done, ${todo.length} to run (jobs ${opts.jobs})`);
  const ctx: RunContext = { space, jobs: opts.jobs, offCache: new Map() };
  const batchStart = Date.now();
  let done = 0;
  await pool(todo, opts.jobs, async candidate => {
    let record: ResultRecord;
    try { record = await evaluate(candidate, ctx); }
    catch (error) { record = { id: candidate.id, params: candidate.params, varied: candidate.varied, steps: candidate.steps, error: error instanceof Error ? error.message : String(error) }; }
    appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);
    existing.set(record.id, record);
    done++;
    console.log(`[${done}/${todo.length}] ${record.id} ${record.error ? `ERROR ${record.error}` : `score ${f(record.score!.desirability)} ${record.score!.feasible ? 'feasible' : `infeasible (${record.score!.violations.length})`} ${record.wallSeconds}s wall / ${record.renderSeconds}s render`}`);
  });
  const batchSeconds = (Date.now() - batchStart) / 1000;
  const current = candidates.map(c => existing.get(c.id)).filter((r): r is ResultRecord => !!r);
  const ranked = rank(current);
  writeFileSync(join(dir, 'ranking.json'), `${JSON.stringify(ranked.map((r, i) => summaryRow(r, i + 1)), null, 2)}\n`);
  const timed = current.filter(r => r.renderSeconds !== undefined);
  const summary = {
    candidates: candidates.length, evaluated: current.filter(r => r.score).length, errors: current.filter(r => r.error).length,
    feasible: ranked.filter(r => r.score!.feasible).length, infeasible: ranked.filter(r => !r.score!.feasible).length,
    jobs: opts.jobs, batchWallSeconds: f(batchSeconds, 1), ranThisRun: todo.length,
    wallSecondsPerCandidateThisRun: todo.length ? f(batchSeconds / todo.length, 2) : null,
    meanRenderSecondsPerCandidate: timed.length ? f(timed.reduce((s, r) => s + r.renderSeconds!, 0) / timed.length, 2) : null,
    violationCounts: Object.fromEntries([...new Set(ranked.flatMap(r => r.score!.violations.map(v => v.replace(/^frame \d+: /, '').split(' ')[0])))]
      .map(k => [k, ranked.filter(r => r.score!.violations.some(v => v.replace(/^frame \d+: /, '').startsWith(k))).length])),
  };
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  const top = ranked.slice(0, opts.top);
  if (opts.png && top.length) {
    const pngStart = Date.now();
    await renderPngs(top, space, dir, opts.pngScale, opts.jobs);
    console.log(`PNGs for top ${top.length}: ${f((Date.now() - pngStart) / 1000, 1)} s`);
    writeFileSync(join(dir, 'contact-sheet.html'), contactSheet(top, opts.title));
    console.log(`contact sheet: ${join(dir, 'contact-sheet.html')}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (argv[i] !== '--no-png') i++; } else positional.push(argv[i]);
  }
  const [spacePath, outDir] = positional;
  if (!spacePath || !outDir) throw new Error('usage: explore.ts <space.json> <outDir> [--top K] [--jobs J] [--png-scale S] [--no-png] [--refine <id> --radius R --n N]');
  const space = JSON.parse(readFileSync(spacePath, 'utf8')) as Space;
  space.steps ??= [0, 30, 60];
  const top = Number(flag(argv, '--top') ?? 12);
  const jobs = Number(flag(argv, '--jobs') ?? Math.max(1, Math.min(4, cpus().length - 2)));
  const pngScale = Number(flag(argv, '--png-scale') ?? 2);
  const png = !argv.includes('--no-png');
  const out = resolve(outDir);
  const refine = flag(argv, '--refine');
  if (!refine) {
    await runSet(space, buildCandidates(space), out, { top, jobs, pngScale, png, title: `Prescribed Weather search: ${spacePath}` });
    return;
  }
  const radius = Number(flag(argv, '--radius') ?? 0.15);
  const n = Number(flag(argv, '--n') ?? 24);
  const center = readResults(join(out, 'results.jsonl')).get(refine);
  if (!center) throw new Error(`Candidate ${refine} not found in ${join(out, 'results.jsonl')}`);
  const ranges: Record<string, [number, number]> = {};
  const global = clampAll(space.ranges);
  for (const id of Object.keys(space.ranges)) {
    const [lo, hi] = global[id];
    const c = Number(center.varied[id] ?? center.params[id]);
    ranges[id] = [Math.max(lo, c - radius * (hi - lo)), Math.min(hi, c + radius * (hi - lo))];
  }
  // Deterministic per candidate: the local hypercube seed derives from the space seed and the id.
  const idSeed = [...refine].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const local: Space = { ...space, steps: center.steps, base: { ...space.base, params: { ...center.params } }, ranges, n, seed: (space.seed + idSeed) >>> 0 };
  await runSet(local, buildCandidates(local, `${refine}.r`), join(out, `refine-${refine}`), { top, jobs, pngScale, png, title: `Refinement of ${refine} (radius ${radius}, n ${n})` });
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
