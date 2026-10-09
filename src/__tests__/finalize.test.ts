import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVersion, finalizePiece, pageFor, parseStat, plainFinishing, previewPiece, titleOverrides, placementOffset, readLayers, resolveOptions, toSketchGrammar, type Stack } from '../../cli/finalize.ts';
import { plainRender } from '../../cli/print-queue.ts';
import { artMatch } from '../../cli/art-match.ts';

const page = { width: 279.4, height: 431.8, margin: 18 };
const border = { style: 'double', pen: 'carbon', inset: 12, contentGap: 6 };
const svg = (layers: [string, string, string][]) => `<svg>${layers.map(([label, stroke, d]) =>
  `<g inkscape:groupmode="layer" inkscape:label="${label}" data-pen-id="${label.replace(/^\d+-/, '')}" data-passes="1" stroke="${stroke}"><path d="${d}"/></g>`).join('')}</svg>`;

describe('finalize page', () => {
  it('reads the page from one place: the sketch’s own unless the stack sets one', () => {
    const tabloid = { ...page, paper: '#f4f0e6' };
    expect(pageFor({}, { page: tabloid, pageAware: true })).toBe(tabloid);
    expect(pageFor({ page: { width: 70, height: 120 } }, { page: tabloid, pageAware: true })).toEqual({ width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' });
    expect(pageFor({ page: { width: 70, height: 120, margin: 3 } }, { page: tabloid, pageAware: true })).toEqual({ width: 70, height: 120, margin: 3, paper: '#f4f0e6' });
    // A sketch that is not page-aware is fitted onto the stack's page and keeps its own margin, as finishing does.
    expect(pageFor({ page: { width: 70, height: 120 } }, { page: tabloid })).toEqual({ width: 70, height: 120, margin: 18, paper: '#f4f0e6' });
    const area = placementOffset([], { width: 70, height: 120, margin: 4.51 }, { out: '', pieces: [] } as Stack, 'vertical').area;
    expect(area).toEqual({ x0: 4.51, y0: 4.51, x1: 70 - 4.51, y1: 120 - 4.51 });
  });

  it('renders the art match’s plain render on the stack’s page only for a page-aware sketch', () => {
    const tabloid = { ...page, paper: '#f4f0e6' };
    expect(plainFinishing({}, { page: tabloid, pageAware: true })).toBeUndefined();
    expect(plainFinishing({ page: { width: 70, height: 120 } }, { page: tabloid })).toBeUndefined();
    expect(plainFinishing({ page: { width: 70, height: 120 } }, { page: tabloid, pageAware: true })).toEqual({ page: { width: 70, height: 120, margin: 4.51 } });
  });
});

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
    // A double border's own gap between its lines moves the content area as finishing's does.
    const card = { width: 70, height: 120, margin: 4.5 };
    const area = placementOffset([], card, { out: '', pieces: [], border: { style: 'double', pen: 'carbon', inset: 3, lineGap: 0.75, contentGap: 0.5 } } as Stack, 'none').area;
    expect(area.x0).toBeCloseTo(3 + 0.75 + 0.5 + 0.25, 9);
  });

  it('re-emits vpype output in the sketch grammar with the source layer tags, in millimetres', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="279.4mm" height="431.8mm" viewBox="0 0 279.4 431.8">'
      + '<g inkscape:groupmode="layer" inkscape:label="1-carbon" data-pen-id="carbon" data-passes="1" fill="none" stroke="#22282c" stroke-width="0.25"><g data-part-id="a"><path d="M0,0L1,1"/></g></g>'
      + '<g inkscape:groupmode="layer" inkscape:label="2-ultramarine" data-pen-id="ultramarine" data-passes="2" fill="none" stroke="#3c49aa" stroke-width="0.25"></g></svg>';
    const vpype = '<?xml version="1.0"?><svg viewBox="0 0 1056 1632"><metadata/><defs/>'
      + '<g fill="none" inkscape:groupmode="layer" stroke="#111" style="display:inline" id="layer1" inkscape:label="1"><polyline points="0,0 96,96"/><line x1="0" y1="0" x2="96" y2="0"/></g>'
      + '<g fill="none" inkscape:groupmode="layer" stroke="#222" style="display:inline" id="layer2" inkscape:label="2"><polygon points="0,0 96,0 96,96"/></g></svg>';
    const out = toSketchGrammar(vpype, source, new Map([[1, { label: '1-carbon', passes: 1 }], [2, { label: '2-ultramarine', passes: 2 }]]));
    expect(out).not.toMatch(/metadata|polyline|polygon|<line|style=|px/);
    expect(out).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="279.4mm" height="431.8mm" viewBox="0 0 279.4 431.8">');
    expect(out).toContain('inkscape:label="1-carbon" data-pen-id="carbon" data-passes="1" fill="none" stroke="#22282c"');
    expect(out).toContain('<path d="M0,0L25.4,25.4"/>');
    expect(out).toContain('<path d="M0,0L25.4,0"/>');
    expect(out).toContain('<path d="M0,0L25.4,0L25.4,25.4L0,0"/>');
    expect(out).toContain('inkscape:label="2-ultramarine" data-pen-id="ultramarine" data-passes="2"');
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

  it('rejects overrides that name no control, so a misspelled slogan setting cannot silently do nothing', async () => {
    const stack: Stack = { out: mkdtempSync(join(tmpdir(), 'finalize-')), border, pieces: [] };
    const piece = { name: 't', sketch: 'sketches/breach-cathedral-tower/sketch.ts', seed: 211 };
    await expect(previewPiece(stack, piece, resolveOptions(stack).palette, { sloganSzie: 2 }, stack.out)).rejects.toThrow(/no control named sloganSzie/);
    const svg = await previewPiece(stack, piece, resolveOptions(stack).palette, { sloganCount: 1 }, stack.out);
    // Lettering plots on its own fine layer, inked like the structure, and nowhere else.
    const lettering = readLayers(svg).find(l => l.label.endsWith('-lettering'))!;
    expect(lettering.attrs['stroke-width']).toBe('0.13');
    expect(lettering.color).toBe(resolveOptions(stack).palette.inks[0]);
    const layers = svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1);
    expect(layers.filter(l => /data-part-id="[^"]*slogan/.test(l)).map(l => /inkscape:label="([^"]*)"/.exec(l)![1])).toEqual([lettering.label]);
  }, 30_000);

  it('rejects a piece whose own params name no control, naming the piece and the key', async () => {
    const stack: Stack = { out: mkdtempSync(join(tmpdir(), 'finalize-')), border, pieces: [] };
    const piece = { name: 'misspelt-piece', sketch: 'sketches/breach-cathedral-tower/sketch.ts', seed: 211, params: { sloganSzie: 2 } };
    await expect(previewPiece(stack, piece, resolveOptions(stack).palette, {}, stack.out)).rejects.toThrow(/misspelt-piece has no control named sloganSzie/);
  }, 30_000);
});

