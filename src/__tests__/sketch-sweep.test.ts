import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { parseVary, runSweep } from '../../cli/sketch/sweep.ts';

const entry = join(import.meta.dirname, 'fixtures', 'sweep-sketch.ts');
const dirs: string[] = [];
const outDir = () => { const d = mkdtempSync(join(tmpdir(), 'sweep-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('runSweep', () => {
  it('renders the product of two axes in row-major order into one labelled sheet', async () => {
    const out = outDir();
    const r = await runSweep({ entry, vary: [{ id: 'tilt', values: [0, 10] }, { id: 'rows', values: [1, 2, 3] }], params: {}, seed: 1, out, cellPx: 120 });
    expect(r.cells.map(c => [c.params.tilt, c.params.rows])).toEqual([[0, 1], [0, 2], [0, 3], [10, 1], [10, 2], [10, 3]]);
    const png = PNG.sync.read(readFileSync(r.sheet));
    expect(png.width).toBeGreaterThanOrEqual(3 * 120);
    expect(png.height).toBeGreaterThan(2 * 60);
    expect(PNG.sync.read(readFileSync(r.cells[0].png)).width).toBeGreaterThan(0);
    const json = JSON.parse(readFileSync(join(out, 'sweep.json'), 'utf8'));
    expect(json.cells).toHaveLength(6);
  }, 60_000);

  it('treats one axis as one row and merges base params', async () => {
    const r = await runSweep({ entry, vary: [{ id: 'tilt', values: [4, 8, 12] }], params: { rows: 3 }, out: outDir(), cellPx: 100 });
    expect(r.cells.map(c => c.params)).toEqual([4, 8, 12].map(tilt => ({ rows: 3, tilt })));
  }, 60_000);

  it('refuses more than 25 cells or an empty axis', async () => {
    const six = [1, 2, 3, 4, 5, 6];
    await expect(runSweep({ entry, vary: [{ id: 'tilt', values: six }, { id: 'rows', values: six }], out: outDir() })).rejects.toThrow(/cap of 25/);
    await expect(runSweep({ entry, vary: [{ id: 'tilt', values: [] }], out: outDir() })).rejects.toThrow(/at least one value/);
  });
});

describe('parseVary', () => {
  it('types numbers and booleans', () => {
    expect(parseVary('a=1,2.5,true,x')).toEqual({ id: 'a', values: [1, 2.5, true, 'x'] });
    expect(() => parseVary('nope')).toThrow();
  });
});
