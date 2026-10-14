import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkInksRead, congruentFit, fitMatrix, fitRigid, parseFrom, plyCuts, readPlyResult, registrationProblem, worldCuts, worldSha256, type PlyResult } from '../../cli/assembly-world.ts';
import { composeAssembly } from '../../cli/assembly.ts';
import { loadStack, type Piece, type PieceReport, type Stack } from '../../cli/finalize.ts';
import { BAR, WINDOW, placed } from './fixtures/assembly-fixture.ts';
import { FIXTURES, L, R, fresh, finalize, hashTree, lBlack, lSpec, lWhite, piece, rWhite, runFinalize, stackIn } from './helpers/assembly-stack.ts';
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
    expect(() => congruentFit([ring], [ring.map((p) => P(p.x + (p.x > 20 ? 0.5 : 0), p.y))], 'onlay x')).toThrow(/onlay x: footprint is not congruent to the part: the footprint must be the part ring transformed, same vertex count, order and start vertex \(rigid fit leaves an RMS of/);
    expect(congruentFit([ring], [move(ring, 0.3, 1, 2).map((p) => P(p.x + 0.0004, p.y))], 'onlay x').rms).toBeLessThan(0.05);
    expect(parseFrom('lintel-l/black/bar')).toEqual({ assembly: 'lintel-l', ply: 'black', cut: 'bar' });
    expect(() => parseFrom('lintel-l/black')).toThrow(/must read/);
  });
});

describe('congruence is bounded by the worst vertex as well as the RMS', () => {
  const circle = (n: number, r = 50): Point[] => Array.from({ length: n }, (_, i) => P(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)));
  const move = (ring: Point[]) => ring.map((p) => P(p.x + 30, p.y + 20));

  it('refuses a 400-vertex ring with one 1 mm outlier, which the RMS alone lets through, and says what a footprint must be', () => {
    const part = circle(400), footprint = move(part);
    footprint[200] = P(footprint[200].x + 1, footprint[200].y);
    expect(fitRigid([part], [footprint]).rms).toBeLessThan(0.05);
    expect(() => congruentFit([part], [footprint], 'onlay x')).toThrow(/onlay x: footprint is not congruent to the part: the footprint must be the part ring transformed, same vertex count, order and start vertex/);
    expect(() => congruentFit([part], [footprint], 'onlay x')).toThrow(/RMS of 0\.0\d+ mm against a limit of 0\.05, and a worst vertex 1\.00 mm off against a limit of 0\.1/);
  });

  it('refuses a footprint whose vertices are all a little off, though none is far (RMS between 0.05 and 0.2 mm)', () => {
    const part = circle(40), footprint = move(part).map((p, i) => P(p.x + (i % 2 ? 0.08 : -0.08), p.y));
    const fit = fitRigid([part], [footprint]);
    expect(fit.rms).toBeGreaterThan(0.05);
    expect(fit.rms).toBeLessThan(0.2);
    expect(() => congruentFit([part], [footprint], 'onlay x')).toThrow(/same vertex count, order and start vertex/);
    expect(congruentFit([part], [move(part).map((p, i) => P(p.x + (i % 2 ? 0.03 : -0.03), p.y))], 'onlay x').rms).toBeLessThan(0.05);
  });

  it('names the correspondence when the vertex counts differ', () => {
    expect(() => congruentFit([circle(8)], [circle(9)], 'onlay x')).toThrow(/same vertex count, order and start vertex/);
  });
});

describe('plies must have been finished on one page and border', () => {
  const result = (margin: number, border: Record<string, unknown> = { style: 'cropmarks', pen: 'black' }, width = 100): PlyResult => ({
    identity: 'x', seed: 1, params: {}, metadata: { name: 'x', page: { width, height: 140, margin, paper: '#fff' } }, finishing: { page: { width, height: 140, margin }, border } as PlyResult['finishing'], parts: [] });

  it('refuses plies at margins 16 and 10, another size, or another border, and accepts the same fit on another paper', () => {
    expect(registrationProblem(result(16), result(10))).toBe('margin 16 mm against margin 10 mm');
    expect(registrationProblem(result(16), result(16, undefined, 120))).toBe('100 x 140 mm against 120 x 140 mm');
    expect(registrationProblem(result(16), result(16, { style: 'cropmarks', pen: 'black', inset: 12 }))).toBe('the border differs');
    expect(registrationProblem(result(16), result(16, { pen: 'black', style: 'cropmarks' }))).toBeUndefined();
  });
});