describe('finalize print title', () => {
  const controls = [{ id: 'title' }, { id: 'titleEnabled' }] as never;
  const stack = { out: '', pieces: [], printTitle: 'Breach Cathedral {version} {hash}' } as Stack;

  it('stamps version and short hash, marking uncommitted builds with +', () => {
    expect(titleOverrides(stack, controls, { version: 'v3', hash: 'abc1234', dirty: false })).toEqual({ titleEnabled: true, title: 'Breach Cathedral v3 abc1234' });
    expect(titleOverrides(stack, controls, { version: 'v3', hash: 'abc1234', dirty: true }).title).toBe('Breach Cathedral v3 abc1234+');
  });

  it('adds nothing when the sketch has no title controls or the stack has no title', () => {
    expect(titleOverrides(stack, [{ id: 'title' }] as never, { version: 'v1', hash: 'x', dirty: false })).toEqual({});
    expect(titleOverrides({ ...stack, printTitle: undefined }, controls, { version: 'v1', hash: 'x', dirty: false })).toEqual({});
  });

  it('reads the repository: a v* tag on HEAD or the edition, plus a 7+ character hash', () => {
    const b = buildVersion(4);
    expect(b.version).toMatch(/^v/);
    expect(b.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(typeof b.dirty).toBe('boolean');
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
    const prepared = readLayers(readFileSync(join(process.cwd(), report.files.prepared), 'utf8'));
    expect(prepared.length).toBeGreaterThan(0);
    for (const layer of prepared) {
      for (const name of layer.label.replace(/^\d+-/, '').split('+')) {
        const original = source.find(l => l.label.replace(/^\d+-/, '') === name)!;
        expect(original.color.toLowerCase(), `${name} lands on its own ink`).toBe(layer.color.toLowerCase());
      }
    }
    // Ink length survives preparation (linemerge connectors add a little; nothing is dropped).
    const sourceInk = parseStat(spawnSync('vpype', ['read', join(process.cwd(), report.files.source), 'stat'], { encoding: 'utf8' }).stdout).reduce((t, l) => t + l.drawMm, 0);
    const preparedInk = report.layers.reduce((t, l) => t + l.drawMm, 0);
    expect(preparedInk / sourceInk).toBeGreaterThan(0.995);
    expect(preparedInk / sourceInk).toBeLessThan(1.02);
  }, 60_000);

  it('prints a page-aware card on the stack’s page, and its art matches the plain render on that page', async () => {
    const piece = { name: 'star', sketch: 'sketches/breach-tarot/xvii-star/sketch.ts', seed: 2 };
    const stack: Stack = { out: mkdtempSync(join(tmpdir(), 'finalize-')), page: { width: 70, height: 120 },
      border: { style: 'simple', pen: 'carbon', inset: 2.5, contentGap: 1 }, defaults: { center: 'none', mergeSameColor: false }, pieces: [piece] };
    const report = await finalizePiece(stack, piece, resolveOptions(stack));
    const config = JSON.parse(readFileSync(join(stack.out, 'star', 'config.json'), 'utf8')) as { page: unknown };
    expect(config.page).toEqual({ width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' });
    expect(readFileSync(join(process.cwd(), report.files.prepared), 'utf8')).toMatch(/^<svg[^>]*width="70mm" height="120mm" viewBox="0 0 70 120"/);
    const print = readFileSync(join(process.cwd(), report.files.source), 'utf8');
    const onPage = artMatch((await plainRender(stack, piece)).svg, print);
    expect(onPage.ok, `${onPage.matched}/${onPage.total}`).toBe(true);
    // Without the stack's page the plain render is the tabloid card, which the print cannot match.
    const { page: _page, ...tabloidStack } = stack;
    expect(artMatch((await plainRender(tabloidStack, piece)).svg, print).ok).toBe(false);
  }, 60_000);
});
