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
 *
 * A ply of an assembly (a piece with `assembly`) also gets `assembly`, `ply`, `ply_order`, `paper_stock` and the
 * signing pen and box in its frontmatter, and an `## Assembly` section: the sibling plies, the cuts, how to cut and
 * glue, and where its parts and onlays go. `assembled.png` is copied in when `cli/assembly.ts preview` has made it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artMatch, type ArtMatch } from './art-match.ts';
import { checkPiece, loadPenPlan } from './plotter-check.ts';
import { renderSketch } from './sketch/runner.ts';
import { loadSketch, plainFinishing, plyOf, slug, type Piece, type Stack } from './finalize.ts';
import { previewDir, previewState } from './assembly.ts';
import type { AssemblyReport } from './assembly-world.ts';
import type { AssemblySpec, Page, Params } from '../src/sketch/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The sketch's own render that a print's art is matched against: on the stack's page when the sketch is page-aware and the stack sets one. */
export async function plainRender(stack: Stack, piece: Piece) {
  const entry = resolve(ROOT, piece.sketch);
  const sketch = (await import(pathToFileURL(entry).href)).default as { page: Page; pageAware?: boolean };
  const finishing = plainFinishing(stack, sketch);
  return renderSketch({ entry, seed: piece.seed, params: { ...(stack.params ?? {}), ...(piece.params ?? {}) } as Params, ...(finishing ? { finishing } : {}) });
}

interface LayerStat { layer: number; paths: number; drawMm: number; travelMm: number; label: string; color: string; passes: number; minutes: number }
interface Report {
  name: string; title: string | null; seed: number; palette: string; paper: string;
  build: { version: string; hash: string; dirty: boolean };
  layers: LayerStat[]; pens: number; minutes: number; sourceSha256: string; preparedSha256: string;
  assembly?: AssemblyReport;
}

/** What the entry of an assembly ply says about its panel; see `assemblyEntry`. */
export interface AssemblyEntry {
  /** The plies of the panel, bottom to top: the entry that holds a sheet ply, or the part an onlay is cut from. */
  plies: { ply: string; paper: string; entry?: string; onlay?: string }[];
  /** The part cuts of this ply, and the onlay ply (of the named assembly) each is glued on as; none named when no onlay in the stack is cut from it. */
  keeps: { cut: string; assembly?: string; ply?: string }[];
  /** The onlays glued onto this sheet: the ply of the piece and the part (`<assembly>/<ply>/<cut>`) it is cut from. */
  receives: { ply: string; from: string }[];
  /** Whether `assembled.png` sits in the entry. */
  preview: boolean;
  /** A preview of the panel exists but was composed from other files than the entry's plies now are, so it was not copied. */
  previewStale?: boolean;
}

export interface EntryOptions { stackPath: string; prefix: string; date: string; notes: string; branch: string | null; art: { identity: string; match: ArtMatch }; assembly?: AssemblyEntry }

const box = (b: { x: number; y: number; width: number; height: number }) => [b.x, b.y, b.x + b.width, b.y + b.height].map(n => +n.toFixed(3)).join(',');

const GLUE = 'Glue the piece over its placement ticks: they sit 1.5 mm inside its outline and the piece covers them.';

/** The `## Assembly` section: where this ply sits in its panel, what to cut, and how the pieces go together. */
function assemblySection(a: AssemblyReport, o: AssemblyEntry): string[] {
  const cutRows = a.cuts.map(c => `| ${c.id} | ${c.kind}${c.kind === 'part' ? ' (kept)' : ''} |`);
  return [
    '## Assembly',
    '',
    `Panel \`${a.name}\`, ply ${a.index} of ${a.plies}: \`${a.ply}\` on ${a.paper.id} paper. The plies, bottom to top:`,
    '',
    '| Ply | Paper | Entry |',
    '| ---: | --- | --- |',
    ...o.plies.map((p, i) => `| ${i + 1} ${p.ply} | ${p.paper} | ${p.ply === a.ply ? 'this entry' : p.onlay ? `onlay: cut from \`${p.onlay}\`, not plotted` : p.entry ? `\`${p.entry}\`` : 'not in this stack'} |`),
    '',
    ...(o.preview ? ['![assembled preview](assembled.png)', ''] : o.previewStale ? ['- preview is stale: re-run `npm run assembly -- preview`, then queue this entry again with `--force` (the old `assembled.png` was left out).', ''] : []),
    ...(cutRows.length ? ['Cuts on this ply:', '', '| Cut | Kind |', '| --- | --- |', ...cutRows, ''] : ['This ply has no cuts.', '']),
    'To assemble:',
    '',
    '- Let the ink dry before cutting (gel pens: about an hour).',
    '- Cut waste along the edge of each guide line that faces the kept paper (the line sits inside the waste).',
    '- Cut parts **down the middle** of the line.',
    '- Trim at the crop marks.',
    '- Square in an L-square, bottom ply first.',
    ...o.keeps.map(k => (k.assembly ? `- Keep \`${k.cut}\`: glue onto \`${k.assembly}\` as \`${k.ply}\`. ${GLUE}` : `- Keep \`${k.cut}\`: no onlay in this stack is cut from it yet.`)),
    ...o.receives.map(r => `- This sheet receives onlay \`${r.ply}\`, the part \`${r.from}\`. ${GLUE}`),
    '',
  ];
}

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
    ...(report.assembly ? [
      `assembly: ${report.assembly.name}`,
      `ply: ${report.assembly.ply}`,
      `ply_order: ${report.assembly.index}/${report.assembly.plies}`,
      `paper_stock: ${report.assembly.paper.id}`,
      ...(report.assembly.signature ? [`sign_pen: ${report.assembly.signature.pen}`, `sign_box: ${box(report.assembly.signature.box)}`] : ['sign: false']),
    ] : []),
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
    ...(report.assembly && o.assembly?.preview ? ['- `assembled.png` previews the panel with every ply laid up (`cli/assembly.ts preview`). It is not plotted.'] : []),
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
    ...(report.assembly && o.assembly ? assemblySection(report.assembly, o.assembly) : []),
    '## Status',
    '',
    'Not uploaded to the plotter-server queue and not plotted. Queue upload, server import and physical start each need explicit approval.',
    '',
  ].join('\n');
}