describe('the cuts as a render records them', () => {
  const spec = { control: 'ply', cutPen: 'cut', margin: 1, bleed: 1, plies: [
    { id: 'a', paper: { id: 'white', color: '#fff' }, pens: [], cutInk: 'x' }, { id: 'a-b', paper: { id: 'black', color: '#000' }, pens: [], cutInk: 'x' }] };
  const diag = (id: string, paths: Point[][]) => ({ id, pen: 'cut', paths, diagnostic: true });
  const ring = [P(10, 10), P(20, 10), P(20, 20), P(10, 20), P(10, 10)];

  it('reads asm-a-b-x as cut x of ply a-b when plies a and a-b both fit the prefix, and asm-a-y as cut y of ply a', () => {
    const cuts = worldCuts([diag('asm-a-b-x', [ring]), diag('asm-a-y', [ring])], spec);
    expect(cuts.map((c) => [c.ply, c.id])).toEqual([['a-b', 'x'], ['a', 'y']]);
  });

  it('throws for a cut the page fit clipped away entirely, instead of reporting it as something', () => {
    expect(() => worldCuts([diag('asm-a-w', [])], spec)).toThrow(/cut w of ply a is clipped away by the page fit/);
    const guide = { id: 'cut-w', pen: 'cut', paths: [], boundary: [ring.slice(0, 4)] };
    expect(() => plyCuts([diag('asm-a-w', []), guide], spec, 'a')).toThrow(/clipped away/);
  });

  it('fingerprints the signature box with the cuts, so plies that disagree about it are not one world', () => {
    const cut = diag('asm-a-w', [ring]);
    expect(worldSha256([cut, diag('asm-signature', [[P(0, 0), P(5, 0), P(5, 5), P(0, 5), P(0, 0)]])])).not.toBe(worldSha256([cut, diag('asm-signature', [[P(0, 0), P(6, 0), P(6, 5), P(0, 5), P(0, 0)]])]));
  });
});

