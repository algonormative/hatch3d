import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { congruentFit, fitMatrix, fitRigid, parseFrom, plyCuts, readPlyResult, worldCuts, worldSha256 } from '../../cli/assembly-world.ts';
import { composeAssembly } from '../../cli/assembly.ts';
import type { PieceReport } from '../../cli/finalize.ts';
import { BAR, WINDOW, placed } from './fixtures/assembly-fixture.ts';
import { FIXTURES, L, R, fresh, finalize, lBlack, lSpec, lWhite, piece, rWhite, stackIn } from './helpers/assembly-stack.ts';
import type { Point } from '../sketch/types.ts';

const P = (x: number, y: number): Point => ({ x, y });

describe('rigid fit', () => {
  const ring = [P(0, 0), P(40, 0), P(40, 10), P(0, 10)];
  const move = (r: Point[], theta: number, tx: number, ty: number) => r.map((p) => P(Math.cos(theta) * p.x - Math.sin(theta) * p.y + tx, Math.sin(theta) * p.x + Math.cos(theta) * p.y + ty));

  it('recovers a rotation and a translation exactly, and writes them as the SVG matrix', () => {
    const fit = fitRigid([ring], [move(ring, 1.2, 33, -7)]);
    expect(fit.rms).toBeLessThan(1e-9);
    expect(Math.atan2(fit.sin, fit.cos)).toBeCloseTo(1.2, 9);
    expect(fit.tx).toBeCloseTo(33, 9);
    expect(fitMatrix(fitRigid([BAR], [placed(BAR)]))).toMatch(/^matrix\(/);
  });

  it('measures how far a footprint is from congruent, rings with holes included', () => {
    const hole = [P(10, 3), P(30, 3), P(30, 7), P(10, 7)];
    expect(fitRigid([ring, hole], [move(ring, 0.4, 5, 5), move(hole, 0.4, 5, 5)]).rms).toBeLessThan(1e-9);
    expect(fitRigid([ring], [ring.map((p) => P(p.x * 1.2, p.y))]).rms).toBeGreaterThan(0.5);
    expect(fitRigid([ring], [ring.map((p) => P(-p.x, p.y))]).rms).toBeGreaterThan(5); // a mirror image is not a rotation
    expect(fitRigid([ring], [[...ring.slice(1), ring[0]]]).rms).toBeGreaterThan(5); // the same ring started at another vertex
    expect(() => fitRigid([ring], [ring.slice(0, 3)])).toThrow(/do not correspond/);
    expect(() => congruentFit([ring], [ring.map((p) => P(p.x + (p.x > 20 ? 0.5 : 0), p.y))], 'onlay x')).toThrow(/onlay x: footprint is not congruent to the part \(rigid fit leaves an RMS of/);
    expect(congruentFit([ring], [move(ring, 0.3, 1, 2).map((p) => P(p.x + 0.0004, p.y))], 'onlay x').rms).toBeLessThan(0.05);
    expect(parseFrom('lintel-l/black/bar')).toEqual({ assembly: 'lintel-l', ply: 'black', cut: 'bar' });
    expect(() => parseFrom('lintel-l/black')).toThrow(/must read/);
  });
});

describe('assembly pieces are refused before anything is rendered', () => {
  it('names the pair when an ink does not read on its paper', async () => {
    const bad = piece('lintel-l-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-badink-sketch.ts`, 'white');
    await expect(finalize(stackIn(fresh(), [bad]), bad)).rejects.toThrow('ply white: ink gold does not read on paper white');
  });

  it('refuses a group whose plies differ in params other than the ply', async () => {
    const drifting = piece('lintel-l-black', 'lintel-l', L, 'black', { spacing: 8 });
    await expect(finalize(stackIn(fresh(), [lWhite, drifting]), lWhite)).rejects.toThrow(/lintel-l-black and lintel-l-white differ in params other than ply/);
    await expect(finalize(stackIn(fresh(), [lWhite, { ...lBlack, seed: 2 }]), lWhite)).rejects.toThrow(/has seed 2, but lintel-l-white has seed 1/);
    await expect(finalize(stackIn(fresh(), [lWhite, { ...lBlack, sketch: R }]), lWhite)).rejects.toThrow(/is made from .*lintel-r-sketch.ts, but lintel-l-white from/);
  });

  it('refuses a ply made twice, an onlay, a border that is not crop marks on the cut pen, and a stray assembly name', async () => {
    await expect(finalize(stackIn(fresh(), [lWhite, { ...lBlack, params: { ply: 'white' } }]), lWhite)).rejects.toThrow(/ply white is made by both lintel-l-white and lintel-l-black/);
    const onlay = piece('lintel-r-bar', 'lintel-r', R, 'bar');
    await expect(finalize(stackIn(fresh(), [onlay]), onlay)).rejects.toThrow('onlay plotted and cut on lintel-l/black/bar: onlays are never finalized');
    await expect(finalize(stackIn(fresh(), [lWhite], { border: { style: 'double', pen: 'black' } }), lWhite)).rejects.toThrow(/must be crop marks on the cut pen \(black\)/);
    await expect(finalize(stackIn(fresh(), [lWhite], { border: { style: 'cropmarks', pen: 'carbon' } }), lWhite)).rejects.toThrow(/must be crop marks on the cut pen \(black\)/);
    await expect(finalize(stackIn(fresh(), [{ ...lWhite, assembly: undefined }]), { ...lWhite, assembly: undefined })).rejects.toThrow(/its "assembly" must name the panel/);
    const plain = { name: 'plain', assembly: 'x', sketch: 'src/__tests__/fixtures/empty-pen-sketch.ts', seed: 1 };
    await expect(finalize(stackIn(fresh(), [plain]), plain)).rejects.toThrow(/names assembly x, but .* does not declare one/);
  });

  it('cannot preview a panel whose plies are not finalized', async () => {
    await expect(composeAssembly(stackIn(fresh(), [lWhite, lBlack]), 'lintel-l')).rejects.toThrow(/lintel-l-white is not finalized/);
  });
});

const hasVpype = spawnSync('vpype', ['--version']).status === 0;
const hasPlotterServer = existsSync(join(process.env.PLOTTER_SERVER_DIR ?? join(homedir(), 'git', 'plotter-server'), 'src', 'pen-plan.ts'));

describe.skipIf(!hasVpype)('assembly end to end (local vpype)', () => {
  const out = fresh();
  const stack = stackIn(out, [lWhite, lBlack, rWhite]);
  const reports: Record<string, PieceReport> = {};
  const dir = (name: string) => join(out, name);

  beforeAll(async () => {
    for (const p of stack.pieces) reports[p.name] = await finalize(stack, p);
  }, 180_000);

  it('finalizes every ply to a configured plot on its own paper, with nothing moved', () => {
    for (const [name, paper] of [['lintel-l-white', '#f7f6f2'], ['lintel-l-black', '#141416'], ['lintel-r-white', '#f7f6f2']]) {
      const report = reports[name];
      expect(report.offset, `${name} is not recentred`).toEqual({ dx: 0, dy: 0 });
      expect(report.serverCompatible, `${name} keeps one layer per pen, so it has a config`).toBe(true);
      expect(existsSync(join(dir(name), 'config.json'))).toBe(true);
      expect(report.paper).toBe(paper);
      expect(report.palette).toBe(`ply-${report.assembly!.paper.id}`);
      expect(JSON.parse(readFileSync(join(dir(name), 'config.json'), 'utf8')).page.paper).toBe(paper);
    }
  });

  it('inks the cut pen and the border as the ply’s cut ink, and keeps the sketch’s own colours elsewhere', () => {
    const colours = (name: string) => Object.fromEntries(reports[name].layers.map((l) => [l.label.replace(/^\d+-/, ''), l.color]));
    expect(colours('lintel-l-black')).toEqual({ gold: '#c9a54a', black: '#c9a54a', 'finishing-border': '#c9a54a' }); // gold gel cuts the black paper
    expect(colours('lintel-l-white')).toEqual({ carbon: '#22282c', 'finishing-border': '#1c1c1e' }); // the fineliner cuts the white
  });

  it('draws one world on every ply of a panel, and records it with the cuts, the onlays and the signature box', () => {
    const [w, b, r] = ['lintel-l-white', 'lintel-l-black', 'lintel-r-white'].map((n) => reports[n].assembly!);
    expect(w.worldSha256).toBe(b.worldSha256);
    expect(r.worldSha256).not.toBe(w.worldSha256);
    expect(w).toMatchObject({ name: 'lintel-l', ply: 'white', index: 1, plies: 2, cutPen: 'black', cutInk: 'black', cuts: [], onlays: [], signature: { pen: 'carbon', box: { x: 50, y: 112, width: 30, height: 8 } } });
    expect(b).toMatchObject({ ply: 'black', index: 2, cutInk: 'gold', lift: 0.4, cuts: [{ id: 'w', kind: 'waste' }, { id: 'bar', kind: 'part' }] });
    expect(b.signature).toBeUndefined();
    expect(r).toMatchObject({ name: 'lintel-r', onlays: [{ ply: 'bar', from: 'lintel-l/black/bar' }] });
    // The fingerprint is of the rings in the render, and the cut kinds are read from the guides.
    const result = readPlyResult(dir('lintel-l-black'));
    expect(worldSha256(result.parts)).toBe(b.worldSha256);
    expect(worldCuts(result.parts, lSpec).find((c) => c.id === 'w')!.rings[0]).toEqual(WINDOW);
    expect(JSON.parse(readFileSync(join(dir('lintel-l-black'), 'report.json'), 'utf8')).assembly.cuts).toEqual(b.cuts);
  });

  it.skipIf(!hasPlotterServer)('passes plotter-server’s own checks, each with its negative control rejected', () => {
    const check = spawnSync(process.execPath, ['--import', 'tsx', 'cli/plotter-check.ts', dir('lintel-l-white'), dir('lintel-l-black'), dir('lintel-r-white')], { cwd: process.cwd(), encoding: 'utf8' });
    expect(check.stdout.match(/^OK .*negative control rejected/gm)).toHaveLength(3);
    expect(check.status).toBe(0);
  });

  it('checks the footprint against the part it is cut from, and refuses one that is not congruent', async () => {
    const skewed = piece('lintel-r-skew', 'lintel-r', `${FIXTURES}/assembly-lintel-r-skew-sketch.ts`, 'white');
    await expect(finalize(stackIn(out, [lWhite, lBlack, skewed]), skewed)).rejects.toThrow(/onlay bar of lintel-r \(lintel-l\/black\/bar\): footprint is not congruent to the part \(rigid fit leaves an RMS of/);
    // The source ply has to be finalized first, so the part can be checked.
    await expect(finalize(stackIn(fresh(), [lBlack, rWhite]), rWhite)).rejects.toThrow('onlay bar of lintel-r (lintel-l/black/bar): finalize lintel-l-black first, so the part can be checked');
    expect(plyCuts(readPlyResult(dir('lintel-l-black')).parts, lSpec, 'black').map((c) => c.kind)).toEqual(['waste', 'part']);
  }, 120_000);

  it('reads the plies finalized earlier back, and refuses one finalized with other params', async () => {
    const white8 = { ...lWhite, params: { ply: 'white', spacing: 8 } }, black8 = piece('lintel-l-black-8', 'lintel-l', L, 'black', { spacing: 8 });
    // The stack now says spacing 8 for both, so only the render of lintel-l-white (spacing 6) on disk can tell.
    await expect(finalize(stackIn(out, [white8, black8]), black8)).rejects.toThrow(/lintel-l-white was finalized with a different seed or params than lintel-l-black-8/);
  }, 60_000);

  it('refuses plies whose worlds differ even though their params agree', async () => {
    const leaky = `${FIXTURES}/assembly-lintel-l-leaky-sketch.ts`;
    const [a, b] = [piece('leaky-white', 'leaky', leaky, 'white'), piece('leaky-black', 'leaky', leaky, 'black')];
    const s = stackIn(fresh(), [a, b]);
    await finalize(s, a);
    await expect(finalize(s, b)).rejects.toThrow(/leaky-white and leaky-black do not draw one world/);
  }, 120_000);
});
