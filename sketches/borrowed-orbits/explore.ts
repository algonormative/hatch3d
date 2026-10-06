/**
 * Parameter-search harness for Borrowed Orbits.
 *
 *   npx tsx sketches/borrowed-orbits/explore.ts <space.json> <outDir> [--top 12] [--jobs 4] [--png-scale 2] [--no-png]
 *   npx tsx sketches/borrowed-orbits/explore.ts <space.json> <outDir> --refine <candidateId> [--radius 0.15] [--n 24] [--from <dir>]
 *
 * space.json: { base: { seed, params, finishing }, n, seed, ranges: { paramId: [min, max] },
 *               categorical?: { paramId: [value, ...] }, steps: [300, 600, 900] }
 *
 * `frameStart` and `frameDelta` are extra, non-control dimensions (integers, in sim steps): a candidate's frames are
 * start, start + delta, start + 2 delta, capped at the sketch's `step` slider max (2400) by a deterministic repair
 * (shrink delta toward its range minimum, then lower start). `categorical` adds a Latin-hypercube dimension that
 * picks one of the listed values of a select control (forbiddenLayout). `sweep: { param, values }` replaces the
 * hypercube with one candidate per value (ids w00, w01, ...). `steps` is the fallback when frame dims are not in
 * `ranges`.
 *
 * Candidate c000 is the base params; c001..cNNN are n seeded Latin-hypercube points. Each candidate is rendered at
 * every step and measured by aesthetics.ts (the sim is also run for the break count), and appended to results.jsonl
 * (re-running resumes: ids already present with an identical full-request sha256 key are skipped). ranking.json lists
 * feasible candidates first by score. The top K are re-rendered to PNG with the CLI's own exporter and laid out in
 * contact-sheet.html. The score is a shortlisting proxy; humans choose.
 *
 * Ledger against sketches/cloud-advection/explore.ts (explore.ts there guards main(), so importing it is safe):
 * - IMPORTED UNCHANGED: `FRAME_DIMS`, `LIMITS_EXPLORE`, `parseIntFlag`, `requestKey` (a sha256 over seed, finishing,
 *   params, steps, profile and the sketch source stamp), `pendingCandidates` (resume by request key), and the
 *   `Space` and `Candidate` types (extended below). From aesthetics.ts: `latinHypercube` (see
 *   aesthetics.ts for the metric pieces). From the repo CLI: `renderSketch`, `sourceStamp`, `exportSketchPng`.
 * - COPIED AND ADAPTED: `stepCap`, `snapToControl`, `clampRange`, `repairFrames`, `validateSpace`, `buildCandidates`
 *   (cloud's bind to the CLOUD sketch's controls and cap the frame at 240 steps, so they cannot be shared until they
 *   take the sketch and the cap as arguments; here they also gain the categorical dimension), `evaluate` (trail metrics
 *   and a sim call for breaks instead of cloud metrics and an off-state structure render), `rank`, `summaryRow`,
 *   `contactSheet` (their types and columns are cloud's FrameMetrics; `rank` would be shareable if it were generic over
 *   records that carry a `score`), `runSet`, `renderPngs`, `main`.
 * - COPIED VERBATIM, because not exported: `pool`, `readResults`, `flag`, `stable`, `esc`, `f`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { exportSketchPng } from '../../cli/sketch/export-png.ts';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { sourceStamp } from '../../cli/sketch/source-stamp.ts';
import { resolveFinishing } from '../../packages/plot-core/src/index.ts';
import { latinHypercube } from '../cloud-advection/aesthetics.ts';
import { FRAME_DIMS, LIMITS_EXPLORE, parseIntFlag, pendingCandidates, requestKey } from '../cloud-advection/explore.ts';
import type { Candidate as CloudCandidate, Space as CloudSpace } from '../cloud-advection/explore.ts';
import { breakCount, frameMetrics, jaccardDistance, score, trailGeometry, trailOccupancy } from './aesthetics.ts';
import type { Score, TrailMetrics } from './aesthetics.ts';
import { studyContext } from './evidence.ts';
import { LIMITS as SIM_LIMITS } from './model.ts';
import { simulate } from './sim.ts';
import sketch from './sketch.ts';
import { buildStudy } from './study.ts';
import type { Params } from '../../src/sketch/types.ts';

const entry = resolve('sketches/borrowed-orbits/sketch.ts');

export interface Space extends CloudSpace {
  /** Select controls searched as categories: one hypercube dimension each, picking a value. */
  categorical?: Record<string, string[]>;
}
export interface Candidate extends CloudCandidate { /** Chosen category per categorical control (also in params). */ categories?: Record<string, string> }
export interface ResultRecord {
  id: string;
  params: Params;
  varied: Record<string, number>;
  categories?: Record<string, string>;
  steps: number[];
  requestKey?: string;
  metrics?: { frames: TrailMetrics[]; change01: number; change12: number };
  score?: Score;
  renderSeconds?: number;
  wallSeconds?: number;
  error?: string;
}

