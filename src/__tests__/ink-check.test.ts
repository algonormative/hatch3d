import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrepared, countShort, inkCheck, isFused, isTight, outlinePoints, pageOf, paperIdOfColor, parseLayers, pieceContext, resample, scanSpacing, warningsOf } from '../../cli/ink-check.ts';
import { limitsOn } from '../sketch/materials.ts';

interface L { label: string; pen: string; paths: string[] }
const svg = (layers: L[], w = 200, h = 200): string => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n`
  + layers.map((l) => `<g inkscape:groupmode="layer" inkscape:label="${l.label}" data-pen-id="${l.pen}" data-passes="1" fill="none" stroke="#c9a54a" stroke-width="0.5">\n${l.paths.map((d) => `<path d="${d}"/>`).join('\n')}\n</g>`).join('\n')
  + '\n</svg>\n';
const line = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0}L${x1},${y1}`;
/** `n` horizontal lines `len` mm long at `pitch` from (x, y), each its own stroke. */
const hatch = (x: number, y: number, pitch: number, n = 8, len = 10): string[] => Array.from({ length: n }, (_, i) => line(x, +(y + i * pitch).toFixed(4), x + len, +(y + i * pitch).toFixed(4)));
const circle = (cx: number, cy: number, r: number, n = 24): string => `M${Array.from({ length: n + 1 }, (_, i) => `${(cx + r * Math.cos((2 * Math.PI * i) / n)).toFixed(3)},${(cy + r * Math.sin((2 * Math.PI * i) / n)).toFixed(3)}`).join('L')}`;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ink-check-')); dirs.push(d); return d; };