describe('assembly pieces are refused before anything is rendered', () => {
  it('names the pair when an ink does not read on its paper', async () => {
    const bad = piece('lintel-l-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-badink-sketch.ts`, 'white');
    await expect(finalize(stackIn(fresh(), [bad]), bad)).rejects.toThrow('ply white: ink gold does not read on paper white');
  });

  it('refuses an ink that is only on trial on its paper, unless the stack says trial inks are fine, and says so', async () => {
    const trial = piece('lintel-l-trial-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-trial-sketch.ts`, 'white');
    await expect(finalize(stackIn(fresh(), [trial]), trial)).rejects.toThrow('ply white: ink silver does not read on paper white (it is on trial there: set defaults.trialInks in the stack to plot it anyway)');
    await expect(finalize(stackIn(fresh(), [trial], { defaults: { trialInks: false } }), trial)).rejects.toThrow(/ink silver does not read on paper white/);
    // The flag is for trials only: an ink the catalog does not list for the paper stays refused, and so does an unknown one.
    const bad = piece('lintel-l-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-badink-sketch.ts`, 'white');
    await expect(finalize(stackIn(fresh(), [bad], { defaults: { trialInks: true } }), bad)).rejects.toThrow('ply white: ink gold does not read on paper white');
  });

  it('checkInksRead accepts a trial ink only with the flag, and returns the pens it accepted as trials', () => {
    const ply = (paper: string, pens: string[], cutInk: string) => ({ id: 'p', paper: { id: paper, color: '#ffffff' }, pens, cutInk });
    // Silver, fluoro pink and fluoro orange are on trial for white; gold for gold-yellow; fluoro green and yellow for no paper but black.
    const white = ply('white', ['carbon', 'silver', 'fluoro-pink', 'ultramarine'], 'carbon');
    expect(() => checkInksRead(white)).toThrow('ply p: ink silver does not read on paper white (it is on trial there: set defaults.trialInks in the stack to plot it anyway); ink fluoro-pink does not read on paper white (it is on trial there');
    expect(checkInksRead(white, { trialInks: true })).toEqual(['silver', 'fluoro-pink']);
    expect(() => checkInksRead(white, { trialInks: false })).toThrow(/ink silver does not read on paper white/);
    expect(checkInksRead(ply('white', ['carbon', 'black'], 'carbon'))).toEqual([]);
    expect(checkInksRead(ply('gold-yellow', ['black', 'gold'], 'black'), { trialInks: true })).toEqual(['gold']);
    expect(checkInksRead(ply('black', ['gold', 'silver'], 'gold'), { trialInks: true })).toEqual([]); // they read on black
    // The cut ink is checked too: a trial cut ink is reported as a trial pen.
    expect(checkInksRead(ply('white', ['carbon'], 'silver'), { trialInks: true })).toEqual(['silver']);
    expect(() => checkInksRead(ply('white', ['carbon'], 'silver'))).toThrow(/ink silver does not read on paper white/);
    // Not trial, not reading, and unknown stay errors with the flag on.
    expect(() => checkInksRead(ply('white', ['fluoro-green'], 'carbon'), { trialInks: true })).toThrow('ply p: ink fluoro-green does not read on paper white');
    expect(() => checkInksRead(ply('white', ['gold'], 'carbon'), { trialInks: true })).toThrow('ink gold does not read on paper white');
    expect(() => checkInksRead(ply('white', ['nope'], 'carbon'), { trialInks: true })).toThrow('nope on white: Unknown ink: nope');
  });

  it('refuses a trialInks that is not a boolean when the stack is read', () => {
    const write = (defaults: unknown) => { const path = join(fresh(), 'stack.json'); writeFileSync(path, JSON.stringify({ out: 'x', pieces: [lWhite], defaults })); return path; };
    expect(loadStack(write({ trialInks: true })).defaults?.trialInks).toBe(true);
    expect(() => loadStack(write({ trialInks: 'yes' }))).toThrow('Stack defaults.trialInks must be true or false');
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

  it('refuses a sibling piece that is an onlay, which is never finalized', async () => {
    const onlay = piece('lintel-r-bar', 'lintel-r', R, 'bar');
    await expect(finalize(stackIn(fresh(), [rWhite, onlay]), rWhite)).rejects.toThrow(/lintel-r-bar is ply bar, an onlay plotted and cut on lintel-l\/black\/bar: onlays are never finalized/);
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

  it('accepts a trial ink when the stack allows it, and records which pens are trials', async () => {
    const trial = piece('lintel-l-trial-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-trial-sketch.ts`, 'white');
    const allowed = stackIn(fresh(), [trial], { defaults: { trialInks: true } });
    const report = await finalize(allowed, trial);
    expect(report.assembly!.trialPens).toEqual(['silver']);
    expect(JSON.parse(readFileSync(join(allowed.out, 'lintel-l-trial-white', 'report.json'), 'utf8')).assembly.trialPens).toEqual(['silver']);
    // Plies of the ordinary stack have none.
    for (const name of ['lintel-l-white', 'lintel-l-black', 'lintel-r-white']) expect(reports[name].assembly!.trialPens, name).toEqual([]);
  }, 60_000);

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
    await expect(finalize(stackIn(out, [lWhite, lBlack, skewed]), skewed)).rejects.toThrow(/onlay bar of lintel-r \(lintel-l\/black\/bar\): footprint is not congruent to the part: .* \(rigid fit leaves an RMS of/);
    // The source ply has to be finalized first, so the part can be checked.
    await expect(finalize(stackIn(fresh(), [lBlack, rWhite]), rWhite)).rejects.toThrow('onlay bar of lintel-r (lintel-l/black/bar): finalize lintel-l-black first, so the part can be checked');
    expect(plyCuts(readPlyResult(dir('lintel-l-black')).parts, lSpec, 'black').map((c) => c.kind)).toEqual(['waste', 'part']);
  }, 120_000);

  it('reads the plies finalized earlier back, and refuses one finalized with other params as stale', async () => {
    const white8 = { ...lWhite, params: { ply: 'white', spacing: 8 } }, black8 = piece('lintel-l-black-8', 'lintel-l', L, 'black', { spacing: 8 });
    // The stack now says spacing 8 for both, so only the render of lintel-l-white (spacing 6) on disk can tell.
    await expect(finalize(stackIn(out, [white8, black8]), black8)).rejects.toThrow('lintel-l-white is stale on disk: finalize it in this run');
  }, 60_000);

  it('explains a page fit that moves the plies when the border spacing follows the width of each ply’s cut ink', async () => {
    // Gold gel (0.5 mm) cuts the black ply and the black fineliner (0.35 mm) the white one: an explicit inset fits the page to each.
    const s = stackIn(fresh(), [lWhite, lBlack], { border: { style: 'cropmarks', pen: 'black', inset: 12, contentGap: 1 } });
    await finalize(s, lWhite);
    await expect(finalize(s, lBlack)).rejects.toThrow(/do not draw one world.*border sets inset or contentGap.*leave both out/);
  }, 120_000);

  it('refuses a sibling or source on disk that is not what the stack now asks for, saying so, instead of trusting or contradicting it', async () => {
    // lintel-l-black on disk was finalized with seed 1; the stack now says seed 2. Panel R's onlay is cut from it.
    const reseeded: Piece = { ...lBlack, seed: 2 };
    await expect(finalize(stackIn(out, [lWhite, reseeded, rWhite]), rWhite)).rejects.toThrow('lintel-l-black is stale on disk: finalize it in this run');
    // Both ends changed: the skewed footprint is not what the answer should be about.
    const skewed = piece('lintel-r-skew', 'lintel-r', `${FIXTURES}/assembly-lintel-r-skew-sketch.ts`, 'white');
    await expect(finalize(stackIn(out, [lWhite, reseeded, skewed]), skewed)).rejects.toThrow('lintel-l-black is stale on disk: finalize it in this run');
    // A sibling in the same panel is held to the same rule.
    await expect(finalize(stackIn(out, [{ ...lWhite, seed: 2 }, { ...lBlack, seed: 2 }]), { ...lBlack, seed: 2 })).rejects.toThrow('lintel-l-white is stale on disk: finalize it in this run');
  }, 120_000);

  it('refuses a ply on disk that was finished on another margin or border than the one being drawn, though its request is as asked', async () => {
    const s = stackIn(fresh(), [lWhite, lBlack]);
    await finalize(s, lWhite);
    const path = join(s.out, 'lintel-l-white', 'source', 'result.json');
    const result = JSON.parse(readFileSync(path, 'utf8')) as PlyResult;
    writeFileSync(path, JSON.stringify({ ...result, metadata: { ...result.metadata, page: { ...result.metadata.page, margin: 10 } } }));
    await expect(finalize(s, lBlack)).rejects.toThrow(/lintel-l-white and lintel-l-black were not finalized on the same page and border: margin 16 mm against margin 10 mm/);
  }, 120_000);

  it('does not let a malformed onlay in an unrelated panel block a finalize', async () => {
    const stray = piece('stray-white', 'stray', `${FIXTURES}/assembly-lintel-r-badfrom-sketch.ts`, 'white');
    const report = await finalize(stackIn(fresh(), [lWhite, stray]), lWhite);
    expect(report.assembly!.name).toBe('lintel-l');
    await expect(finalize(stackIn(fresh(), [stray]), stray)).rejects.toThrow(/onlay source "oops" must read/);
  }, 120_000);

  it('refuses, before anything is signed, a signing ply whose signing pen draws nothing', async () => {
    const bare = piece('lintel-l-white', 'lintel-l', `${FIXTURES}/assembly-lintel-l-nocarbon-sketch.ts`, 'white');
    await expect(finalize(stackIn(fresh(), [bare]), bare)).rejects.toThrow(/ply white has no carbon layer to sign into: its signature pen draws nothing/);
  }, 60_000);

  it('refuses a footprint that the render of a finalized panel lost, found when the part is finalized', async () => {
    const s = stackIn(fresh(), [lBlack, rWhite]);
    await finalize(s, lBlack);
    await finalize(s, rWhite);
    const path = join(s.out, 'lintel-r-white', 'source', 'result.json');
    const result = JSON.parse(readFileSync(path, 'utf8')) as { parts: { id: string }[] };
    writeFileSync(path, JSON.stringify({ ...result, parts: result.parts.filter((p) => p.id !== 'asm-bar-bar') }));
    await expect(finalize(s, lBlack)).rejects.toThrow(/the render has 0 footprint cuts for ply bar, not one/);
  }, 120_000);

  it('refuses plies whose worlds differ even though their params agree', async () => {
    const leaky = `${FIXTURES}/assembly-lintel-l-leaky-sketch.ts`;
    const [a, b] = [piece('leaky-white', 'leaky', leaky, 'white'), piece('leaky-black', 'leaky', leaky, 'black')];
    const s = stackIn(fresh(), [a, b]);
    await finalize(s, a);
    await expect(finalize(s, b)).rejects.toThrow(/leaky-white and leaky-black do not draw one world/);
  }, 120_000);

  describe('a run of the whole stack', () => {
    const shifted = (stackOut: string, shift: number): Stack => stackIn(stackOut, [
      { ...lWhite, params: { ...lWhite.params, windowShift: shift } }, { ...lBlack, params: { ...lBlack.params, windowShift: shift } }, rWhite]);

    it('succeeds in one go after a cut has moved, instead of failing against the previous run’s plies for ever', () => {
      const s = shifted(fresh(), 0);
      expect(runFinalize(s).status, 'the first run').toBe(0);
      const moved = shifted(s.out, 3);
      const again = runFinalize(moved);
      expect(again.stderr + again.stdout).not.toMatch(/"error"/);
      expect(again.status).toBe(0);
      // The window really moved, on both plies, and every ply says so alike.
      const worlds = ['lintel-l-white', 'lintel-l-black'].map((n) => readPlyResult(join(s.out, n)));
      expect(worldSha256(worlds[0].parts)).toBe(worldSha256(worlds[1].parts));
      expect(worldCuts(worlds[1].parts, lSpec).find((c) => c.id === 'w')!.rings[0][0].x).toBe(WINDOW[0].x + 3);
      const reports = ['lintel-l-white', 'lintel-l-black'].map((n) => JSON.parse(readFileSync(join(s.out, n, 'report.json'), 'utf8')).assembly.worldSha256);
      expect(reports[0]).toBe(reports[1]);
      expect(reports[0]).toBe(worldSha256(worlds[0].parts));
    }, 180_000);

    it('leaves the live directories byte for byte as they were when a check fails, and no staging behind', () => {
      const s = shifted(fresh(), 0);
      expect(runFinalize(s).status).toBe(0);
      const names = ['lintel-l-white', 'lintel-l-black', 'lintel-r-white'];
      const before = Object.fromEntries(names.map((n) => [n, hashTree(join(s.out, n))]));
      // Panel R's footprint no longer matches the part: the whole run is refused after every ply has been drawn.
      const skewedRun: Stack = { ...shifted(s.out, 3), pieces: [...shifted(s.out, 3).pieces.slice(0, 2), { ...rWhite, sketch: `${FIXTURES}/assembly-lintel-r-skew-sketch.ts` }] };
      const run = runFinalize(skewedRun);
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toMatch(/not congruent/);
      for (const n of names) expect(hashTree(join(s.out, n)), n).toEqual(before[n]);
      expect(readdirSync(s.out).filter((f) => f.startsWith('.staging'))).toEqual([]);
    }, 180_000);

    it('takes the plies outside an --only run from disk, once they are known to be current', () => {
      const s = shifted(fresh(), 0);
      expect(runFinalize(s).status).toBe(0);
      expect(runFinalize(s, ['lintel-r-white']).status).toBe(0);
      const moved = shifted(s.out, 3);
      const run = runFinalize(moved, ['lintel-r-white']);
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toMatch(/lintel-l-black is stale on disk: finalize it in this run/);
    }, 180_000);
  });
});
