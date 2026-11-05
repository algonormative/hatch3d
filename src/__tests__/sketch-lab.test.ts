import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkSheets, cutsByPly, randomStream, renderSheets, sheetSvg } from '../../cli/sketch/lab/runtime.ts';
import type { Part, Sketch } from '../sketch/types.ts';

/** The CLI's stream (cli/sketch/child.ts), with Node's SHA-256. */
function cliStream(seed: number, partId: string): () => number {
  let state = createHash('sha256').update(`${seed}\0${partId}`).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lines: Sketch = {
  name: 'Lines',
  page: { width: 100, height: 60, margin: 5, paper: '#f4ede0' },
  pens: [{ id: 'ink', color: '#222222', width: 0.3 }],
  controls: [{ type: 'slider', id: 'len', label: 'Length', default: 20, min: 1, max: 80, step: 1 }],
  draw: ctx => [{ id: 'line', pen: 'ink', paths: [[{ x: 10, y: 10 + 30 * ctx.random('y')() }, { x: 10 + Number(ctx.params.len), y: 10 }]] }],
};

describe('sketch lab runtime', () => {
  it('draws with the CLI\'s random streams, across seeds and ids of one and two hash blocks', () => {
    for (const seed of [0, 1, 41, 123456]) for (const id of ['plates', 'glitch-12', 'x', 'a'.repeat(70)]) {
      const a = randomStream(seed, id), b = cliStream(seed, id);
      for (let i = 0; i < 4; i++) expect(a()).toBe(b());
    }
  });

  it('renders a plain sketch as one sheet on its paper, its ink by pen, and its SVG', async () => {
    const [sheet] = await renderSheets(lines, { len: 50 }, 3);
    expect(sheet).toMatchObject({ id: 'sheet', paper: '#f4ede0', onlay: false });
    expect(sheet.layers.map(l => l.pen)).toEqual(['ink']);
    const { xy, starts } = sheet.layers[0].paths;
    expect([...starts]).toEqual([0, 2]);
    expect(xy[2]).toBeCloseTo(60, 5);
    expect(xy[1]).toBeCloseTo(10 + 30 * cliStream(3, 'y')(), 3);
    expect(await sheetSvg(lines, { len: 50 }, 3)).toContain('data-pen-id="ink"');
  });

  it('checks a set for the plotter: its ink by pen, or the sketch\'s own refusal', async () => {
    const good = await checkSheets(lines, { len: 50 }, 0);
    expect(good.ok).toBe(true);
    expect(good.sheets[0].pens[0]).toMatchObject({ pen: 'ink', paths: 1 });
    expect(good.sheets[0].pens[0].metres).toBeGreaterThan(0.04);
    const refusing: Sketch = { ...lines, draw: () => { throw new Error('feature finer than the guide pen'); } };
    expect(await checkSheets(refusing, {}, 0)).toMatchObject({ ok: false, error: 'feature finer than the guide pen' });
  });

  it('reads each ply\'s cuts from the assembly diagnostics, the longest ply id first', () => {
    const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }];
    const parts: Part[] = [
      { id: 'asm-black-windows', pen: 'cut', paths: [ring], diagnostic: true },
      { id: 'asm-black-gold-bar', pen: 'cut', paths: [ring, ring], diagnostic: true },
      { id: 'asm-signature', pen: 'cut', paths: [ring], diagnostic: true },
      { id: 'art', pen: 'ink', paths: [ring] },
    ];
    const cuts = cutsByPly(parts, ['black', 'black-gold', 'gold']);
    expect(cuts.get('black')).toHaveLength(1);
    expect(cuts.get('black-gold')).toHaveLength(2);
    expect(cuts.get('gold')).toHaveLength(0);
  });
});