describe('ink-check: parallel spacing', () => {
  const PITCHES = [0.4, 0.5, 0.55, 0.66, 0.8, 1.0];
  const patches = svg([{ label: '1-gold', pen: 'gold', paths: PITCHES.flatMap((p, k) => hatch(5 + k * 20, 20, p)) }]);
  const limits = limitsOn('gold', 'black');

  it('positive control: gold on black flags exactly the patches under 0.78 mm as tight, and those at 0.55 mm or less as fused', () => {
    expect(limits).toMatchObject({ cleanPitch: 0.8, fusePitch: 0.55, measured: true });
    const [layer] = parseLayers(patches);
    expect(layer.strokes).toHaveLength(PITCHES.length * 8);
    const scan = scanSpacing(layer.strokes, limits.cleanPitch);
    const share = (patch: number, test: (c: number) => boolean) => {
      let n = 0, hit = 0;
      for (let i = 0; i < scan.samples.n; i++) if (Math.floor(scan.samples.stroke[i] / 8) === patch) { n++; if (test(scan.close[i])) hit++; }
      return hit / n;
    };
    PITCHES.forEach((pitch, k) => {
      expect(share(k, (c) => isTight(c, limits)), `tight at ${pitch}`).toBe(pitch < 0.78 ? 1 : 0);
      expect(share(k, (c) => isFused(c, limits)), `fused at ${pitch}`).toBe(pitch <= 0.55 ? 1 : 0);
    });
    // The pitch where the lines are clean, and the widest one, are never flagged.
    expect(share(4, (c) => isTight(c, limits))).toBe(0);
    expect(share(5, (c) => isTight(c, limits))).toBe(0);
  });

  it('reports the same in lengths: four tight patches and three fused ones, and where the fused line is', () => {
    const { report } = inkCheck(patches, { paper: 'black' });
    expect(report.layers).toHaveLength(1);
    const c = report.layers[0];
    expect(c).toMatchObject({ label: '1-gold', pen: 'gold', measured: true, lengthMm: 480, tightMm: 320, fusedMm: 240, tightPct: 66.7 });
    expect(c.topCells.length).toBeGreaterThan(0);
    expect(c.topCells[0].mm).toBeLessThanOrEqual(240);
    expect(report.cut).toBeNull();
  });

  it('does not flag lines that cross: 90, 60 and 45 degrees leave nothing tight', () => {
    const cross = (angle: number) => {
      const a = (angle * Math.PI) / 180;
      return [line(10, 50, 30, 50), line(20 - 10 * Math.cos(a), 50 - 10 * Math.sin(a), 20 + 10 * Math.cos(a), 50 + 10 * Math.sin(a))];
    };
    for (const angle of [90, 60, 45]) {
      const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: cross(angle) }]));
      const scan = scanSpacing(layer.strokes, 0.8);
      expect(scan.close.filter((c) => c < 0.78), `${angle} degrees`).toHaveLength(0);
    }
  });

  it('mutation probe: a parallel tolerance loose enough to accept 60 degree crossings (or any, at 0) makes the crossing test fail', () => {
    const at = (angle: number) => {
      const a = (angle * Math.PI) / 180;
      const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: [line(10, 50, 30, 50), line(20 - 10 * Math.cos(a), 50 - 10 * Math.sin(a), 20 + 10 * Math.cos(a), 50 + 10 * Math.sin(a))] }]));
      return layer.strokes;
    };
    const flagged = (angle: number, minCos?: number) => scanSpacing(at(angle), 0.8, { minCos }).close.filter((c) => c < 0.78).length;
    expect(flagged(60)).toBe(0);
    expect(flagged(60, 0.4)).toBeGreaterThan(0); // cos 60 = 0.5, accepted by 0.4
    expect(flagged(90)).toBe(0);
    expect(flagged(90, 0)).toBeGreaterThan(0);
  });

  it('flags a serpentine hatch, one stroke, at 0.5 mm: the same-stroke rule looks along the stroke, not just at other strokes', () => {
    const d = `M${Array.from({ length: 12 }, (_, i) => (i % 2 ? `10,${i * 0.5}L0,${i * 0.5}` : `0,${i * 0.5}L10,${i * 0.5}`)).join('L')}`;
    const one = svg([{ label: '1-gold', pen: 'gold', paths: [d] }]);
    const { report } = inkCheck(one, { paper: 'black' });
    expect(parseLayers(one)[0].strokes).toHaveLength(1);
    expect(report.layers[0].tightPct).toBeGreaterThan(80);
    expect(report.layers[0].fusedMm).toBeGreaterThan(50);
  });

  it('leaves a hairpin’s own turn alone: samples within three pitches along the stroke are not neighbours', () => {
    const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: ['M0,0L10,0L10,0.5L0,0.5'] }]));
    const scan = scanSpacing(layer.strokes, 0.8);
    const flaggedX = [...scan.samples.x].filter((_, i) => scan.close[i] < 0.78);
    expect(flaggedX.length).toBeGreaterThan(50);
    expect(Math.max(...flaggedX)).toBeLessThan(9.3); // past x = 9.05 the other leg is under 2.4 mm away along the stroke
    expect(Math.min(...flaggedX)).toBeLessThan(0.5);
  });

  it('does not mind how the two strokes’ samples fall: the spacing is measured across the line', () => {
    // A line at 0.55 mm from another, whose samples sit 0.1 mm out of step with it, is 0.55 apart, not 0.559.
    const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: [line(0, 0, 10, 0), line(10.1, 0.55, 0.1, 0.55)] }]));
    const scan = scanSpacing(layer.strokes, 0.8);
    expect(Math.min(...scan.close)).toBeCloseTo(0.55, 9);
    expect(Math.max(...scan.close.filter(Number.isFinite))).toBeCloseTo(0.55, 9);
  });

  it('applies the limits of the pen on the paper, and says when it is guessing', () => {
    const hatchOn = svg([{ label: '1-carbon', pen: 'carbon', paths: hatch(10, 10, 0.5) }]);
    const white = inkCheck(hatchOn, { paper: 'white' }).report.layers[0];
    expect(white).toMatchObject({ measured: true, cleanPitch: 0.5, fusePitch: 0.4, tightMm: 0 }); // 0.5 is clean for the Micron 01 on white
    const black = inkCheck(hatchOn, { paper: 'black' }).report.layers[0];
    expect(black).toMatchObject({ measured: false, cleanPitch: 0.8, fusePitch: 0.55 }); // never plotted there: the defaults
    expect(black.tightPct).toBeGreaterThan(80);
    expect(inkCheck(hatchOn, {}).report.layers[0].measured).toBe(false);
  });

  it('skips the cut pen and the border', () => {
    const both = svg([
      { label: '1-gold', pen: 'gold', paths: hatch(10, 10, 0.5) },
      { label: '2-cut', pen: 'cut', paths: hatch(10, 50, 0.5) },
      { label: '3-finishing-border', pen: 'finishing-border', paths: hatch(10, 80, 0.5) },
    ]);
    expect(inkCheck(both, { paper: 'black' }).report.layers.map((l) => l.pen)).toEqual(['gold']);
  });

  it('resamples every 0.2 mm from the start of a stroke and ignores strokes under one step', () => {
    const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: [line(0, 0, 1, 0), line(0, 5, 0.1, 5), 'M0,10L0.5,10L0.5,10.5'] }]));
    const samples = resample(layer.strokes);
    expect(samples.n).toBe(5 + 5);
    expect([...samples.x].slice(0, 5).map((x) => +x.toFixed(6))).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(samples.dx[0]).toBe(1);
    expect(samples.stroke[5]).toBe(2);
  });
});

