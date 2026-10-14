import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { composeAssembly, previewAssembly } from '../../cli/assembly.ts';
import { readPlyResult, worldCuts, worldSha256 } from '../../cli/assembly-world.ts';
import { BAR, placed } from './fixtures/assembly-fixture.ts';
import { FIXTURES, fresh, finalize, lBlack, lWhite, piece, rSpec, rWhite, stackIn } from './helpers/assembly-stack.ts';
import type { Point } from '../sketch/types.ts';

const P = (x: number, y: number): Point => ({ x, y });
const hasVpype = spawnSync('vpype', ['--version']).status === 0;

describe.skipIf(!hasVpype)('assembly preview (local vpype)', () => {
  const out = fresh();
  const stack = stackIn(out, [lWhite, lBlack, rWhite]);
  const dir = (name: string) => join(out, name);

  beforeAll(async () => {
    for (const p of stack.pieces) await finalize(stack, p);
  }, 180_000);

  const SCALE = 4, TRIM = 16; // pixels per millimetre; the crop marks stand at the page margin
  const read = (path: string) => PNG.sync.read(readFileSync(path));
  const at = (png: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round((y - TRIM) * SCALE) * png.width + Math.round((x - TRIM) * SCALE)) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const is = (rgb: [number, number, number], hex: string, tolerance = 6) => [1, 3, 5].every((k, c) => Math.abs(rgb[c] - parseInt(hex.slice(k, k + 2), 16)) <= tolerance);
  const WHITE = '#f7f6f2', BLACK = '#141416';
  let l: PNG, r: PNG;

  beforeAll(async () => {
    const [lDir, rDir] = [await previewAssembly(stack, 'lintel-l', { shadow: true }), await previewAssembly(stack, 'lintel-r')];
    [l, r] = [read(join(lDir, 'assembled.png')), read(join(rDir, 'assembled.png'))];
  }, 60_000);

  it('trims at the crop marks and writes the three files', () => {
    expect([l.width, l.height]).toEqual([68 * SCALE, 108 * SCALE]);
    for (const f of ['assembled.svg', 'assembled.png', 'exploded.png']) expect(existsSync(join(out, '_assembly', 'lintel-l', f))).toBe(true);
    expect(read(join(out, '_assembly', 'lintel-r', 'exploded.png')).width).toBeGreaterThan(2 * 400);
  });

  it('shows the lower paper through a window, and not the X ink that was plotted in the waste', () => {
    expect(is(at(l, 30, 35), WHITE)).toBe(true); // the white ply, between its lines
    expect(is(at(l, 64, 40), BLACK)).toBe(true); // black paper outside the window
    const guide = readPlyResult(dir('lintel-l-black')).parts.find((p) => p.id === 'cut-w')!;
    const x = guide.paths.find((path) => path.length === 2)!; // an X stroke, plotted in gold on the black ply
    const mid = P((x[0].x + x[1].x) / 2, (x[0].y + x[1].y) / 2);
    expect(is(at(l, mid.x, mid.y), WHITE), 'the waste, with its X, is gone').toBe(true);
  });

  it('shows the lower paper through the hole a part leaves', () => {
    expect(is(at(l, 30, 83), WHITE)).toBe(true);
    expect(is(at(l, 30, 100), BLACK)).toBe(true);
  });

  it('puts the onlay on its footprint: its own paper inside, the sheet’s outside', () => {
    // The footprint is x 43..57, y 32..88. Sample between the ink lines of both plies.
    expect(is(at(r, 50, 42), BLACK)).toBe(true);
    expect(is(at(r, 50, 75), BLACK)).toBe(true);
    expect(is(at(r, 44, 47), BLACK), 'just inside the left edge').toBe(true);
    expect(is(at(r, 42, 47), WHITE), 'just outside the left edge').toBe(true);
    expect(is(at(r, 50, 30), WHITE)).toBe(true);
    expect(is(at(r, 30, 41), WHITE)).toBe(true);
    // And the footprint is where panel R says it is.
    const footprint = worldCuts(readPlyResult(dir('lintel-r-white')).parts, rSpec).find((c) => c.ply === 'bar')!;
    expect(footprint.rings[0]).toEqual(placed(BAR));
  });

  it('draws a shadow under a lifted ply only when asked', async () => {
    expect((await composeAssembly(stack, 'lintel-l', { shadow: true })).svg).toMatch(/<feDropShadow dx="0" dy="0.4"/);
    expect((await composeAssembly(stack, 'lintel-l')).svg).not.toMatch(/feDropShadow/);
  });

  describe('what it will and will not compose', () => {
    /** A copy of the finalized stack, so a test can break it without breaking the others. */
    const copy = () => { const to = fresh(); cpSync(out, to, { recursive: true }); return { to, stack: stackIn(to, [lWhite, lBlack, rWhite]) }; };
    const edit = (path: string, change: (json: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const json = JSON.parse(readFileSync(path, 'utf8'));
      change(json);
      writeFileSync(path, JSON.stringify(json, null, 2));
    };

    it('refuses a ply whose report says one world and whose render another, the half-written state of an interrupted run', async () => {
      const { to, stack: broken } = copy();
      edit(join(to, 'lintel-l-black', 'report.json'), (report) => { report.assembly.worldSha256 = 'f'.repeat(64); });
      await expect(composeAssembly(broken, 'lintel-l')).rejects.toThrow(/lintel-l-black is in a mixed state: its report says world ffffffffffff and its render another; finalize the whole stack again/);
    });

    it('refuses plies that each agree with themselves but were not finalized from one world', async () => {
      const { to, stack: broken } = copy();
      const resultPath = join(to, 'lintel-l-white', 'source', 'result.json');
      edit(resultPath, (result) => { for (const part of result.parts) if (part.id === 'asm-black-w') for (const path of part.paths) for (const point of path) point.x += 3; });
      edit(join(to, 'lintel-l-white', 'report.json'), (report) => { report.assembly.worldSha256 = worldSha256(readPlyResult(join(to, 'lintel-l-white')).parts); });
      await expect(composeAssembly(broken, 'lintel-l')).rejects.toThrow(/lintel-l-white and lintel-l-black were not finalized from one world; finalize the whole stack again/);
    });

    it('refuses plies finalized on pages or borders that do not match, not only of another size', async () => {
      const { to, stack: broken } = copy();
      edit(join(to, 'lintel-l-white', 'source', 'result.json'), (result) => { result.metadata.page.margin = 10; result.finishing.page.margin = 10; });
      await expect(composeAssembly(broken, 'lintel-l')).rejects.toThrow(/lintel-l-white and lintel-l-black were not finalized on the same page and border: margin 10 mm against margin 16 mm/);
      const bordered = copy();
      edit(join(bordered.to, 'lintel-l-white', 'source', 'result.json'), (result) => { result.finishing.border.inset = 12; });
      await expect(composeAssembly(bordered.stack, 'lintel-l')).rejects.toThrow(/not finalized on the same page and border: the border differs/);
    });

    it('needs every finalized file of a ply, the plot-ready.png of the exploded view included', async () => {
      const { to, stack: broken } = copy();
      rmSync(join(to, 'lintel-l-white', 'plot-ready.png'));
      await expect(composeAssembly(broken, 'lintel-l')).rejects.toThrow(/lintel-l-white is not finalized \(no plot-ready\.png\)/);
    });

    it('records what it composed beside the picture: each ply’s plot-ready.svg and the world', async () => {
      const dirOut = await previewAssembly(stack, 'lintel-l');
      const recorded = JSON.parse(readFileSync(join(dirOut, 'assembled.json'), 'utf8')) as { assembly: string; worldSha256: string; plies: { ply: string; piece: string; plotReadySha256: string }[] };
      expect(recorded.assembly).toBe('lintel-l');
      expect(recorded.worldSha256).toBe(JSON.parse(readFileSync(join(dir('lintel-l-white'), 'report.json'), 'utf8')).assembly.worldSha256);
      expect(recorded.plies.map((p) => [p.ply, p.piece])).toEqual([['white', 'lintel-l-white'], ['black', 'lintel-l-black']]);
      const sha = (name: string) => createHash('sha256').update(readFileSync(join(dir(name), 'plot-ready.svg'))).digest('hex');
      expect(recorded.plies.map((p) => p.plotReadySha256)).toEqual([sha('lintel-l-white'), sha('lintel-l-black')]);
    });
  });

  describe('trimmed at an explicit border inset', () => {
    it('trims at the crop marks’ inset, not the page margin, when the cut inks are of one width so the plies still register', async () => {
      const [white, black] = [piece('equal-white', 'equal', `${FIXTURES}/assembly-lintel-l-equalink-sketch.ts`, 'white'), piece('equal-black', 'equal', `${FIXTURES}/assembly-lintel-l-equalink-sketch.ts`, 'black')];
      const s = stackIn(fresh(), [white, black], { border: { style: 'cropmarks', pen: 'black', inset: 12, contentGap: 1 }, defaults: { trialInks: true } });
      for (const p of s.pieces) await finalize(s, p);
      const dirOut = await previewAssembly(s, 'equal');
      const png = read(join(dirOut, 'assembled.png'));
      expect([png.width, png.height]).toEqual([(100 - 24) * SCALE, (140 - 24) * SCALE]);
    }, 120_000);
  });
});
