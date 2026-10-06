import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizePiece, parseStat, placementOffset, readLayers, resolveOptions, restoreLayerMetadata, type Stack } from '../../cli/finalize.ts';

const page = { width: 279.4, height: 431.8, margin: 18 };
const border = { style: 'double', pen: 'carbon', inset: 12, contentGap: 6 };
const svg = (layers: [string, string, string][]) => `<svg>${layers.map(([label, stroke, d]) =>
  `<g inkscape:groupmode="layer" inkscape:label="${label}" data-pen-id="${label.replace(/^\d+-/, '')}" data-passes="1" stroke="${stroke}"><path d="${d}"/></g>`).join('')}</svg>`;

describe('finalize placement and pen plan', () => {
  it('centers art inside the border content area and ignores the border itself', () => {
    const layers = readLayers(svg([
      ['1-carbon', '#22282c', 'M100,30L120,300'],
      ['2-finishing-border', '#22282c', 'M12,12L267.4,419.8'],
    ]));
    const { dy, dx } = placementOffset(layers, page, { out: '', pieces: [], border } as Stack, 'vertical');
    // Content area is 20.25..411.55 (inset + double + gap + half stroke); art 30..300 → centered.
    expect(dx).toBe(0);
    expect(dy).toBeCloseTo((20.25 + 411.55) / 2 - (30 + 300) / 2, 3);
    expect(placementOffset(layers, page, { out: '', pieces: [], border } as Stack, 'none').dy).toBe(0);
  });

  it('restores label, pen id and passes onto the matching vpype layer only', () => {
    const prepared = '<g fill="none" inkscape:groupmode="layer" stroke="#111" id="layer1" inkscape:label="1"><g fill="none" inkscape:groupmode="layer" stroke="#222" id="layer2" inkscape:label="2">';
    const out = restoreLayerMetadata(prepared, new Map([[1, { label: '1-carbon', penId: 'carbon', passes: 1 }], [2, { label: '2-ultramarine', penId: 'ultramarine', passes: 2 }]]));
    expect(out).toContain('stroke="#111" id="layer1" inkscape:label="1-carbon" data-pen-id="carbon" data-passes="1"');
    expect(out).toContain('stroke="#222" id="layer2" inkscape:label="2-ultramarine" data-pen-id="ultramarine" data-passes="2"');
  });

  it('reads vpype stat in px and reports millimetres per layer', () => {
    const stats = parseStat('========= Stats =========\nLayer 1\n  Length: 96.0\n  Pen-up length: 192.0\n  Path count: 3\nLayer 2\n  Length: 9.6\n  Pen-up length: 0\n  Path count: 1\n');
    expect(stats).toEqual([{ layer: 1, paths: 3, drawMm: 25.4, travelMm: 50.8 }, { layer: 2, paths: 1, drawMm: 2.54, travelMm: 0 }]);
  });

  it('refuses a palette with fewer inks than the sketch has pens', async () => {
    const stack: Stack = { out: mkdtempSync(join(tmpdir(), 'finalize-')), border, pieces: [] };
    const short = resolveOptions(stack, { palette: { id: 'short', label: 'Short', paper: '#ffffff', inks: ['#000000', '#111111'] } });
    await expect(finalizePiece(stack, { name: 't', sketch: 'sketches/breach-cathedral-tower/sketch.ts', seed: 211 }, short)).rejects.toThrow(/2 inks for 5 pens/);
  });
});

const hasVpype = spawnSync('vpype', ['--version']).status === 0;

describe.skipIf(!hasVpype)('finalize end to end (local vpype)', () => {
  it('moves only the art, keeps every ink on a layer of its color, and merges same-color pens', async () => {
    const stack: Stack = { out: mkdtempSync(join(tmpdir(), 'finalize-')), border, pieces: [] };
    const options = resolveOptions(stack, { palette: 'two-tone' });
    const report = await finalizePiece(stack, { name: 'tower', sketch: 'sketches/breach-cathedral-tower/sketch.ts', seed: 211, params: { posterMode: 'abstract' } }, options);
    expect(report.pens).toBe(2);
    expect(report.margins!.top).toBeCloseTo(report.margins!.bottom, 2);
    const source = readLayers(readFileSync(join(process.cwd(), report.files.source), 'utf8'));
    const prepared = readFileSync(join(process.cwd(), report.files.prepared), 'utf8');
    for (const g of prepared.matchAll(/<g\b[^>]*stroke="([^"]+)"[^>]*inkscape:label="([^"]+)"/g)) {
      for (const name of g[2].replace(/^\d+-/, '').split('+')) {
        const original = source.find(l => l.label.replace(/^\d+-/, '') === name)!;
        expect(original.color.toLowerCase(), `${name} lands on its own ink`).toBe(g[1].toLowerCase());
      }
    }
    // Ink length survives preparation (linemerge connectors add a little; nothing is dropped).
    const sourceInk = parseStat(spawnSync('vpype', ['read', join(process.cwd(), report.files.source), 'stat'], { encoding: 'utf8' }).stdout).reduce((t, l) => t + l.drawMm, 0);
    const preparedInk = report.layers.reduce((t, l) => t + l.drawMm, 0);
    expect(preparedInk / sourceInk).toBeGreaterThan(0.995);
    expect(preparedInk / sourceInk).toBeLessThan(1.02);
  }, 60_000);
});