describe('ink-check: dashes and loops', () => {
  it('counts open strokes under the pen’s shortest dash and closed loops under its smallest circle, leaving dots alone', () => {
    const fixture = svg([{
      label: '1-gold', pen: 'gold',
      paths: [
        line(10, 10, 10.3, 10), // a dot (0.3 mm): deliberate
        line(20, 10, 20.6, 10), line(30, 10, 30.9, 10), // too short for gold (1.0 mm)
        line(40, 10, 41.2, 10), // long enough
        circle(10, 30, 0.5), // too small (r 1.0)
        circle(30, 30, 1.5), // fine
        circle(50, 30, 0.04, 8), // a speck of a loop (under 0.35 mm round): a dot
      ],
    }]);
    const [layer] = parseLayers(fixture);
    expect(countShort(layer.strokes, 1.0, 1.0)).toEqual({ shortDashes: 2, smallLoops: 1 });
    expect(inkCheck(fixture, { paper: 'black' }).report.layers[0]).toMatchObject({ shortDashes: 2, smallLoops: 1, minDash: 1, minRadius: 1 });
  });
});

describe('ink-check: cut clearance', () => {
  const frame = 'M20,20L60,20L60,60L20,60L20,20';
  const cut: L = { label: '2-cut', pen: 'cut', paths: [frame, line(30, 30, 32, 32), line(32, 30, 30, 32), 'M40,40L41,40L41,41'] };

  it('measures ink to the cut layer’s long strokes only: the outline, not the X marks and the labels', () => {
    const art: L = { label: '1-gold', pen: 'gold', paths: [line(25, 20.5, 45, 20.5), line(25, 25, 45, 25), line(30.2, 29, 31.8, 29), line(40.1, 39.5, 40.9, 39.5)] };
    const { report } = inkCheck(svg([art, cut]), { paper: 'black' });
    expect(report.cut).toMatchObject({ label: '2-cut', outlineStrokes: 1 });
    // The first line runs 0.5 mm from the outline for its 20 mm; the second is 5 mm in; the others sit on X marks and a label glyph.
    expect(report.layers[0].nearCutMm).toBeCloseTo(20, 0);
    expect(report.layers[0].nearCutMm).toBeLessThan(21);
    expect(warningsOf(report).join(' ')).toMatch(/within 1 mm of the cut outlines/);
  });

  it('takes the threshold as given, and reports nothing without a cut layer', () => {
    const art: L = { label: '1-gold', pen: 'gold', paths: [line(25, 21.5, 45, 21.5)] };
    expect(inkCheck(svg([art, cut]), { paper: 'black' }).report.layers[0].nearCutMm).toBe(0);
    expect(inkCheck(svg([art, cut]), { paper: 'black', cutClearance: 2 }).report.layers[0].nearCutMm).toBeGreaterThan(19);
    expect(inkCheck(svg([art]), { paper: 'black' }).report.layers[0].nearCutMm).toBeUndefined();
  });

  it('counts a closed outline of curved short segments, and a segment of 5 mm or more, as outline', () => {
    const round = circle(100, 100, 10, 60); // 60 segments of about 1 mm: only the closed stroke makes it an outline
    expect(outlinePoints(parseLayers(svg([{ label: '2-cut', pen: 'cut', paths: [round] }]))[0].strokes).strokes).toBe(1);
    expect(outlinePoints(parseLayers(svg([{ label: '2-cut', pen: 'cut', paths: [line(0, 0, 6, 0), line(0, 5, 4, 5)] }]))[0].strokes).strokes).toBe(1);
  });
});