const isFrameDim = (id: string): boolean => (FRAME_DIMS as readonly string[]).includes(id);
/** Latest frame the harness may ask for: the sketch's own `step` slider max. */
export function stepCap(): number {
  const control = sketch.controls.find(c => c.id === 'step');
  return control && control.type === 'slider' ? control.max : SIM_LIMITS.maxSteps;
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

const integerIn = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** Validate a space.json before anything is allocated or rendered. Throws a clear error. */
export function validateSpace(space: Space): void {
  if (!space || typeof space !== 'object' || !space.base || typeof space.base !== 'object') throw new Error('space.base is required');
  if (!Number.isSafeInteger(space.base.seed) || space.base.seed < 0) throw new Error('space.base.seed must be a nonnegative integer');
  if (!space.base.params || typeof space.base.params !== 'object') throw new Error('space.base.params is required');
  if (!Number.isSafeInteger(space.seed) || space.seed < 0) throw new Error(`space.seed must be a nonnegative integer, got ${JSON.stringify(space.seed)}`);
  if (!Array.isArray(space.steps) || space.steps.length !== 3) throw new Error('space.steps must be three frame steps');
  space.steps.forEach((step, i) => integerIn(`space.steps[${i}]`, step, 0, stepCap()));
  if (space.sweep) {
    const { param, values } = space.sweep;
    if (typeof param !== 'string' || !param) throw new Error('space.sweep.param must be a control id');
    if (!Array.isArray(values) || values.length < 1 || values.length > LIMITS_EXPLORE.maxSweep) {
      throw new Error(`space.sweep.values must be an array of 1 to ${LIMITS_EXPLORE.maxSweep} numbers`);
    }
    values.forEach((v, i) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`space.sweep.values[${i}] must be a finite number`); });
    return;
  }
  integerIn('space.n', space.n, 0, LIMITS_EXPLORE.maxN);
  if (!space.ranges || typeof space.ranges !== 'object') throw new Error('space.ranges is required');
  for (const [id, range] of Object.entries(space.ranges)) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(v => typeof v === 'number' && Number.isFinite(v)) || range[0] > range[1]) {
      throw new Error(`space.ranges.${id} must be [min, max] with finite min <= max`);
    }
  }
  for (const [id, values] of Object.entries(space.categorical ?? {})) {
    const control = sketch.controls.find(c => c.id === id);
    if (!control || control.type !== 'select') throw new Error(`space.categorical.${id} is not a select control of the sketch`);
    if (!Array.isArray(values) || values.length < 1 || values.some(v => !control.options.includes(v))) throw new Error(`space.categorical.${id} must list options of the control`);
  }
}

