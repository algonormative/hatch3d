import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { artMatch } from '../../cli/art-match.ts';
import { readBaselines } from '../../cli/baselines.ts';
import { checkPiece, recolourLastLayer } from '../../cli/plotter-check.ts';
import { indexMarkdown } from '../../cli/print-queue.ts';
import { changedRegions } from '../../cli/sheet.ts';

/** A stand-in for plotter-server's pen-plan module: layers are `<g … stroke="…">` tags. */
const stubPlan = (validate: (canonical: string, prepared: string) => void) => ({
  validatePreparedPenPlan: validate,
  buildPenPlan: (svg: string) => [...svg.matchAll(/<g /g)].map((_, i) => ({ layer: i + 1 })),
  findSvgLayerTags: (svg: string) => [...svg.matchAll(/<g ([^>]*)>/g)].map(m => ({
    start: m.index!, end: m.index! + m[0].length,
    attributes: Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]])),
  })),
});
const svg = (strokes: string[]) => `<svg>${strokes.map(s => `<g stroke="${s}"><path d="M0,0L1,1"/></g>`).join('')}</svg>`;

function pieceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'print-tools-'));
  mkdirSync(join(dir, 'source'));
  writeFileSync(join(dir, 'source', 'render.svg'), svg(['#111111', '#222222']));
  writeFileSync(join(dir, 'plot-ready.svg'), svg(['#111111', '#222222']));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ layers: [{}, {}] }));
  return dir;
}

describe('plotter-check', () => {
  it('recolours only the last pen layer for its negative control', () => {
    const out = recolourLastLayer(svg(['#111111', '#222222']), stubPlan(() => {}));
    expect(out).toContain('stroke="#111111"');
    expect(out).not.toContain('stroke="#222222"');
  });

  it('passes a piece only when the checks also reject the negative control', () => {
    const strict = stubPlan((a, b) => { if (stubPlan(() => {}).findSvgLayerTags(a).map(t => t.attributes.stroke).join() !== stubPlan(() => {}).findSvgLayerTags(b).map(t => t.attributes.stroke).join()) throw new Error('changed pen color'); });
    expect(checkPiece(pieceDir(), strict)).toMatchObject({ ok: true, layers: 2, steps: 2, rejected: 'changed pen color' });
    const asleep = checkPiece(pieceDir(), stubPlan(() => {}));
    expect(asleep.ok).toBe(false);
    expect(asleep.error).toMatch(/negative control was accepted/);
  });
});

describe('art-match', () => {
  const plain = `<svg><g stroke="#000"><path d="M10,10L50,20L90,90"/><path d="M5,80L60,5"/></g></svg>`;
  const fit = (d: string, s: number, dx: number, dy: number) => d.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, x, y) => `${(s * x + dx).toFixed(3)},${(s * y + dy).toFixed(3)}`);
  const print = (d1: string, d2: string) => `<svg><g stroke="#000"><path d="${fit(d1, 0.98, 2.5, 4)}"/><path d="${fit(d2, 0.98, 2.5, 4)}"/></g><g inkscape:label="7-finishing-border"><path d="M0,0L200,0"/></g></svg>`;

  it('finds every art path under the border fit, ignoring the finishing layer', () => {
    const r = artMatch(plain, print('M10,10L50,20L90,90', 'M5,80L60,5'));
    expect(r.ok).toBe(true);
    expect(r.scale).toBeCloseTo(0.98, 4);
    expect(r.matched).toBe(2);
  });

  it('fails when a path has moved', () => {
    expect(artMatch(plain, print('M10,10L50,20L90,90', 'M5,80L60,6')).ok).toBe(false);
  });
});

describe('sheet diff', () => {
  const png = (mark: boolean) => {
    const p = new PNG({ width: 200, height: 200 });
    p.data.fill(255);
    if (mark) for (let y = 130; y < 140; y++) for (let x = 20; x < 30; x++) p.data.fill(0, (y * 200 + x) * 4, (y * 200 + x) * 4 + 3);
    return PNG.sync.write(p);
  };

  it('finds the one changed region, and none between identical renders', () => {
    const { changed, regions } = changedRegions(png(false), png(true));
    expect(changed).toBe(100);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ x0: 0, y0: 120, x1: 60, y1: 180 });
    expect(changedRegions(png(true), png(true)).regions).toHaveLength(0);
  });
});

describe('baselines', () => {
  it('records a 64-hex identity for every print seed, each pointing at a sketch that exists', () => {
    const entries = readBaselines();
    expect(entries.length).toBeGreaterThanOrEqual(12);
    for (const b of entries) {
      expect(b.identity).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(resolve(b.entry))).toBe(true);
    }
  });
});