describe('ink-check: files and paper', () => {
  it('reads strokes: absolute M and L, several subpaths, Z; and refuses what it cannot read', () => {
    const [layer] = parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: ['M0,0L1,0M2,2L3,2L3,3Z', 'M5,5L6,5'] }]));
    expect(layer.strokes.map((s) => [...s])).toEqual([[0, 0, 1, 0], [2, 2, 3, 2, 3, 3, 2, 2], [5, 5, 6, 5]]);
    expect(() => parseLayers(svg([{ label: '1-gold', pen: 'gold', paths: ['M0,0C1,1 2,2 3,3'] }]))).toThrow(/unsupported path command C/);
    expect(pageOf(svg([], 279.4, 431.8))).toEqual({ width: 279.4, height: 431.8 });
  });

  it('finds the paper from the report (an assembly ply names it), then the palette, then the colour', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ palette: 'ply-black', paper: '#141416', assembly: { paper: { id: 'black', color: '#141416' }, cutPen: 'cut' } }));
    expect(pieceContext(dir)).toEqual({ paper: 'black', paperColor: '#141416', cutPen: 'cut' });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ palette: 'ply-white', paper: '#f7f6f2' }));
    expect(pieceContext(dir)).toMatchObject({ paper: 'white', paperColor: '#f7f6f2' });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ palette: 'phase-garden', paper: '#f4f0e6' }));
    expect(pieceContext(dir).paper).toBeUndefined();
    rmSync(join(dir, 'report.json'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ page: { paper: '#E0B13A' } }));
    expect(pieceContext(dir)).toMatchObject({ paper: 'gold-yellow' });
    expect(paperIdOfColor('#141416')).toBe('black');
    expect(paperIdOfColor('#123456')).toBeUndefined();
  });

  it('writes the overlay and the numbers for a piece on a catalog paper, and nothing for any other', () => {
    const dir = tmp();
    const hatched = svg([{ label: '1-gold', pen: 'gold', paths: hatch(10, 10, 0.5) }]);
    const summary = checkPrepared(hatched, dir, { paper: 'black', paperColor: '#141416' });
    expect(summary && 'layers' in summary && summary.layers[0].tightPct).toBeGreaterThan(80);
    expect([...readFileSync(join(dir, 'ink-check.png')).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(JSON.parse(readFileSync(join(dir, 'ink-check.json'), 'utf8')).layers[0].pen).toBe('gold');
    const other = tmp();
    expect(checkPrepared(hatched, other, { paperColor: '#f4f0e6' })).toBeUndefined();
    expect(existsSync(join(other, 'ink-check.png'))).toBe(false);
  });

  it('never throws from a finalize: an unreadable SVG becomes an error entry', () => {
    const dir = tmp();
    const bad = checkPrepared(svg([{ label: '1-gold', pen: 'gold', paths: ['M0,0C1,1 2,2 3,3'] }]), dir, { paper: 'black' });
    expect(bad).toEqual({ error: expect.stringMatching(/ink-check skipped: .*unsupported path command C/) });
  });

  it('warns in plain words, only for a layer with something to see', () => {
    const fixture = svg([
      { label: '1-gold', pen: 'gold', paths: hatch(10, 10, 0.5) },
      { label: '2-silver', pen: 'silver', paths: hatch(10, 50, 1.2) },
    ]);
    const { report } = inkCheck(fixture, { paper: 'black' });
    expect(warningsOf(report)).toHaveLength(1);
    expect(warningsOf(report)[0]).toMatch(/^1-gold: 100% of its 80 mm runs closer than 0\.8 mm to a parallel line, 80 mm of it at 0\.55 mm or closer, where the pen fuses lines$/);
  });
});
