import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { landmarksOf, readabilityCrops } from '../../cli/sketch/crops.ts';
import type { Part } from '../sketch/types.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

/** White image, 200 x 300 px for a 100 x 150 mm area (2 px/mm), with a red square at mm (10..30, 100..120). */
function sheet(): Buffer {
  const png = new PNG({ width: 200, height: 300 });
  png.data.fill(255);
  for (let y = 200; y < 240; y++) for (let x = 20; x < 60; x++) { const k = (y * 200 + x) * 4; png.data[k] = 255; png.data[k + 1] = 0; png.data[k + 2] = 0; }
  return PNG.sync.write(png);
}
const redShare = (png: PNG): number => { let n = 0; for (let k = 0; k < png.data.length; k += 4) if (png.data[k] > 200 && png.data[k + 1] < 60) n++; return n / (png.data.length / 4); };

async function run(opts: { page: { width: number; height: number; margin?: number }; trimmed?: boolean; bytes?: Buffer }) {
  const dir = await mkdtemp(join(tmpdir(), 'crops-')); dirs.push(dir);
  const image = join(dir, 'in.png');
  await writeFile(image, opts.bytes ?? sheet());
  const out = join(dir, 'out');
  const res = await readabilityCrops({ image, page: opts.page, trimmed: opts.trimmed, sizeMm: 20, out, at: { square: { x: 20, y: 110 }, empty: { x: 80, y: 30 } } });
  return { res, read: async (f: string) => PNG.sync.read(await readFile(f)) };
}

describe('readabilityCrops', () => {
  it('writes a thumbnail of the requested height and square 600 px crops', async () => {
    const { res, read } = await run({ page: { width: 100, height: 150 } });
    const thumb = await read(res.thumb);
    expect(thumb.height).toBe(240);
    expect(thumb.width).toBe(160);
    expect(Object.keys(res.crops).sort()).toEqual(['empty', 'square']);
    const crop = await read(res.crops.square);
    expect([crop.width, crop.height]).toEqual([600, 600]);
  });

  it('maps page mm to pixels: the crop at the square is red, one elsewhere is not', async () => {
    const { res, read } = await run({ page: { width: 100, height: 150 } });
    expect(redShare(await read(res.crops.square))).toBeGreaterThan(0.95);
    expect(redShare(await read(res.crops.empty))).toBe(0);
  });

  it('offsets by the margin when the image covers only the trim', async () => {
    // Same pixels, now meaning the page inset by 5 mm: the square is at page mm (15..35, 105..125), centre (25, 115).
    const { res, read } = await run({ page: { width: 110, height: 160, margin: 5 }, trimmed: true });
    const exact = await readabilityCrops({ image: join(res.thumb, '..', '..', 'in.png'), page: { width: 110, height: 160, margin: 5 }, trimmed: true, sizeMm: 20, out: join(res.thumb, '..', 'b'), at: { square: { x: 25, y: 115 }, wrong: { x: 20, y: 110 } } });
    expect(redShare(await read(exact.crops.square))).toBeGreaterThan(0.95);
    expect(redShare(await read(exact.crops.wrong))).toBeLessThan(0.8);
  });

  it('pads with white beyond the image edge', async () => {
    const { res, read } = await run({ page: { width: 100, height: 150 } });
    const dir = join(res.thumb, '..');
    const edge = await readabilityCrops({ image: join(dir, '..', 'in.png'), page: { width: 100, height: 150 }, sizeMm: 20, out: dir, at: { corner: { x: 0, y: 0 } } });
    const png = await read(edge.crops.corner);
    expect(png.data[0]).toBe(255);
    expect(png.data[(599 * 600 + 599) * 4 + 1]).toBe(255);
  });
});

describe('landmarksOf', () => {
  const part = (id: string, x: number, y: number): Part => ({ id, pen: 'cut', paths: [[{ x, y }, { x: x + 1, y }]], diagnostic: true });
  it('reads the first point of landmark-* parts and ignores the rest', () => {
    const parts: Part[] = [part('landmark-nose', 12, 34), part('landmark-eyes', 5, 6), part('outline', 99, 99), { id: 'landmark-empty', pen: 'cut', paths: [] }];
    expect(landmarksOf(parts)).toEqual({ nose: { x: 12, y: 34 }, eyes: { x: 5, y: 6 } });
  });
});