describe('print-queue entry', () => {
  const piece = { name: 'xxi-world', title: 'Breach Tarot: XXI The World', sketch: 'sketches/breach-tarot/xxi-world/sketch.ts', seed: 3 };
  const report = { name: 'xxi-world', title: null, seed: 3, palette: 'phase-garden', paper: '#f4f0e6', build: { version: 'v1', hash: 'abc1234', dirty: false },
    layers: [{ layer: 1, paths: 4592, drawMm: 41200, travelMm: 9900, label: '1-carbon', color: '#22282c', passes: 1, minutes: 13.5 },
      { layer: 2, paths: 17, drawMm: 40, travelMm: 200, label: '2-lettering', color: '#22282c', passes: 1, minutes: 0.04 }],
    pens: 2, minutes: 24, sourceSha256: 'a'.repeat(64), preparedSha256: 'b'.repeat(64) };
  const config = { pens: [{ id: 'carbon', width: 0.25 }, { id: 'lettering', width: 0.13 }] };
  const options = { stackPath: 'sketches/phase-garden/stacks/tarot.json', prefix: 'breach-tarot', date: '2026-10-07', notes: 'A card.', branch: 'main',
    art: { identity: 'c'.repeat(64), match: { scale: 0.98151, dx: 2.583, dy: 3.992, total: 12772, matched: 12772, worst: 0.001, ok: true } } };

  it('writes the frontmatter, the art identity, the pen plan and a fine-pen note for the lettering layer', () => {
    const md = indexMarkdown(piece, report, config, options);
    for (const line of ['status: prepped', 'composition: breach-tarot/xxi-world', 'seed: 3', 'build: abc1234', `art_identity: ${'c'.repeat(64)}`,
      '| 1-carbon | #22282c | 4,592 | 41.2 | 9.9 | 13.5 |', '- Layer 2 (lettering) is drawn at 0.13 mm, so use a fine pen.',
      '`node --import tsx cli/finalize.ts run sketches/phase-garden/stacks/tarot.json --only xxi-world`']) expect(md).toContain(line);
  });

  it('writes an entry that is not a ply of an assembly byte for byte as it always has', () => {
    const golden = readFileSync(resolve(import.meta.dirname, 'fixtures/print-queue-entry.golden.md'), 'utf8').replace('<ROOT>', resolve(import.meta.dirname, '../..'));
    expect(indexMarkdown(piece, report, config, options)).toBe(golden);
    // An assembly context without an assembly report changes nothing either.
    expect(indexMarkdown(piece, report, config, { ...options, assembly: { plies: [], keeps: [], receives: [], preview: true } })).toBe(golden);
  });

  describe('a ply of an assembly', () => {
    const assembly = { name: 'lintel-l', ply: 'black', index: 2, plies: 3, paper: { id: 'black', color: '#141416' }, cutPen: 'black', cutInk: 'gold',
      cuts: [{ id: 'w', kind: 'waste' as const }, { id: 'bar', kind: 'part' as const }], onlays: [], worldSha256: 'd'.repeat(64) };
    const context = { preview: false, receives: [], keeps: [{ cut: 'bar', assembly: 'lintel-r', ply: 'bar' }],
      plies: [{ ply: 'white', paper: 'white', entry: 'lintel-2026-10-14-lintel-l-white' }, { ply: 'black', paper: 'black', entry: 'lintel-2026-10-14-lintel-l-black' }, { ply: 'top', paper: 'white', onlay: 'lintel-x/white/seal' }] };
    const md = (over = {}, ctx: object = {}) => indexMarkdown(piece, { ...report, palette: 'ply-black', paper: '#141416', assembly: { ...assembly, ...over } }, config, { ...options, assembly: { ...context, ...ctx } });

    it('records the panel, the ply, its order, its paper stock and whether it is signed, keeping the paper colour', () => {
      const text = md();
      for (const line of ['paper: "#141416"', 'assembly: lintel-l', 'ply: black', 'ply_order: 2/3', 'paper_stock: black', 'sign: false']) expect(text).toContain(line);
      expect(text).not.toMatch(/sign_pen|sign_box/);
      const signed = md({ signature: { pen: 'carbon', box: { x: 50, y: 112, width: 30, height: 8 } } });
      expect(signed).toContain('sign_pen: carbon');
      expect(signed).toContain('sign_box: 50,112,80,120');
      expect(signed).not.toContain('sign: false');
    });

    it('lists the plies bottom to top, the cuts and how to cut, and where the part goes', () => {
      const section = md().split('## Assembly')[1].split('## Status')[0];
      expect(section).toContain('| 1 white | white | `lintel-2026-10-14-lintel-l-white` |');
      expect(section).toContain('| 2 black | black | this entry |');
      expect(section).toContain('| 3 top | white | onlay: cut from `lintel-x/white/seal`, not plotted |');
      expect(section).toContain('| w | waste |');
      expect(section).toContain('| bar | part (kept) |');
      for (const line of ['Let the gel ink dry before cutting.', 'Cut waste along the **outer edge** of each outline.', 'Cut parts **down the middle** of the line.', 'Trim at the crop marks.', 'Square in an L-square, bottom ply first.',
        'Keep `bar`: glue onto `lintel-r` as `bar`, aligning to the placement ticks.']) expect(section).toContain(line);
      expect(section).not.toContain('assembled.png');
    });

    it('does not invent an entry for a ply that is not in the stack, or a home for a part nothing is cut from', () => {
      const section = md({}, { keeps: [{ cut: 'bar' }], plies: [{ ply: 'white', paper: 'white' }, { ply: 'black', paper: 'black', entry: 'x' }] }).split('## Assembly')[1];
      expect(section).toContain('| 1 white | white | not in this stack |');
      expect(section).toContain('Keep `bar`: no onlay in this stack is cut from it yet.');
      expect(section).not.toContain('glue onto');
    });

    it('says which part lands on a sheet that receives an onlay, and shows the preview only when it has one', () => {
      const sheet = md({ ply: 'white', index: 1, cuts: [] }, { keeps: [], receives: [{ ply: 'bar', from: 'lintel-l/black/bar' }], preview: true });
      expect(sheet).toContain('This sheet receives onlay `bar`, the part `lintel-l/black/bar`');
      expect(sheet).toContain('This ply has no cuts.');
      expect(sheet).toContain('![assembled preview](assembled.png)');
      expect(sheet).toContain('- `assembled.png` previews the panel');
    });
  });
});
