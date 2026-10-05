/**
 * Numerical evidence for the Borrowed Orbits study.
 *
 *   npx tsx sketches/borrowed-orbits/evidence.ts <outDir> [config.json] [--resume-from 600] [--to 1200] [--every 10]
 *
 * Writes snapshots/step-{0,k,N}.json and numerics.json: resume equality (simulate to k, serialize, parse,
 * advance to N, compare bitwise with the direct run), mark-only invariance, seed separation, energy-error
 * statistics, capture/escape counts and timings.
 *
 * Ledger against sketches/cloud-advection/evidence.ts (the study is measuring what is shareable as it is):
 * - IMPORTED UNCHANGED from cloud-advection: nothing. Every generic piece is either bound to the cloud sketch or
 *   not exported (see below), so there was nothing to import.
 * - COPIED, not adapted: `randomStream` (the runner's named-stream generator, verbatim; the cloud file copies it
 *   from cli/sketch/child.ts too, which does not export it) and the `ms` timer.
 * - COPIED AND ADAPTED: `studyContext` (the cloud one resolves controls and macros against the CLOUD sketch's
 *   control list, so it cannot be shared until it takes the sketch as an argument), the resume proof, the
 *   mark-invariance variants table and the numerics.json shape. Cloud evidence compares density hashes and mass
 *   drift; this one compares stateHash, the serialized JSON, and energy and momentum errors.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveMacroParams, resolveParams } from '../../packages/plot-core/src/index.ts';
import type { Params, SketchContext } from '../../src/sketch/types.ts';
import { extractMarks } from './extract.ts';
import { STATUS_CODE } from './model.ts';
import type { OrbitSnapshot } from './model.ts';
import { advance, configHashes, history, initialSnapshot, parseSnapshot, serializeSnapshot, simulate } from './sim.ts';
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
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Every control in the Marks group: none of them may touch the simulation. */
const MARK_VARIANTS: Record<string, Record<string, unknown>> = {
  taper: { taper: 0 },
  taperFull: { taper: 1 },
  trailPen: { trailPen: 'gold' },
  trailSteps: { trailSteps: 120 },
  trailMinSpacing: { trailMinSpacing: 3 },
  drawGuides: { drawGuides: false },
  guidePen: { guidePen: 'cyan' },
  structurePen: { structurePen: 'violet' },
  hatchPitch: { hatchPitch: 2.5 },
};

