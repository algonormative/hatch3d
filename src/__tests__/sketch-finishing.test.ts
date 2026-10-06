import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { applyFinishing, mapFinishingAssetMetadata, resolveFinishing } from '../sketch/finishing.ts';
import { generateBorderPaths, generateBorderPolylines, PAPER_SIZES } from '../utils/page-finishing.ts';
import type { FinishingOptions, Page, Part, Pen } from '../sketch/types.ts';

const sourcePage: Page = { width: 100, height: 100, margin: 10, paper: '#ffffff' };
const pens: Pen[] = [{ id: 'ink', color: '#111111', width: 0.3 }];
let dir: string | undefined;

async function entry(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'hatch3d-finishing-'));
  const path = join(dir, 'sketch.ts');
  await writeFile(path, `export default {
    name:'finish', page:{width:100,height:100,margin:10,paper:'#ffffff'},
    pens:[{id:'ink',color:'#111111',width:0.3}], controls:[],
    assets:{}, draw(){return [{id:'art',pen:'ink',boundary:[[{x:20,y:20},{x:30,y:20},{x:30,y:30}]],paths:[[{x:-20,y:50},{x:100,y:50}]]}]}
  };`);
  return path;
}
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('sketch finishing', () => {
  it('preserves legacy SVG and identity when absent, then fits A4 portrait without scaling pen width', async () => {
    const path = await entry();
    const before = await renderSketch({ entry: path });
    const again = await renderSketch({ entry: path });
    expect(before.svg).toBe(again.svg);
    expect(before.identity).toBe(again.identity);
    expect(before.svg).toContain('data-passes="1"');
    expect(before.finishing).toBeUndefined();
    expect(before.metadata.sourcePage).toBeUndefined();
    const after = await renderSketch({ entry: path, finishing: { page: { width: PAPER_SIZES.a4.h, height: PAPER_SIZES.a4.w } } });
    expect(after.metadata.page).toEqual({ width: 210, height: 297, margin: 10, paper: '#ffffff' });
    expect(after.metadata.sourcePage).toEqual(sourcePage);
    expect(after.parts[0].paths[0]).toEqual([{ x: 10, y: 148.5 }, { x: 200, y: 148.5 }]);
    expect(after.parts[0].boundary?.[0][0]).toEqual({ x: 33.75, y: 77.25 });
    expect(after.metadata.pens[0].width).toBe(0.3);
    expect(after.svg).toContain('stroke-width="0.3"');
    expect(after.identity).not.toBe(before.identity);
  });

  it('makes real plotter geometry for every border and clips crop marks to the physical sheet', () => {
    const styles = ['simple', 'double', 'ticked', 'cropmarks'] as const;
    for (const style of styles) {
      const resolved = resolveFinishing(sourcePage, pens, { border: { style, pen: 'ink' } });
      const parts = applyFinishing([{ id: 'art', pen: 'ink', paths: [[{ x: 0, y: 50 }, { x: 100, y: 50 }]] }], resolved, 0);
      const border = parts.at(-1)!;
      expect(border).toMatchObject({ id: 'finishing-border', pen: 'finishing-border' });
      expect(border.paths.length).toBeGreaterThan(0);
      expect(resolved.pens.at(-1)).toMatchObject({ id: 'finishing-border', color: '#111111', width: 0.3 });
      for (const path of border.paths) for (const point of path) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(100);
        expect(point.y).toBeLessThanOrEqual(100);
      }
      expect(generateBorderPolylines(style, 100, 100, 10).length).toBe(generateBorderPaths(style, 100, 100, 10, 0.3).length);
      if (style === 'double') {
        expect(parts[0].paths[0]).toEqual([{ x: 12, y: 50 }, { x: 88, y: 50 }]);
        expect(border.paths).toHaveLength(2);
        expect(border.paths[1][0]).toEqual({ x: 12, y: 12 });
      }
    }
    const tiny = resolveFinishing({ width: 20, height: 20, margin: 5 }, pens, { border: { style: 'cropmarks', pen: 'ink' } });
    expect(applyFinishing([], tiny, 0)[0].paths.length).toBeGreaterThan(0);
    for (const path of applyFinishing([], tiny, 0)[0].paths) for (const p of path) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(20);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(20);
    }
  });

  it('fits artwork inside an independent border inset and clear content gap', () => {
    const options = { border: { style: 'double', pen: 'ink', inset: 12, contentGap: 6 } } as FinishingOptions;
    const resolved = resolveFinishing(sourcePage, pens, options);
    expect(resolved.contentRect).toEqual({ xMin: 20.3, yMin: 20.3, xMax: 79.7, yMax: 79.7 });
    const parts = applyFinishing([{ id: 'art', pen: 'ink', paths: [[{ x: 10, y: 50 }, { x: 90, y: 50 }]] }], resolved, 0);
    expect(parts[0].paths[0]).toEqual([{ x: 20.3, y: 50 }, { x: 79.7, y: 50 }]);
    expect(parts[1].paths[0][0]).toEqual({ x: 12, y: 12 });
    expect(parts[1].paths[1][0]).toEqual({ x: 14, y: 14 });
    expect(() => resolveFinishing(sourcePage, pens, { border: { style: 'cropmarks', pen: 'ink', inset: 9, contentGap: 6 } })).toThrow(/inset/);
    expect(() => resolveFinishing(sourcePage, pens, { border: { style: 'simple', pen: 'ink', inset: 12, contentGap: -1 } })).toThrow(/contentGap/);
  });

  it('rejects invalid physical values, unknown keys and pen references before processing', () => {
    const invalid: unknown[] = [
      { bogus: true }, { page: { width: 210 } }, { page: { width: Infinity, height: 297 } },
      { page: { width: 210, height: 297, margin: 106 } }, { page: { width: 210, height: 297, bogus: 1 } },
      { border: { style: 'fake', pen: 'ink' } }, { border: { style: ['simple'], pen: 'ink' } }, { border: { style: 'simple', pen: 'missing' } },
      { pens: { missing: { width: 1 } } }, { pens: { ink: { width: NaN } } },
      { pens: { ink: { passes: 0 } } }, { pens: { ink: { passes: 1.5 } } },
      { pens: { ink: { passes: 101 } } }, { pens: { ink: { bogus: 1 } } },
      { density: { maxDensity: 1, cellSize: 0 } }, { density: { maxDensity: 1, cellSize: 0.001 } },
    ];
    for (const value of invalid) expect(() => resolveFinishing(sourcePage, pens, value)).toThrow();
    expect(() => resolveFinishing({ width: 4, height: 4 }, pens, { border: { style: 'double', pen: 'ink' } })).toThrow(/Double border/);
    expect(() => applyFinishing([{ id: 'finishing-border', pen: 'ink', paths: [] }], resolveFinishing(sourcePage, pens, { border: { style: 'simple', pen: 'ink' } }), 0)).toThrow(/collision/);
  });

  it('maps asset overlays and keeps globally filtered two-point paths deterministic', () => {
    const options: FinishingOptions = { page: { width: 210, height: 297 }, density: { maxDensity: 1, cellSize: 10 }, pens: { ink: { passes: 3, color: '#222222' } } };
    const resolved = resolveFinishing(sourcePage, pens, options);
    expect(resolved.pens[0]).toMatchObject({ color: '#222222', passes: 3, width: 0.3 });
    const mapped = mapFinishingAssetMetadata({ image: { path: 'image.png', fit: 'contain', dataUrl: 'data:image/png;base64,AA==', width: 10, height: 10, box: { x: 20, y: 20, width: 10, height: 10 } } }, resolved);
    expect(mapped.image.box).toEqual({ x: 33.75, y: 77.25, width: 23.75, height: 23.75 });
    const raw: Part[] = Array.from({ length: 12 }, (_, i) => ({ id: `art${i}`, pen: 'ink', paths: [[{ x: 10, y: 50 }, { x: 90, y: 50 }]] }));
    const a = applyFinishing(raw, resolved, 19);
    const b = applyFinishing(raw, resolved, 19);
    expect(a).toEqual(b);
    expect(a.flatMap((p) => p.paths).length).toBeLessThan(12);
    for (const path of a.flatMap((p) => p.paths)) expect(path).toEqual([{ x: 10, y: 148.5 }, { x: 200, y: 148.5 }]);
  });
});
