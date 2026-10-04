/**
 * Numerical evidence for the prescribed-weather study.
 *   npx tsx sketches/cloud-advection/evidence.ts <outDir> [config.json]
 * Writes snapshots/step-{000,030,060}.json and numerics.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveMacroParams, resolveParams } from '../../packages/plot-core/src/index.ts';
import type { Params, SketchContext } from '../../src/sketch/types.ts';
import { extractMarks } from './extract.ts';
import { advance, buildDomain, configHashes, parseSnapshot, serializeSnapshot, simulate } from './sim.ts';
import sketch from './sketch.ts';
import { buildStudy } from './study.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The runner's named-stream generator (cli/sketch/child.ts randomStream), verbatim. */
function randomStream(seed: number, partId: string): () => number {
  const digest = createHash('sha256').update(`${seed}\0${partId}`).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A SketchContext equivalent to what the runner hands draw(): resolved params, macros applied, same streams. */
export function studyContext(request: { seed?: number; params?: Record<string, unknown> }): SketchContext {
  const params = resolveParams(sketch.controls, request.params);
  const effective = sketch.macros?.length ? resolveMacroParams(sketch.controls, params, sketch.macros) : params;
  const seed = request.seed ?? 0;
  return { params: effective as Params, seed, assets: {}, random: (id: string) => randomStream(seed, id) };
}

const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10;

function main(): void {
  const outDir = resolve(process.argv[2] ?? '.sketch-output/cloud-advection/evidence');
  const configPath = resolve(process.argv[3] ?? join(here, 'configs/step-30.json'));
  const request = JSON.parse(readFileSync(configPath, 'utf8')) as { seed: number; params: Record<string, unknown> };
  mkdirSync(join(outDir, 'snapshots'), { recursive: true });

  const ctx = studyContext(request);
  const study = buildStudy(ctx);
  const config = study.config;
  const hashes = configHashes(config);
  const hatchPitch = Number(ctx.params.hatchPitch);

  const t0 = performance.now();
  const domain = buildDomain(config);
  const domainMs = ms(t0);
  const t1 = performance.now();
  const series = simulate(config, Array.from({ length: 61 }, (_, i) => i));
  const simulateMs = ms(t1);

  const files: Record<string, string> = {};
  for (const step of [0, 30, 60]) {
    const name = `snapshots/step-${String(step).padStart(3, '0')}.json`;
    writeFileSync(join(outDir, name), serializeSnapshot(series[step]));
    files[`step${step}`] = name;
  }

  // Resume: parse the stored step-30 file and advance 30 more steps.
  const parsed = parseSnapshot(readFileSync(join(outDir, files.step30), 'utf8'));
  const t2 = performance.now();
  const resumed = advance(parsed, config, 30);
  const resumeMs = ms(t2);
  const resume = {
    from: 30, to: 60, resumedDensityHash: resumed.densityHash, directDensityHash: series[60].densityHash,
    equal: resumed.densityHash === series[60].densityHash && resumed.mass.current === series[60].mass.current,
    advanceMs: resumeMs,
  };

  let min = Infinity, max = -Infinity, finite = true;
  for (const snap of series) {
    for (const v of snap.density) {
      if (!Number.isFinite(v)) finite = false;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // Marks per step (every 5th step, plus 0/30/60).
  const marks = [];
  for (let step = 0; step <= 60; step += 5) {
    const t = performance.now();
    const parts = extractMarks(domain, series[step], study, { cloudEnabled: true, hatchPitch });
    const cloud = parts.filter(p => p.id.startsWith('cloud-') && !p.diagnostic);
    const streaks = parts.filter(p => p.id.startsWith('streak-'));
    const count = (list: typeof parts, f: (p: (typeof parts)[number]) => number): number => list.reduce((n, p) => n + f(p), 0);
    marks.push({
      step,
      cloudPaths: count(cloud, p => p.paths.length),
      cloudPoints: count(cloud, p => p.paths.reduce((m, path) => m + path.length, 0)),
      streakPaths: count(streaks, p => p.paths.length),
      streakPoints: count(streaks, p => p.paths.reduce((m, path) => m + path.length, 0)),
      extractMs: ms(t),
    });
  }

  // Mark-only changes must leave simulation identity untouched.
  const base = { stateKey: hashes.stateKey, densityHash: series[30].densityHash };
  const variants: Record<string, Record<string, unknown>> = {
    cloudPen: { cloudPen: 'gold' },
    hatchSpacing: { cloudHatchPitch: 4.2 },
    obscure: { obscure: 0.3 },
    core: { coreRadius: 60, coreX: 20, coreY: -30 },
    referenceDensity: { referenceDensity: 0.9 },
    hatchPitch: { hatchPitch: 2.5 },
    markStyle: { markStyle: 'contours' },
    streakPen: { streakPen: 'gold' },
    streakSpacing: { streakSpacing: 5 },
  };
  const invariance: Record<string, { stateKey: string; densityHash: string; unchanged: boolean }> = {};
  for (const [name, change] of Object.entries(variants)) {
    const other = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, ...change } }));
    const key = configHashes(other.config).stateKey;
    const snap = simulate(other.config, [30])[0];
    invariance[name] = { stateKey: key, densityHash: snap.densityHash, unchanged: key === base.stateKey && snap.densityHash === base.densityHash };
  }
  // Control: a simulation parameter must change them.
  const wind = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, windX: 1.5 } }));
  const windSnap = simulate(wind.config, [30])[0];

  const result = {
    config: configPath,
    seed: request.seed,
    stateKey: hashes.stateKey,
    hashes,
    cells: { cols: domain.cols, rows: domain.rows, count: domain.cols * domain.rows, spacing: domain.spacing,
      solidCells: Array.from(domain.solid).reduce((n, v) => n + (v ? 1 : 0), 0) },
    dt: config.settings.dt,
    boundary: config.settings.boundary,
    diffusivity: config.settings.diffusivity,
    worldToPage: config.transforms.worldToPage,
    densityRange: { min, max },
    allFinite: finite,
    massSeries: series.map(s => ({ step: s.step, timeS: s.timeS, mass: s.mass.current, drift: s.mass.drift, relativeDrift: s.mass.relativeDrift })),
    massHeadline: { initial: series[0].mass.initial, step30: series[30].mass.current, step60: series[60].mass.current,
      relativeDriftStep30: series[30].mass.relativeDrift, relativeDriftStep60: series[60].mass.relativeDrift },
    densityHashes: { step0: series[0].densityHash, step30: series[30].densityHash, step60: series[60].densityHash },
    snapshotFiles: files,
    resume,
    markInvariance: { base, variants: invariance, allUnchanged: Object.values(invariance).every(v => v.unchanged),
      simulationControl: { windX: 1.5, stateKeyChanged: configHashes(wind.config).stateKey !== base.stateKey, densityHashChanged: windSnap.densityHash !== base.densityHash } },
    marksPerStep: marks,
    timingsMs: { buildDomain: domainMs, simulate0to60: simulateMs, resume30to60: resumeMs },
  };
  writeFileSync(join(outDir, 'numerics.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    outDir, stateKey: result.stateKey, resumeEqual: resume.equal, allFinite: finite, density: result.densityRange,
    relativeDrift: result.massHeadline, markInvarianceUnchanged: result.markInvariance.allUnchanged, timingsMs: result.timingsMs,
  }, null, 2));
  if (!resume.equal || !finite || !result.markInvariance.allUnchanged) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
