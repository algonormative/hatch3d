import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBox, parseHeight, signDirectory, signSvg } from '../../cli/sign.ts';
import { BREACH_SVG, sha256, writeBreachEntry } from './helpers/sign-fixture.ts';

const run = { handle: '@algonormative', dry: false };
const entry = (options: { config?: boolean } = {}) => { const dir = mkdtempSync(join(tmpdir(), 'sign-')); writeBreachEntry(dir, options); return dir; };
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const hashes = (dir: string) => Object.fromEntries(['plot-ready.svg', 'index.md', 'config.json', 'finalize-report.json'].map((f) => [f, sha256(readFileSync(join(dir, f)))]));
/** The signature's ink: its path's points, and the layer it sits in. */
const signature = (svg: string) => {
  const d = /<g id="signature"[^>]*><path d="([^"]+)"/.exec(svg)![1];
  const points = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const layer = svg.slice(0, svg.indexOf('<g id="signature"')).match(/<g inkscape:groupmode="layer"[^>]*>/g)!.pop()!;
  return { x0: Math.min(...points.map((p) => p[0])), x1: Math.max(...points.map((p) => p[0])), y0: Math.min(...points.map((p) => p[1])), y1: Math.max(...points.map((p) => p[1])), layer };
};
const layers = (svg: string) => svg.match(/inkscape:groupmode="layer"/g)!.length;

describe('sign: a Breach-style entry', () => {
  // Recorded from the signer before pens and boxes existed (cli/sign.ts at 5cb413e) on the same fixture.
  const GOLDEN = {
    'plot-ready.svg': 'd3fb1ccca5776736c4cad2e4ae6cb9119e21e23793b41dcd47ac2c1b0ba5d0c0',
    'index.md': 'db15cb4520c7f611d4378423d3f61edf554b6815950b14f68e900e5c4211aa5e',
    'config.json': '72fdd1c25a4980ae62ad3726732d55d56e522a4c0e1506e050636766bfd59105',
    'finalize-report.json': 'ddc1cfd29fd1f3dc972bd23bd9fcf7df0d0286ea33231b10fa699945f087ab0b',
  };

  it('signs byte for byte as it always has, and re-signing is byte-identical', () => {
    const dir = entry();
    expect(signDirectory(dir, run)).toMatch(/^signed .*"@algonormative {2}v1 {2}abc1234 {2}2026-10-07" {2}70x120 mm, 0.70 mm text at 41.3,117.4 mm {2}\(3 hash records\)$/);
    expect(hashes(dir)).toEqual(GOLDEN);
    signDirectory(dir, run);
    expect(hashes(dir)).toEqual(GOLDEN);
    expect(signature(read(dir, 'plot-ready.svg')).layer).toContain('inkscape:label="6-lettering"');
  });
});

describe('sign --pen and --box', () => {
  const box = { x0: 40, y0: 100, x1: 66, y1: 110 };

  it('signs into the existing layer with that pen, which keeps its ink, instead of the lettering layer', () => {
    const { svg } = signSvg(BREACH_SVG, '@algonormative  v1', { pen: 'carbon' });
    const { layer } = signature(svg);
    expect(layer).toContain('data-pen-id="carbon"');
    expect(layer).toContain('stroke="#22282c" stroke-width="0.25"');
    expect(layers(svg)).toBe(layers(BREACH_SVG));
    expect(svg).not.toMatch(/6-lettering[^>]*>\n<g id="signature"/);
    expect(() => signSvg(BREACH_SVG, 'x', { pen: 'vermilion' })).toThrow('no layer with data-pen-id="vermilion" to sign into');
    // Re-signing replaces the signature, wherever it was.
    const again = signSvg(svg, '@algonormative  v2', { pen: 'carbon' }).svg;
    expect(again.match(/<g id="signature"/g)).toHaveLength(1);
  });

  it('right-aligns the signature, ink and descenders, at the bottom of the box, and says when it does not fit', () => {
    const { svg } = signSvg(BREACH_SVG, '@algonormative  v1', { pen: 'carbon', box });
    const ink = signature(svg);
    expect(ink.x1).toBeCloseTo(box.x1, 2);
    expect(ink.y1).toBeCloseTo(box.y1, 2);
    expect(ink.x0).toBeGreaterThanOrEqual(box.x0);
    expect(ink.y0).toBeGreaterThanOrEqual(box.y0);
    expect(() => signSvg(BREACH_SVG, '@algonormative  v1', { box: { x0: 60, y0: 100, x1: 66, y1: 110 } })).toThrow(/does not fit the 6 x 10 mm box/);
    expect(() => signSvg(BREACH_SVG, '@algonormative  v1', { box: { x0: 40, y0: 100, x1: 66, y1: 100.5 } })).toThrow(/does not fit/);
  });

  it('reads a box as x0,y0,x1,y1 millimetres', () => {
    expect(parseBox('40,100,66,110')).toEqual(box);
    for (const bad of ['40,100,66', '40,100,30,110', '40,100,66,90', 'a,b,c,d']) expect(() => parseBox(bad)).toThrow(/--box must be x0,y0,x1,y1/);
  });
});

