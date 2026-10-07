/**
 * Byte-identity baselines: the render identity of every printed or print-ready seed, so a kit or
 * engine change can be checked against everything already on paper before it lands.
 *
 *   node --import tsx cli/baselines.ts check [--only text]           render each and compare
 *   node --import tsx cli/baselines.ts update <entry-or-text> [--yes] re-record matching entries
 *
 * Entries live in `sketches/baselines.json` (`entry`, `seed`, optional `params`, `identity`, `note`).
 * `check` exits 1 if any identity moved. `update` prints what it would change and writes only with
 * `--yes`: moving a print baseline means its print-queue entry needs re-prepping too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSketch } from './sketch/runner.ts';
import type { Params } from '../src/sketch/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINES = join(ROOT, 'sketches', 'baselines.json');

export interface Baseline { entry: string; seed: number; params?: Params; identity: string; note?: string }

export function readBaselines(file = BASELINES): Baseline[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { entries: Baseline[] }).entries;
}

/** Render every baseline (a few at a time) and report each identity against its record. */
export async function checkBaselines(entries: Baseline[], concurrency = 4): Promise<{ baseline: Baseline; identity: string | null; error: string | null }[]> {
  const out: { baseline: Baseline; identity: string | null; error: string | null }[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const b = entries[i];
      try {
        const r = await renderSketch({ entry: resolve(ROOT, b.entry), seed: b.seed, params: b.params, timeoutMs: 120_000 });
        out[i] = { baseline: b, identity: r.identity, error: null };
      } catch (e) {
        out[i] = { baseline: b, identity: null, error: (e as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [command, target] = argv;
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const entries = readBaselines();
  if (command === 'check') {
    const only = flag('--only');
    const chosen = entries.filter(b => !only || b.entry.includes(only) || (b.note ?? '').includes(only));
    let moved = 0;
    for (const r of await checkBaselines(chosen)) {
      const label = `${r.baseline.entry.replace(/^sketches\//, '').replace(/\/sketch\.ts$/, '')} seed ${r.baseline.seed}`;
      if (r.identity === r.baseline.identity) console.log(`OK    ${label}`);
      else { moved++; console.log(`MOVED ${label}: ${r.error ?? `${r.identity!.slice(0, 16)}… (recorded ${r.baseline.identity.slice(0, 16)}…)`}`); }
    }
    console.log(moved ? `${moved} of ${chosen.length} baselines moved` : `all ${chosen.length} baselines byte-identical`);
    return moved ? 1 : 0;
  }
  if (command === 'update' && target) {
    const chosen = entries.filter(b => b.entry.includes(target));
    if (!chosen.length) { console.error(`no baseline matches ${target}`); return 2; }
    const results = await checkBaselines(chosen);
    let changes = 0;
    for (const r of results) {
      if (!r.identity) { console.log(`ERROR ${r.baseline.entry}: ${r.error}`); return 1; }
      if (r.identity !== r.baseline.identity) { changes++; console.log(`${argv.includes('--yes') ? 'WROTE' : 'WOULD'} ${r.baseline.entry} seed ${r.baseline.seed}: ${r.baseline.identity.slice(0, 16)}… → ${r.identity.slice(0, 16)}…`); r.baseline.identity = r.identity; }
    }
    if (changes && argv.includes('--yes')) writeFileSync(BASELINES, JSON.stringify({ entries }, null, 2) + '\n');
    if (!changes) console.log('nothing to update');
    else if (!argv.includes('--yes')) console.log('dry run: add --yes to write (and re-prep the print-queue entries these feed)');
    return 0;
  }
  console.error('usage: node --import tsx cli/baselines.ts check [--only text] | update <entry-or-text> [--yes]');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error((e as Error).message); process.exitCode = 2; });
}
