import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { composeAssembly, previewAssembly } from '../../cli/assembly.ts';
import { readPlyResult, worldCuts } from '../../cli/assembly-world.ts';
import { BAR, placed } from './fixtures/assembly-fixture.ts';
import { fresh, finalize, lBlack, lWhite, rSpec, rWhite, stackIn } from './helpers/assembly-stack.ts';
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
});