/** The panel of an assembly ply as its entry describes it, read from the sketches of the stack's assemblies. */
async function assemblyEntry(stack: Stack, here: AssemblyReport, entryPrefix: string, preview: boolean, previewStale: boolean): Promise<AssemblyEntry> {
  const groups = new Map<string, { spec: AssemblySpec; members: { piece: Piece; ply: string }[] }>();
  for (const name of new Set(stack.pieces.flatMap(p => (p.assembly ? [p.assembly] : [])))) {
    const pieces = stack.pieces.filter(p => p.assembly === name);
    const loaded = await loadSketch(stack, pieces[0].sketch);
    if (loaded.assembly) groups.set(name, { spec: loaded.assembly, members: pieces.map(piece => ({ piece, ply: plyOf(stack, piece, loaded).ply.id })) });
  }
  const own = groups.get(here.name);
  if (!own) throw new Error(`assembly ${here.name} is not in the stack`);
  const plies = own.spec.plies.map(p => ({
    ply: p.id, paper: p.paper.id,
    ...(p.onlay ? { onlay: p.onlay.from } : own.members.some(m => m.ply === p.id) ? { entry: `${entryPrefix}${own.members.find(m => m.ply === p.id)!.piece.name}` } : {}),
  }));
  const keeps = here.cuts.filter(c => c.kind === 'part').flatMap(cut => {
    const targets = [...groups].flatMap(([assembly, g]) => g.spec.plies
      .filter(p => p.onlay && p.onlay.from === `${here.name}/${here.ply}/${cut.id}`).map(p => ({ cut: cut.id, assembly, ply: p.id })));
    return targets.length ? targets : [{ cut: cut.id }];
  });
  const below = own.spec.plies.findIndex(p => p.id === here.ply);
  const above = own.spec.plies[below + 1];
  const receives = above?.onlay ? [{ ply: above.id, from: above.onlay.from }] : [];
  return { plies, keeps, receives, preview, ...(previewStale ? { previewStale } : {}) };
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
    const dir = resolve(ROOT, stack.out, slug(piece.name));
    const target = join(resolve(into), `${prefix}-${date}-${piece.name}`);
    if (!existsSync(join(dir, 'report.json'))) { failed++; console.log(`SKIP  ${piece.name}: not finalized (run cli/finalize.ts first)`); continue; }
    if (!notes[piece.name]) { failed++; console.log(`SKIP  ${piece.name}: no notes for it in ${notesPath}`); continue; }
    if (existsSync(target) && !force) { console.log(`KEEP  ${piece.name}: ${target} exists (--force to replace)`); continue; }
    const check = checkPiece(dir, plan);
    if (!check.ok) { failed++; console.log(`FAIL  ${piece.name}: ${check.error}`); continue; }
    const plain = await plainRender(stack, piece);
    const match = artMatch(plain.svg, readFileSync(join(dir, 'source', 'render.svg'), 'utf8'));
    if (!match.ok) { failed++; console.log(`FAIL  ${piece.name}: only ${match.matched}/${match.total} art paths match the sketch's own render`); continue; }
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { pens?: { id: string; width: number }[] };
    const branch = spawnSync('git', ['branch', '--contains', report.build.hash, '--format=%(refname:short)'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n')[0]?.trim() || null;
    mkdirSync(target, { recursive: true });
    for (const [from, to] of [['source/render.svg', 'render.svg'], ['source/render.png', 'render.png'], ['plot-ready.svg', 'plot-ready.svg'],
      ['config.json', 'config.json'], ['request.json', 'request.json'], ['report.json', 'finalize-report.json']]) copyFileSync(join(dir, from), join(target, to));
    let assembly: AssemblyEntry | undefined;
    if (report.assembly) {
      // Only a preview composed from the plies as they are now goes in; a copy from an earlier queueing is taken out.
      const state = previewState(stack, report.assembly.name);
      if (state === 'fresh') copyFileSync(join(previewDir(stack, report.assembly.name), 'assembled.png'), join(target, 'assembled.png'));
      else rmSync(join(target, 'assembled.png'), { force: true });
      assembly = await assemblyEntry(stack, report.assembly, `${prefix}-${date}-`, state === 'fresh', state === 'stale');
    }
    writeFileSync(join(target, 'index.md'), indexMarkdown(piece, report, config, { stackPath: relative(ROOT, resolve(stackPath)), prefix, date, notes: notes[piece.name], branch, art: { identity: plain.identity, match }, ...(assembly ? { assembly } : {}) }));
    console.log(`OK    ${piece.name}: ${target} (${report.minutes} min, ${report.pens} pens)`);
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error((e as Error).message); process.exitCode = 2; });
}