export function buildCandidates(space: Space, prefix = 'c'): Candidate[] {
  validateSpace(space);
  if (space.sweep) {
    const { param, values } = space.sweep;
    const width = String(values.length - 1).length;
    return values.map((value, i) => ({
      id: `w${String(i).padStart(width, '0')}`,
      params: { ...space.base.params, [param]: value },
      varied: { [param]: value },
      steps: [...space.steps],
    }));
  }
  const ids = Object.keys(space.ranges);
  const catIds = Object.keys(space.categorical ?? {});
  const clamped = clampAll(space.ranges);
  const baseSteps = space.steps;
  const baseVaried = Object.fromEntries(ids.map(id => [id,
    id === 'frameStart' ? baseSteps[0] : id === 'frameDelta' ? baseSteps[1] - baseSteps[0]
      : Number(space.base.params[id] ?? sketch.controls.find(c => c.id === id)?.default)]));
  const baseCategories = Object.fromEntries(catIds.map(id => [id, String(space.base.params[id] ?? (sketch.controls.find(c => c.id === id) as { default: string }).default)]));
  const out: Candidate[] = [{ id: `${prefix}000`, params: { ...space.base.params }, varied: baseVaried, steps: [...baseSteps], ...(catIds.length ? { categories: baseCategories } : {}) }];
  latinHypercube(space.n, ids.length + catIds.length, space.seed).forEach((point, i) => {
    const varied: Record<string, number> = {};
    ids.forEach((id, d) => { varied[id] = snapToControl(id, clamped[id][0] + point[d] * (clamped[id][1] - clamped[id][0])); });
    const categories: Record<string, string> = {};
    catIds.forEach((id, d) => {
      const values = space.categorical![id];
      categories[id] = values[Math.min(values.length - 1, Math.floor(point[ids.length + d] * values.length))];
    });
    let steps = [...baseSteps];
    if ('frameStart' in varied || 'frameDelta' in varied) {
      const fr = repairFrames(varied.frameStart ?? baseSteps[0], varied.frameDelta ?? baseSteps[1] - baseSteps[0], clamped.frameDelta?.[0] ?? 1);
      if ('frameStart' in varied) varied.frameStart = fr.start;
      if ('frameDelta' in varied) varied.frameDelta = fr.delta;
      steps = fr.steps;
    }
    const params = { ...space.base.params, ...Object.fromEntries(Object.entries(varied).filter(([id]) => !isFrameDim(id))), ...categories };
    out.push({ id: `${prefix}${String(i + 1).padStart(3, '0')}`, params, varied, steps, ...(catIds.length ? { categories } : {}) });
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

interface RunContext { space: Space; keys: Map<string, string> }

async function evaluate(candidate: Candidate, ctx: RunContext): Promise<ResultRecord> {
  const { space } = ctx;
  const started = Date.now();
  const finishing = resolveFinishing(sketch.page, sketch.pens, space.base.finishing ?? {});
  const study = buildStudy(studyContext({ seed: space.base.seed, params: candidate.params }));
  const geometry = trailGeometry(study, finishing);
  const request = { entry, seed: space.base.seed, finishing: space.base.finishing, timeoutMs: 180_000 };
  let renderSeconds = 0;
  const frames: TrailMetrics[] = [];
  const grids: Set<number>[] = [];
  for (const step of candidate.steps) {
    const result = await renderSketch({ ...request, params: { ...candidate.params, step } });
    renderSeconds += result.durationMs / 1000;
    // The break count needs the particles' stop reasons, which a render does not carry: one cheap simulate call.
    const snapshot = simulate(study.config, [step])[0];
    frames.push(frameMetrics({ parts: result.parts, geometry, breaks: breakCount(study, snapshot, Math.max(0, step - study.marks.trailSteps)) }));
    grids.push(trailOccupancy(result.parts, geometry.content));
  }
  const metrics = { frames, change01: jaccardDistance(grids[0], grids[1]), change12: jaccardDistance(grids[1], grids[2]) };
  return {
    id: candidate.id, params: candidate.params, varied: candidate.varied, ...(candidate.categories ? { categories: candidate.categories } : {}),
    steps: candidate.steps, requestKey: ctx.keys.get(candidate.id), metrics, score: score(metrics),
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

const f = (n: number, digits = 3): number => Number(n.toFixed(digits));

export function summaryRow(record: ResultRecord, rankIndex: number) {
  const m = record.metrics!;
  const range = (pick: (fm: TrailMetrics) => number, digits = 3): number[] => m.frames.map(fm => f(pick(fm), digits));
  return {
    rank: rankIndex, id: record.id, steps: record.steps, feasible: record.score!.feasible, score: f(record.score!.desirability),
    violations: record.score!.violations,
    guideAdherence: range(x => x.guideAdherence), breakCount: range(x => x.breakCount, 0), kinkiness: range(x => x.kinkiness),
    escapeShare: range(x => x.escapeShare), ropeIndex: range(x => x.ropeIndex), frameContact: range(x => x.frameContact),
    balance: range(x => x.balance), fill: range(x => x.fill, 1), inkM: range(x => x.inkM, 2), points: range(x => x.points, 0),
    change01: f(m.change01), change12: f(m.change12), parts: Object.fromEntries(Object.entries(record.score!.parts).map(([k, v]) => [k, f(v)])),
    varied: { ...record.varied, ...(record.categories ?? {}) } as Record<string, number | string>,
  };
}

async function renderPngs(records: ResultRecord[], space: Space, dir: string, scale: number, jobs: number): Promise<void> {
  mkdirSync(join(dir, 'png'), { recursive: true });
  const name = (record: ResultRecord, step: number): string => join(dir, 'png', `${record.id}-s${String(step).padStart(4, '0')}.png`);
  const todo = records.flatMap(record => record.steps.map(step => ({ record, step }))).filter(({ record, step }) => !existsSync(name(record, step)));
  await pool(todo, jobs, async ({ record, step }) => {
    const result = await renderSketch({ entry, seed: space.base.seed, finishing: space.base.finishing, params: { ...record.params, step }, timeoutMs: 180_000 });
    writeFileSync(name(record, step), exportSketchPng(result, 'paper', scale));
  });
}

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function contactSheet(records: ResultRecord[], title: string): string {
  const rows = records.map((record, i) => {
    const row = summaryRow(record, i + 1);
    const imgs = record.steps.map(step => `<figure><img loading="lazy" src="png/${record.id}-s${String(step).padStart(4, '0')}.png" alt="${record.id} step ${step}"><figcaption>step ${step}</figcaption></figure>`).join('');
    const metric = (label: string, v: number[] | number | string): string => `<tr><th>${label}</th><td>${Array.isArray(v) ? v.join(' / ') : v}</td></tr>`;
    const params = Object.entries(row.varied).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
    return `<section class="${row.feasible ? '' : 'infeasible'}"><h2>#${row.rank} ${esc(record.id)} <small>steps ${record.steps.join(' / ')} · score ${row.score} ${row.feasible ? 'feasible' : 'INFEASIBLE'}</small></h2>
<div class="frames">${imgs}</div>
<div class="tables"><table>${metric('guideAdherence', row.guideAdherence)}${metric('breakCount', row.breakCount)}${metric('kinkiness', row.kinkiness)}${metric('escapeShare', row.escapeShare)}${metric('ropeIndex', row.ropeIndex)}${metric('frameContact', row.frameContact)}${metric('balance', row.balance)}${metric('fill', row.fill)}${metric('ink m', row.inkM)}${metric('points', row.points)}${metric('change 0-1 / 1-2', [row.change01, row.change12])}</table>
<table>${params}</table>${row.violations.length ? `<p class="v">${row.violations.map(esc).join('<br>')}</p>` : ''}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#f2f0ea;color:#222}h1{font-size:18px}h2{font-size:15px;margin:24px 0 6px}small{font-weight:400;color:#666}
.frames{display:flex;gap:8px}figure{margin:0;flex:1 1 0;min-width:0}img{width:100%;height:auto;background:#fff;box-shadow:0 1px 4px #0003}figcaption{text-align:center;color:#666;font-size:11px}
.tables{display:flex;gap:24px;flex-wrap:wrap;margin-top:6px}table{border-collapse:collapse}th{text-align:left;padding:1px 10px 1px 0;font-weight:500;color:#555}td{font-variant-numeric:tabular-nums}
.infeasible h2{color:#a33}.v{color:#a33;margin:0}p.note{max-width:70ch;color:#555}</style></head><body><h1>${esc(title)}</h1>
<p class="note">Metric triples are the three frames of each row (steps shown per candidate). guideAdherence: share of ink within 1.5 mm of a guide. breakCount: trails ending at a forbidden region or capture in the frame. kinkiness: share of long paths with a sharp turn. escapeShare: ink in straight escaping runs. The score is a proxy for shortlisting; humans choose.</p>${rows}</body></html>`;
}

async function runSet(space: Space, candidates: Candidate[], dir: string, opts: { top: number; jobs: number; pngScale: number; png: boolean; title: string }): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const resultsPath = join(dir, 'results.jsonl');
  const existing = readResults(resultsPath);
  let source = 'unstamped';
  try { source = await sourceStamp(entry, {}); } catch { source = `unstamped-${Date.now()}`; }
  const keys = new Map(candidates.map(c => [c.id, requestKey(space, c, source)]));
  const todo = pendingCandidates(candidates, existing as never, keys) as Candidate[];
  console.log(`${candidates.length} candidates, ${candidates.length - todo.length} already done, ${todo.length} to run (jobs ${opts.jobs})`);
  const ctx: RunContext = { space, keys };
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
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

export async function main(argv: string[]): Promise<void> {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (argv[i] !== '--no-png') i++; } else positional.push(argv[i]);
  }
  const [spacePath, outDir] = positional;
  if (!spacePath || !outDir) throw new Error('usage: explore.ts <space.json> <outDir> [--top K] [--jobs J] [--png-scale S] [--no-png] [--refine <id> --radius R --n N]');
  const space = JSON.parse(readFileSync(spacePath, 'utf8')) as Space;
  space.steps ??= [300, 600, 900];
  validateSpace(space);
  const top = parseIntFlag('--top', flag(argv, '--top'), 12, 0, LIMITS_EXPLORE.maxTop);
  const jobs = parseIntFlag('--jobs', flag(argv, '--jobs'), Math.max(1, Math.min(4, cpus().length - 2)), 1, LIMITS_EXPLORE.maxJobs);
  const pngScale = parseIntFlag('--png-scale', flag(argv, '--png-scale'), 2, 1, 8);
  const png = !argv.includes('--no-png');
  // `--n` overrides space.n for a plain run (the smoke test); with --refine it is the local hypercube size.
  const nFlag = flag(argv, '--n');
  const out = resolve(outDir);
  const refine = flag(argv, '--refine');
  if (!refine) {
    if (nFlag !== undefined) space.n = parseIntFlag('--n', nFlag, space.n, 0, LIMITS_EXPLORE.maxN);
    await runSet(space, buildCandidates(space), out, { top, jobs, pngScale, png, title: `Borrowed Orbits search: ${spacePath}` });
    return;
  }
  const radius = Number(flag(argv, '--radius') ?? 0.15);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 1) throw new Error(`--radius must be a number in (0, 1], got '${flag(argv, '--radius')}'`);
  const n = parseIntFlag('--n', nFlag, 24, 0, LIMITS_EXPLORE.maxN);
  const from = flag(argv, '--from');
  const fromPath = join(from ? resolve(from) : out, 'results.jsonl');
  const center = readResults(fromPath).get(refine);
  if (!center) throw new Error(`Candidate ${refine} not found in ${fromPath}`);
  const ranges: Record<string, [number, number]> = {};
  const global = clampAll(space.ranges);
  for (const id of Object.keys(space.ranges)) {
    const [lo, hi] = global[id];
    const c = Number(center.varied[id] ?? center.params[id]);
    ranges[id] = [Math.max(lo, c - radius * (hi - lo)), Math.min(hi, c + radius * (hi - lo))];
  }
  // Categories stay at the centre's values (they are in its params); only the numeric neighbourhood is searched.
  const idSeed = [...refine].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const local: Space = { ...space, categorical: undefined, steps: center.steps, base: { ...space.base, params: { ...center.params } }, ranges, n, seed: (space.seed + idSeed) >>> 0 };
  await runSet(local, buildCandidates(local, `${refine}.r`), (from ? out : join(out, `refine-${refine}`)), { top, jobs, pngScale, png, title: `Refinement of ${refine} (radius ${radius}, n ${n})` });
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
