/**
 * Check finalized prints against plotter-server's own import rules before anything is queued.
 *
 *   node --import tsx cli/plotter-check.ts <piece-dir> [<piece-dir> ...]
 *
 * A piece dir is a finalize output (with `source/render.svg`) or a print-queue entry (with
 * `render.svg`); either way it holds `plot-ready.svg` and `config.json`. For each piece:
 *
 * - plotter-server's `validatePreparedPenPlan(canonical, prepared)` must pass;
 * - `buildPenPlan(prepared, config)` must return one step per layer in the config;
 * - a negative control, the prepared file with its last pen layer recoloured, must be rejected, so a
 *   pass means the check was live.
 *
 * The checks are loaded from a plotter-server checkout (PLOTTER_SERVER_DIR, default
 * ~/git/plotter-server); nothing is sent to a server and nothing is queued.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface PenPlanModule {
  validatePreparedPenPlan(canonicalSvg: string, preparedSvg: string): void;
  buildPenPlan(svg: string, config?: string | null, selection?: string): unknown[] | null;
  findSvgLayerTags(svg: string): { start: number; end: number; attributes: Record<string, string> }[];
}

export interface CheckResult { dir: string; ok: boolean; layers: number; steps: number; rejected: string | null; error: string | null }

export async function loadPenPlan(serverDir = process.env.PLOTTER_SERVER_DIR ?? join(homedir(), 'git', 'plotter-server')): Promise<PenPlanModule> {
  const file = join(serverDir, 'src', 'pen-plan.ts');
  if (!existsSync(file)) throw new Error(`plotter-check: no plotter-server checkout at ${serverDir} (set PLOTTER_SERVER_DIR)`);
  return await import(pathToFileURL(file).href) as PenPlanModule;
}

/** The prepared file with its last pen layer's stroke colour changed: a copy the checks must reject. */
export function recolourLastLayer(svg: string, plan: PenPlanModule): string {
  const layers = plan.findSvgLayerTags(svg);
  const last = layers[layers.length - 1];
  if (!last?.attributes.stroke) throw new Error('plotter-check: the prepared file has no stroked layer to recolour');
  const tag = svg.slice(last.start, last.end);
  const swapped = tag.replace(`stroke="${last.attributes.stroke}"`, `stroke="${last.attributes.stroke === '#010203' ? '#030201' : '#010203'}"`);
  if (swapped === tag) throw new Error('plotter-check: could not recolour the last layer');
  return svg.slice(0, last.start) + swapped + svg.slice(last.end);
}

export function checkPiece(dir: string, plan: PenPlanModule): CheckResult {
  const result: CheckResult = { dir, ok: false, layers: 0, steps: 0, rejected: null, error: null };
  try {
    const canonicalPath = [join(dir, 'source', 'render.svg'), join(dir, 'render.svg')].find(existsSync);
    if (!canonicalPath) throw new Error('no render.svg (or source/render.svg)');
    const canonical = readFileSync(canonicalPath, 'utf8');
    const prepared = readFileSync(join(dir, 'plot-ready.svg'), 'utf8');
    const config = readFileSync(join(dir, 'config.json'), 'utf8');
    plan.validatePreparedPenPlan(canonical, prepared);
    const steps = plan.buildPenPlan(prepared, config) ?? [];
    const layers = (JSON.parse(config) as { layers?: unknown[] }).layers?.length ?? 0;
    result.layers = layers;
    result.steps = steps.length;
    if (!layers || steps.length !== layers) throw new Error(`pen plan has ${steps.length} steps for ${layers} config layers`);
    try {
      plan.validatePreparedPenPlan(canonical, recolourLastLayer(prepared, plan));
    } catch (e) {
      result.rejected = (e as Error).message;
    }
    if (!result.rejected) throw new Error('negative control was accepted: the check is not live');
    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

async function main(argv: string[]): Promise<number> {
  const dirs = argv.filter(a => !a.startsWith('-')).map(d => resolve(d));
  if (!dirs.length) {
    console.error('usage: node --import tsx cli/plotter-check.ts <piece-dir> [<piece-dir> ...]');
    return 2;
  }
  const plan = await loadPenPlan();
  let failed = 0;
  for (const dir of dirs) {
    const r = checkPiece(dir, plan);
    if (r.ok) console.log(`OK    ${basename(dir)}: ${r.steps} pen steps for ${r.layers} layers; negative control rejected ("${r.rejected}")`);
    else { failed++; console.log(`FAIL  ${basename(dir)}: ${r.error}`); }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error((e as Error).message); process.exitCode = 2; });
}
