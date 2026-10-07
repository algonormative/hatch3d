/**
 * Prep finalized prints as vault print-queue entries.
 *
 *   node --import tsx cli/print-queue.ts <stack.json> --into <print-queue-dir> --prefix <name> --notes <notes.json>
 *       [--only a,b] [--date YYYY-MM-DD] [--force]
 *
 * Each piece must already be finalized (`cli/finalize.ts run`), under the stack's `out`. It is written
 * only if it passes two checks: plotter-server's import rules (cli/plotter-check.ts), and its art
 * matching a plain render of the sketch path for path under the border's fit (cli/art-match.ts), to
 * `<into>/<prefix>-<date>-<name>/`: the canonical `render.svg` and `render.png`, `plot-ready.svg`,
 * `config.json`, `request.json`, `finalize-report.json`, and an `index.md` with the frontmatter
 * (status prepped, seed, build, hashes, pens, minutes), the piece's notes, the files, the regenerate
 * command, the pen plan and the status. The notes file maps piece names to markdown. Existing
 * entries are left alone unless `--force`. Nothing is uploaded or queued: that needs its own approval.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artMatch, type ArtMatch } from './art-match.ts';
import { checkPiece, loadPenPlan } from './plotter-check.ts';
import { renderSketch } from './sketch/runner.ts';
import type { Piece, Stack } from './finalize.ts';
import type { Params } from '../src/sketch/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface LayerStat { layer: number; paths: number; drawMm: number; travelMm: number; label: string; color: string; passes: number; minutes: number }
interface Report {
  name: string; title: string | null; seed: number; palette: string; paper: string;
  build: { version: string; hash: string; dirty: boolean };
  layers: LayerStat[]; pens: number; minutes: number; sourceSha256: string; preparedSha256: string;
}

export interface EntryOptions { stackPath: string; prefix: string; date: string; notes: string; branch: string | null; art: { identity: string; match: ArtMatch } }

/** The entry's index.md, in the print-queue's format. */
export function indexMarkdown(piece: Piece, report: Report, config: { pens?: { id: string; width: number }[] }, o: EntryOptions): string {
  const title = piece.title ?? report.title ?? piece.name;
  const composition = relative(join(ROOT, 'sketches'), dirname(resolve(ROOT, piece.sketch)));
  const fine = report.layers.filter(l => (config.pens?.find(p => l.label.endsWith(`-${p.id}`))?.width ?? 1) < 0.2);
  const m = (mm: number) => (mm / 1000).toFixed(1);
  const rows = report.layers.map(l => `| ${l.label} | ${l.color} | ${l.paths.toLocaleString('en-US')} | ${m(l.drawMm)} | ${m(l.travelMm)} | ${l.minutes.toFixed(1)} |`);
  const regenerate = `node --import tsx cli/finalize.ts run ${o.stackPath} --only ${piece.name}`;
  return [
    '---',
    `title: "${title}"`,
    `created: ${o.date}`,
    'status: prepped',
    `tags: [print-queue, hatch3d, ${o.prefix}, ${report.palette}, multi-pen]`,
    `composition: ${composition}`,
    `seed: ${report.seed}`,
    `edition: "${report.build.version}"`,
    `build: ${report.build.hash}${report.build.dirty ? '+' : ''}`,
    `palette: ${report.palette}`,
    `paper: "${report.paper}"`,
    `pens: ${report.pens}`,
    `estimated_minutes: ${report.minutes}`,
    `source_sha256: ${report.sourceSha256}`,
    `prepared_sha256: ${report.preparedSha256}`,
    `art_identity: ${o.art.identity}`,
    'references:',
    '  - type: repo',
    '    url: "https://github.com/algonormative/hatch3d"',
    `    local: "${ROOT}"`,
    '---',
    '',
    `# ${title}`,
    '',
    '![preview](render.png)',
    '',
    o.notes.trim(),
    '',
    '## Files',
    '',
    `- \`render.svg\` is the canonical render and the source of truth. Never modify it. Its art is the sketch's own render (identity \`${o.art.identity.slice(0, 12)}\`), matched path for path (${o.art.match.matched.toLocaleString('en-US')} paths, worst ${o.art.match.worst.toFixed(3)} mm) under the border's fit, scale ${o.art.match.scale.toFixed(5)}.`,
    "- `plot-ready.svg` is the vpype-prepared derivative, with the same pen plan. It passed plotter-server's `validatePreparedPenPlan` and `buildPenPlan` against `render.svg` and `config.json` (`cli/plotter-check.ts`, with a negative control rejected).",
    '- `config.json` is the plotter-server queue config (`hatch3d-sketch-v1`).',
    '- `request.json` is the exact render request.',
    '- `finalize-report.json` holds the options, the vpype arguments and the build.',
    '',
    `To regenerate, run this at hatch3d \`${report.build.hash}\`${o.branch ? ` (branch \`${o.branch}\`)` : ''}:`,
    '',
    `\`${regenerate}\``,
    '',
    '## Pen plan',
    '',
    'Plot in layer order and do not move the paper between layers.',
    '',
    '| Layer | Ink | Paths | Ink (m) | Travel (m) | Minutes |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    ...fine.map(l => `- Layer ${l.layer} (${l.label.replace(/^\d+-/, '')}) is drawn at ${config.pens?.find(p => l.label.endsWith(`-${p.id}`))?.width} mm, so use a fine pen.`),
    '- The estimate is rough: 60 mm/s drawing, 200 mm/s travel, and one minute per pen change.',
    '',
    '## Status',
    '',
    'Not uploaded to the plotter-server queue and not plotted. Queue upload, server import and physical start each need explicit approval.',
    '',
  ].join('\n');
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const stackPath = argv.find(a => a.endsWith('.json') && !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--notes');
  const into = arg(argv, '--into'), prefix = arg(argv, '--prefix'), notesPath = arg(argv, '--notes');
  if (!stackPath || !into || !prefix || !notesPath) {
    console.error('usage: node --import tsx cli/print-queue.ts <stack.json> --into <print-queue-dir> --prefix <name> --notes <notes.json> [--only a,b] [--date YYYY-MM-DD] [--force]');
    return 2;
  }
  const stack = JSON.parse(readFileSync(resolve(stackPath), 'utf8')) as Stack;
  const notes = JSON.parse(readFileSync(resolve(notesPath), 'utf8')) as Record<string, string>;
  const only = arg(argv, '--only')?.split(',');
  const date = arg(argv, '--date') ?? new Date().toISOString().slice(0, 10);
  const force = argv.includes('--force');
  const plan = await loadPenPlan();
  let failed = 0;
  for (const piece of stack.pieces.filter(p => !only || only.includes(p.name))) {
    const dir = resolve(ROOT, stack.out, piece.name);
    const target = join(resolve(into), `${prefix}-${date}-${piece.name}`);
    if (!existsSync(join(dir, 'report.json'))) { failed++; console.log(`SKIP  ${piece.name}: not finalized (run cli/finalize.ts first)`); continue; }
    if (!notes[piece.name]) { failed++; console.log(`SKIP  ${piece.name}: no notes for it in ${notesPath}`); continue; }
    if (existsSync(target) && !force) { console.log(`KEEP  ${piece.name}: ${target} exists (--force to replace)`); continue; }
    const check = checkPiece(dir, plan);
    if (!check.ok) { failed++; console.log(`FAIL  ${piece.name}: ${check.error}`); continue; }
    const plain = await renderSketch({ entry: resolve(ROOT, piece.sketch), seed: piece.seed, params: { ...(stack.params ?? {}), ...(piece.params ?? {}) } as Params });
    const match = artMatch(plain.svg, readFileSync(join(dir, 'source', 'render.svg'), 'utf8'));
    if (!match.ok) { failed++; console.log(`FAIL  ${piece.name}: only ${match.matched}/${match.total} art paths match the sketch's own render`); continue; }
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { pens?: { id: string; width: number }[] };
    const branch = spawnSync('git', ['branch', '--contains', report.build.hash, '--format=%(refname:short)'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n')[0]?.trim() || null;
    mkdirSync(target, { recursive: true });
    for (const [from, to] of [['source/render.svg', 'render.svg'], ['source/render.png', 'render.png'], ['plot-ready.svg', 'plot-ready.svg'],
      ['config.json', 'config.json'], ['request.json', 'request.json'], ['report.json', 'finalize-report.json']]) copyFileSync(join(dir, from), join(target, to));
    writeFileSync(join(target, 'index.md'), indexMarkdown(piece, report, config, { stackPath: relative(ROOT, resolve(stackPath)), prefix, date, notes: notes[piece.name], branch, art: { identity: plain.identity, match } }));
    console.log(`OK    ${piece.name}: ${target} (${report.minutes} min, ${report.pens} pens)`);
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error((e as Error).message); process.exitCode = 2; });
}