const counts = (s: OrbitSnapshot) => ({
  free: s.status.filter(v => v === STATUS_CODE.free).length,
  captured: s.status.filter(v => v === STATUS_CODE.captured).length,
  escaped: s.status.filter(v => v === STATUS_CODE.escaped).length,
});

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} needs a nonnegative integer`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) i++; else positional.push(args[i]); }
  const outDir = resolve(positional[0] ?? '.sketch-output/borrowed-orbits/evidence');
  const configPath = resolve(positional[1] ?? join(here, 'configs/pilot-mid.json'));
  const k = flag(args, '--resume-from', 600);
  const total = flag(args, '--to', 1200);
  const every = Math.max(1, flag(args, '--every', 10));
  if (!(k > 0 && k < total)) throw new Error('--resume-from must be between 0 and --to');
  const request = JSON.parse(readFileSync(configPath, 'utf8')) as { seed: number; params: Record<string, unknown> };
  mkdirSync(join(outDir, 'snapshots'), { recursive: true });

  const study = buildStudy(studyContext(request));
  const config = study.config;
  const hashes = configHashes(config);

  // Direct run: one pass with a snapshot at every `every` steps (plus k and N), for the energy series and counts.
  const stepList = [...new Set([...Array.from({ length: Math.floor(total / every) + 1 }, (_, i) => i * every), k, total])].sort((a, b) => a - b);
  const t1 = performance.now();
  const series = simulate(config, stepList);
  const simulateMs = ms(t1);
  const at = (step: number): OrbitSnapshot => series[stepList.indexOf(step)];
  const direct = at(total);

  // Resume proof: serialize the step-k snapshot to disk, parse it, advance to N, compare with the direct run bit for bit.
  const files: Record<string, string> = {};
  for (const step of [0, k, total]) {
    const name = `snapshots/step-${String(step).padStart(4, '0')}.json`;
    writeFileSync(join(outDir, name), serializeSnapshot(at(step)));
    files[`step${step}`] = name;
  }
  const parsed = parseSnapshot(config, readFileSync(join(outDir, files[`step${k}`]), 'utf8'));
  const t2 = performance.now();
  const resumed = advance(config, parsed, total - k);
  const resumeMs = ms(t2);
  const resume = {
    from: k, to: total,
    resumedStateHash: resumed.stateHash, directStateHash: direct.stateHash,
    resumedJsonSha256: sha(serializeSnapshot(resumed)), directJsonSha256: sha(serializeSnapshot(direct)),
    bitwiseEqual: resumed.stateHash === direct.stateHash && serializeSnapshot(resumed) === serializeSnapshot(direct),
    advanceMs: resumeMs,
  };
  // Also a chunked run (several advances) must match, so the segmentation of a run never matters.
  let chunked = initialSnapshot(config);
  for (let s = 0; s < total; s += 137) chunked = advance(config, chunked, Math.min(137, total - s));
  const chunkedEqual = serializeSnapshot(chunked) === serializeSnapshot(direct);

  // Finite everywhere.
  let finite = true;
  for (const s of series) {
    for (const arr of [s.px, s.py, s.vx, s.vy]) for (const v of arr) if (!Number.isFinite(v)) finite = false;
    if (!Number.isFinite(s.energy.attractorTotal) || !Number.isFinite(s.energy.particleSpecific)) finite = false;
  }

  // Energy bookkeeping. attractorTotal is conserved up to integration error (two bodies, no pin); particleSpecific is not
  // (time-dependent field with the perturber) and is reported as a range.
  const e0 = series[0].energy;
  const rel = series.map(s => (s.energy.attractorTotal - e0.attractorTotal) / Math.abs(e0.attractorTotal));
  const momentumScale = study.config.attractors.reduce((m, a) => m + a.mass * Math.hypot(a.velocity.x, a.velocity.y), 0) || 1;
  const momentumDrift = series.map(s => Math.hypot(s.energy.attractorMomentum.x - e0.attractorMomentum.x, s.energy.attractorMomentum.y - e0.attractorMomentum.y) / momentumScale);
  const absRel = rel.map(Math.abs);
  const sorted = [...absRel].sort((a, b) => a - b);
  const particleE = series.map(s => s.energy.particleSpecific);
  const energy = {
    attractorTotalJ: { step0: e0.attractorTotal, final: series[series.length - 1].energy.attractorTotal },
    attractorRelativeError: { maxAbs: Math.max(...absRel), meanAbs: absRel.reduce((a, b) => a + b, 0) / absRel.length, p95Abs: sorted[Math.floor(0.95 * (sorted.length - 1))], finalSigned: rel[rel.length - 1] },
    momentumRelativeDrift: { max: Math.max(...momentumDrift), final: momentumDrift[momentumDrift.length - 1] },
    particleSpecificJPerKg: { min: Math.min(...particleE), max: Math.max(...particleE), step0: particleE[0], final: particleE[particleE.length - 1] },
    note: 'attractorTotal is conserved by the exact dynamics; particleSpecific is not, because the field is time-dependent once the perturber moves the primary.',
  };

  // Capture and escape counts over time, and the reasons at N.
  const countSeries = stepList.filter((_s, i) => i % Math.max(1, Math.round(100 / every)) === 0 || stepList[i] === total).map(step => ({ step, ...counts(at(step)) }));
  const reasonName = ['none', 'forbidden', 'attractor', 'edge'];
  const reasons: Record<string, number> = {};
  direct.status.forEach((st, i) => {
    if (st === STATUS_CODE.free) return;
    const key = st === STATUS_CODE.escaped ? 'escaped' : `captured:${reasonName[direct.reason[i]]}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  });

  // Marks per step (extraction timing and ink size).
  const window = study.marks.trailSteps;
  const marksPerStep = [] as { step: number; trailPaths: number; trailPoints: number; extractMs: number }[];
  for (const step of [Math.min(300, total), k, total]) {
    const t = performance.now();
    const rec = history(config, Math.max(0, step - window), step);
    const parts = extractMarks(study, rec);
    const trails = parts.find(p => p.id === 'trails')!;
    marksPerStep.push({ step, trailPaths: trails.paths.length, trailPoints: trails.paths.reduce((n, p) => n + p.length, 0), extractMs: ms(t) });
  }

  // Mark-only changes must leave simulation identity untouched.
  const base = { stateKey: hashes.stateKey, stateHashAtK: at(k).stateHash };
  const invariance: Record<string, { stateKey: string; stateHashAtK: string; unchanged: boolean }> = {};
  for (const [name, change] of Object.entries(MARK_VARIANTS)) {
    const other = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, ...change } }));
    const key = configHashes(other.config).stateKey;
    const snap = simulate(other.config, [k])[0];
    invariance[name] = { stateKey: key, stateHashAtK: snap.stateHash, unchanged: key === base.stateKey && snap.stateHash === base.stateHashAtK };
  }
  // Controls: simulation parameters must change identity.
  const controls: Record<string, boolean> = {};
  for (const change of [{ massDX: -3 }, { borrow: 0.5 }, { perturberRatio: 0.7 }, { forbiddenLayout: 'arc' }, { dynamicsSeed: 5 }]) {
    const other = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, ...change } }));
    controls[JSON.stringify(change)] = configHashes(other.config).stateKey !== base.stateKey;
  }

  // Seed separation: dynamicsSeed keeps the geometry hash; structureSeed keeps the particles' initial state.
  const particleDigest = (s: typeof study): string => sha(JSON.stringify(s.config.particles));
  const dyn = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, dynamicsSeed: 7 } }));
  const str = buildStudy(studyContext({ seed: request.seed, params: { ...request.params, structureSeed: 7 } }));
  const dynHashes = configHashes(dyn.config), strHashes = configHashes(str.config);
  const seedSeparation = {
    dynamicsSeed7: { geometryUnchanged: dynHashes.geometry === hashes.geometry, particlesChanged: particleDigest(dyn) !== particleDigest(study), stateKeyChanged: dynHashes.stateKey !== hashes.stateKey },
    structureSeed7: { particlesUnchanged: particleDigest(str) === particleDigest(study), geometryChanged: strHashes.geometry !== hashes.geometry, stateKeyChanged: strHashes.stateKey !== hashes.stateKey },
  };
  const separated = seedSeparation.dynamicsSeed7.geometryUnchanged && seedSeparation.dynamicsSeed7.particlesChanged
    && seedSeparation.structureSeed7.particlesUnchanged && (study.forbidden.length === 0 || seedSeparation.structureSeed7.geometryChanged);

  const result = {
    config: configPath, seed: request.seed, stateKey: hashes.stateKey, hashes,
    dt: config.settings.dt, boundary: config.settings.boundary, escapeMargin: config.settings.escapeMargin,
    particles: config.particles.length, attractors: config.attractors.map(a => ({ id: a.id, mass: a.mass, position: a.position, velocity: a.velocity })),
    forbidden: config.forbidden.length, worldToPage: config.transforms.worldToPage,
    allFinite: finite, resume, chunkedRunEqualsDirect: chunkedEqual, snapshotFiles: files,
    energy, counts: { series: countSeries, finalReasons: reasons },
    markInvariance: { base, variants: invariance, allUnchanged: Object.values(invariance).every(v => v.unchanged), simulationControlsChangeIdentity: controls },
    seedSeparation, marksPerStep,
    timingsMs: { simulate0toN: simulateMs, simulateStepsPerSecond: Math.round(total / (simulateMs / 1000)), resumeKtoN: resumeMs },
  };
  writeFileSync(join(outDir, 'numerics.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    outDir, stateKey: result.stateKey, bitwiseEqual: resume.bitwiseEqual, chunkedEqual, allFinite: finite,
    attractorRelativeError: energy.attractorRelativeError, momentumRelativeDrift: energy.momentumRelativeDrift,
    finalCounts: countSeries[countSeries.length - 1], markInvarianceUnchanged: result.markInvariance.allUnchanged, seedSeparated: separated,
    controlsChangeIdentity: Object.values(controls).every(Boolean), timingsMs: result.timingsMs,
  }, null, 2));
  if (!resume.bitwiseEqual || !chunkedEqual || !finite || !result.markInvariance.allUnchanged || !separated) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