describe('sign in a print-queue directory', () => {
  const withFrontmatter = (dir: string, lines: string) => writeFileSync(join(dir, 'index.md'), read(dir, 'index.md').replace('\n---\n\n#', `\n${lines}\n---\n\n#`));

  it('takes the pen and the box from index.md, and a flag wins over it', () => {
    const dir = entry();
    withFrontmatter(dir, 'sign_pen: carbon\nsign_box: 40,100,66,110');
    signDirectory(dir, run);
    let ink = signature(read(dir, 'plot-ready.svg'));
    expect(ink.layer).toContain('data-pen-id="carbon"');
    expect(ink.x1).toBeCloseTo(66, 2);
    signDirectory(dir, { ...run, box: { x0: 10, y0: 20, x1: 50, y1: 30 } });
    ink = signature(read(dir, 'plot-ready.svg'));
    expect(ink.x1).toBeCloseTo(50, 2);
    expect(ink.y1).toBeCloseTo(30, 2);
    expect(read(dir, 'plot-ready.svg').match(/<g id="signature"/g)).toHaveLength(1);
  });

  it('skips an entry marked sign: false, and says so', () => {
    const dir = entry();
    withFrontmatter(dir, 'sign: false');
    const before = hashes(dir);
    expect(signDirectory(dir, run)).toBe(`skipped ${dir}: sign: false in index.md (this ply is not signed)`);
    expect(hashes(dir)).toEqual(before);
  });

  it('never appends a layer to an entry that has a config.json, since plotter-server rejects a changed layer count', () => {
    const unlettered = BREACH_SVG.replace(/<g inkscape:groupmode="layer" inkscape:label="6-lettering"[\s\S]*?<\/g>\n/, '');
    expect(layers(unlettered)).toBe(2);
    const configured = entry();
    writeFileSync(join(configured, 'plot-ready.svg'), unlettered);
    expect(() => signDirectory(configured, run)).toThrow(/a new layer would change the layer count that plotter-server checks: sign into an existing layer with --pen/);
    expect(read(configured, 'plot-ready.svg')).toBe(unlettered);
    // Without a config there is no layer count to protect: the layer is added, as before.
    const bare = entry({ config: false });
    writeFileSync(join(bare, 'plot-ready.svg'), unlettered);
    signDirectory(bare, run);
    expect(layers(read(bare, 'plot-ready.svg'))).toBe(3);
    // And with a pen it signs the configured entry's existing layer.
    withFrontmatter(configured, 'sign_pen: carbon');
    signDirectory(configured, run);
    expect(layers(read(configured, 'plot-ready.svg'))).toBe(2);
  });

  it('takes a cap height for a wide pen, by flag or from the entry, and refuses a bad one', () => {
    const height = (dir: string) => { const ink = signature(read(dir, 'plot-ready.svg')); return ink.y1 - ink.y0; };
    const dir = entry();
    signDirectory(dir, { ...run, heightMm: 1 });
    const small = height(dir);
    withFrontmatter(dir, 'sign_height: 1.5');
    signDirectory(dir, run);
    expect(height(dir)).toBeCloseTo(small * 1.5, 1);
    // The flag wins over the entry.
    signDirectory(dir, { ...run, heightMm: 1 });
    expect(height(dir)).toBeCloseTo(small, 5);
    expect(() => parseHeight('none')).toThrow(/cap height/);
  });
});
