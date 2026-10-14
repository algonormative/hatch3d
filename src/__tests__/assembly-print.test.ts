import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewAssembly } from '../../cli/assembly.ts';
import { signDirectory } from '../../cli/sign.ts';
import { sha256 } from './helpers/sign-fixture.ts';
import { L, R, fresh, finalize, piece, stackIn } from './helpers/assembly-stack.ts';

const hasVpype = spawnSync('vpype', ['--version']).status === 0;
const hasPlotterServer = existsSync(join(process.env.PLOTTER_SERVER_DIR ?? join(homedir(), 'git', 'plotter-server'), 'src', 'pen-plan.ts'));

describe.skipIf(!hasVpype || !hasPlotterServer)('assembly entries in the print queue (local vpype and plotter-server)', () => {
  // The first ply is named with capitals and spaces: finalize writes it under its slug, and the queue has to read it from there.
  const white = piece('Lintel L White', 'lintel-l', L, 'white'), black = piece('lintel-l-black', 'lintel-l', L, 'black'), right = piece('lintel-r-white', 'lintel-r', R, 'white');
  const out = fresh(), into = mkdtempSync(join(tmpdir(), 'assembly-queue-'));
  const stack = stackIn(out, [white, black, right]);
  const entry = (name: string) => join(into, `lintel-2026-10-14-${name}`);
  const frontmatter = (name: string) => readFileSync(join(entry(name), 'index.md'), 'utf8').split('---')[1];
  let queue: ReturnType<typeof spawnSync>;

  beforeAll(async () => {
    for (const p of stack.pieces) await finalize(stack, p);
    await previewAssembly(stack, 'lintel-l');
    // lintel-r is deliberately left without a preview.
    writeFileSync(join(out, 'stack.json'), JSON.stringify(stack));
    writeFileSync(join(out, 'notes.json'), JSON.stringify(Object.fromEntries(stack.pieces.map((p) => [p.name, `Notes for ${p.name}.`]))));
    queue = spawnSync(process.execPath, ['--import', 'tsx', 'cli/print-queue.ts', join(out, 'stack.json'), '--into', into, '--prefix', 'lintel', '--notes', join(out, 'notes.json'), '--date', '2026-10-14'], { cwd: process.cwd(), encoding: 'utf8' });
  }, 240_000);

  it('writes an entry for every ply, reading a piece whose name is not a slug from where finalize wrote it', () => {
    expect(queue.stdout).toMatch(/^OK +Lintel L White:/m);
    expect(queue.stdout.match(/^OK /gm)).toHaveLength(3);
    expect(queue.status).toBe(0);
    for (const name of ['Lintel L White', 'lintel-l-black', 'lintel-r-white']) expect(existsSync(join(entry(name), 'config.json'))).toBe(true);
  });

  it('records the assembly in the frontmatter, keeping the paper colour, and says how it is signed', () => {
    expect(frontmatter('Lintel L White')).toMatch(/^paper: "#f7f6f2"\nassembly: lintel-l\nply: white\nply_order: 1\/2\npaper_stock: white\nsign_pen: carbon\nsign_box: 50,112,80,120\n/m);
    expect(frontmatter('lintel-l-black')).toMatch(/^assembly: lintel-l\nply: black\nply_order: 2\/2\npaper_stock: black\nsign: false\n/m);
    expect(frontmatter('lintel-r-white')).toContain('assembly: lintel-r');
  });

  it('copies in the preview when there is one, and only then', () => {
    expect(existsSync(join(entry('Lintel L White'), 'assembled.png'))).toBe(true);
    expect(readFileSync(join(entry('lintel-l-black'), 'index.md'), 'utf8')).toContain('![assembled preview](assembled.png)');
    expect(existsSync(join(entry('lintel-r-white'), 'assembled.png'))).toBe(false);
    expect(readFileSync(join(entry('lintel-r-white'), 'index.md'), 'utf8')).not.toContain('assembled.png');
  });

  it('says where the part goes and which sheet receives it', () => {
    const l = readFileSync(join(entry('lintel-l-black'), 'index.md'), 'utf8');
    expect(l).toContain('Keep `bar`: glue onto `lintel-r` as `bar`, aligning to the placement ticks.');
    expect(l).toContain('| 1 white | white | `lintel-2026-10-14-Lintel L White` |');
    const r = readFileSync(join(entry('lintel-r-white'), 'index.md'), 'utf8');
    expect(r).toContain('This sheet receives onlay `bar`, the part `lintel-l/black/bar`');
    expect(r).toContain('| 2 bar | black | onlay: cut from `lintel-l/black/bar`, not plotted |');
  });

  it('signs the signing ply into its existing carbon layer, in the box, and leaves the others alone', () => {
    const run = { handle: '@algonormative', dry: false };
    expect(signDirectory(entry('lintel-l-black'), run)).toMatch(/skipped .*sign: false/);
    expect(signDirectory(entry('lintel-r-white'), run)).toMatch(/skipped .*sign: false/);
    const target = entry('Lintel L White');
    const before = readFileSync(join(target, 'plot-ready.svg'), 'utf8');
    expect(signDirectory(target, run)).toMatch(/^signed /);
    const after = readFileSync(join(target, 'plot-ready.svg'), 'utf8');
    // The layer count is the one plotter-server checks; the signature sits in the carbon layer, within the sketch's box.
    expect(after.match(/inkscape:groupmode="layer"/g)).toHaveLength(before.match(/inkscape:groupmode="layer"/g)!.length);
    const carbon = after.split(/(?=<g inkscape:groupmode="layer")/).find((layer) => layer.includes('data-pen-id="carbon"'))!;
    expect(carbon).toContain('<g id="signature"');
    const points = [...after.match(/<g id="signature"[^>]*><path d="([^"]+)"/)![1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.max(...points.map((p) => p[0]))).toBeLessThanOrEqual(80);
    expect(Math.max(...points.map((p) => p[1]))).toBeCloseTo(120, 1);
    expect(Math.min(...points.map((p) => p[0]))).toBeGreaterThanOrEqual(50);
    expect(Math.min(...points.map((p) => p[1]))).toBeGreaterThanOrEqual(112);
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toContain(sha256(after));
    const check = spawnSync(process.execPath, ['--import', 'tsx', 'cli/plotter-check.ts', target], { cwd: process.cwd(), encoding: 'utf8' });
    expect(check.stdout).toMatch(/^OK .*negative control rejected/m);
  });
});
