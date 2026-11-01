import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { layerInk, loadStack, penDownSpeed, planPriming, primingBoxes, primingPath, serverConfig, toSketchGrammar, type PieceReport, type Stack } from '../../cli/finalize.ts';
import { INKS } from '../sketch/materials.ts';
import { fresh, finalize, lBlack, lWhite, stackIn } from './helpers/assembly-stack.ts';

const gelOn: Stack['defaults'] = { gelSpeed: true, prime: true };
const tabloid = { height: 431.8 };
const asm = { cutPen: 'cut', cutInk: 'silver' };

describe('gel pens in the catalog', () => {
  it('marks every gel ink, and only those, with the provisional pen-down speed of 15 percent', () => {
    for (const ink of Object.values(INKS)) {
      const isGel = /^(Signo|Moonlight) |^Copper gel$/.test(ink.pen ?? '');
      expect(ink.gel === true, `${ink.id} gel`).toBe(isGel);
      expect(ink.speedPendown, `${ink.id} speedPendown`).toBe(isGel ? 15 : undefined);
    }
    expect(Object.values(INKS).filter((ink) => ink.gel)).toHaveLength(15);
  });
});

describe('the pen-down speed of a layer', () => {
  const on = { defaults: { gelSpeed: true }, border: { style: 'cropmarks', pen: 'cut' } };
  it('is the ink’s speedPendown, for a gel art layer and for the cut and border layers of a ply cut with a gel', () => {
    expect(penDownSpeed('gold', on, asm)).toBe(15);
    expect(penDownSpeed('cut', on, asm)).toBe(15); // the cut guides take the cut ink (silver)
    expect(penDownSpeed('finishing-border', on, asm)).toBe(15);
  });

  it('is nothing for a pen that is not a gel, and for the cut and border layers of a ply cut with a fineliner', () => {
    expect(penDownSpeed('carbon', on, asm)).toBeUndefined();
    expect(penDownSpeed('cut', on, { cutPen: 'cut', cutInk: 'black' })).toBeUndefined();
    expect(penDownSpeed('finishing-border', on, { cutPen: 'cut', cutInk: 'carbon' })).toBeUndefined();
    expect(penDownSpeed('vermilion', on, asm)).toBeUndefined();
    expect(penDownSpeed('constructor', on, asm)).toBeUndefined();
    expect(penDownSpeed('not-an-ink', on)).toBeUndefined();
  });

  it('is nothing at all unless the stack sets gelSpeed', () => {
    for (const defaults of [undefined, {}, { gelSpeed: false }, { prime: true }]) {
      for (const id of ['gold', 'silver', 'cut', 'finishing-border']) expect(penDownSpeed(id, { ...on, defaults }, asm), `${id} ${JSON.stringify(defaults)}`).toBeUndefined();
    }
  });

  it('gives the border of an ordinary piece the speed of the stack border’s pen', () => {
    expect(penDownSpeed('finishing-border', { defaults: { gelSpeed: true }, border: { style: 'simple', pen: 'gold' } })).toBe(15);
    expect(penDownSpeed('finishing-border', { defaults: { gelSpeed: true }, border: { style: 'simple', pen: 'carbon' } })).toBeUndefined();
    expect(penDownSpeed('finishing-border', { defaults: { gelSpeed: true } })).toBeUndefined();
    expect(layerInk('finishing-border', { border: { style: 'simple', pen: 'gold' } })).toMatchObject({ art: false, ink: { id: 'gold' } });
    expect(layerInk('gold', {}, asm)).toMatchObject({ art: true, ink: { id: 'gold' } });
  });

  it('is written to config.json as speed_pendown on those layers only, and the config is as it was without it', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'source'));
    const result = join(dir, 'source', 'result.json');
    const page = { width: 100, height: 140, margin: 16, paper: '#141416' };
    writeFileSync(result, JSON.stringify({ identity: 'abc', metadata: { name: 'x', page, pens: [{ id: 'gold', color: '#c9a54a', width: 0.39 }, { id: 'carbon', color: '#22282c', width: 0.25 }] }, params: {}, seed: 1 }));
    const layer = (pen: string, part: string) => `<g inkscape:groupmode="layer" inkscape:label="1-${pen}" data-pen-id="${pen}"><g data-part-id="${part}"><path d="M0,0L1,1"/></g></g>`;
    const source = `<svg>${layer('gold', 'g')}${layer('carbon', 'c')}</svg>`;
    const report = { title: 'X', seed: 1, layers: [], sourceSha256: 's', preparedSha256: 'p' } as unknown as PieceReport;
    const before = JSON.stringify(serverConfig(result, source, report)); // as serverConfig has always written it
    const layers = (speed?: (id: string) => number | undefined) => (serverConfig(result, source, report, undefined, speed).layers as Record<string, unknown>[]);
    expect(layers().map((l) => Object.keys(l))).toEqual([['id', 'color', 'width', 'passes', 'parts'], ['id', 'color', 'width', 'passes', 'parts']]);
    expect(JSON.stringify(serverConfig(result, source, report, undefined, () => undefined))).toBe(before);
    expect(before).not.toContain('speed_pendown');
    expect(layers((id) => penDownSpeed(id, { defaults: { gelSpeed: true } }))).toEqual([
      { id: 'gold', color: '#c9a54a', width: 0.39, passes: 1, speed_pendown: 15, parts: ['g'] },
      { id: 'carbon', color: '#22282c', width: 0.25, passes: 1, parts: ['c'] },
    ]);
    expect(layers((id) => penDownSpeed(id, { defaults: { gelSpeed: true } }))[0]).toEqual(expect.objectContaining({ speed_pendown: 15 }));
  });
});

describe('where the priming strokes go', () => {
  it('stacks them down the left margin, each 20 mm long, outside the crop line, clear of the corner marks and the middle of the edge', () => {
    const line = 11, boxes = primingBoxes(13, tabloid, line);
    expect(boxes).toHaveLength(13);
    expect(boxes[0]).toEqual({ x0: 4, y0: 14, x1: 6, y1: 34 });
    for (const [i, b] of boxes.entries()) {
      expect(b.y1 - b.y0, `box ${i} length`).toBeCloseTo(20, 9);
      expect(b.x0, `box ${i}`).toBeGreaterThanOrEqual(2);
      expect(b.x1, `box ${i}`).toBeLessThanOrEqual(8);
      expect(line - b.x1, `box ${i} is outside the crop line`).toBeGreaterThanOrEqual(3);
      expect(b.y0 - line, `box ${i} clears the top corner marks`).toBeGreaterThanOrEqual(3);
      expect(tabloid.height - line - b.y1, `box ${i} clears the bottom corner marks`).toBeGreaterThanOrEqual(3);
      expect(b.y1 <= tabloid.height / 2 - 12 || b.y0 >= tabloid.height / 2 + 12, `box ${i} is off the middle of the edge`).toBe(true);
      if (i) expect(b.y0 - boxes[i - 1].y1, `box ${i} is apart from the one above`).toBeGreaterThanOrEqual(4);
    }
    // Distinct places: no two share a spot.
    expect(new Set(boxes.map((b) => b.y0)).size).toBe(13);
  });

  it('holds as many as the edge has room for, and refuses more, or a margin too narrow to clear the crop line', () => {
    expect(primingBoxes(16, tabloid, 11)).toHaveLength(16);
    expect(() => primingBoxes(17, tabloid, 11)).toThrow(/no room in the left margin for 17 priming strokes on a page 431.8 mm tall \(it holds 16\)/);
    expect(primingBoxes(0, tabloid, 4)).toEqual([]); // nothing to prime, so the margin does not matter
    expect(() => primingBoxes(1, tabloid, 8.9)).toThrow(/needs a left margin of at least 9 mm .* 8.9 mm/);
    expect(primingBoxes(1, tabloid, 9)).toHaveLength(1);
  });

  it('draws a zigzag of 6 legs and 2 mm across, down the 20 mm of its box', () => {
    const d = primingPath({ x0: 4, y0: 14, x1: 6, y1: 34 });
    const points = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(d.startsWith('M4,14L')).toBe(true);
    expect(points).toHaveLength(7);
    expect(points.map((p) => p.x)).toEqual([4, 6, 4, 6, 4, 6, 4]);
    expect(points[6].y).toBe(34);
    points.slice(1).forEach((p, i) => expect(p.y).toBeGreaterThan(points[i].y));
  });

  it('primes each gel art layer in layer order, and not the cut guides, the border or a fineliner', () => {
    const plan = new Map([
      [7, { label: '7-gold', penId: 'gold' }], [1, { label: '1-carbon', penId: 'carbon' }], [3, { label: '3-silver', penId: 'silver' }],
      [8, { label: '8-cut', penId: 'cut' }], [9, { label: '9-finishing-border', penId: 'finishing-border' }],
    ]);
    const { paths, record } = planPriming(plan, {}, { height: 431.8, margin: 11 }, asm);
    expect(record.map((r) => [r.layer, r.pen, r.box.y0])).toEqual([['3-silver', 'silver', 14], ['7-gold', 'gold', 38]]);
    expect([...paths.keys()]).toEqual([3, 7]);
    expect(paths.get(3)).toBe(primingPath(record[0].box));
    // The cut ink is a gel, and the cut layer is still not art.
    expect(planPriming(new Map([[2, { label: '2-cut', penId: 'cut' }]]), {}, { height: 431.8, margin: 11 }, asm).record).toEqual([]);
    // A border pen that is a gel on an ordinary piece is not primed either.
    expect(planPriming(new Map([[2, { label: '2-finishing-border', penId: 'finishing-border' }]]), { border: { style: 'simple', pen: 'gold' } }, { height: 431.8, margin: 11 }).record).toEqual([]);
  });

  it('measures the margin to the border’s inset, else the page margin, and refuses a page whose margin is too narrow', () => {
    const plan = new Map([[1, { label: '1-gold', penId: 'gold' }]]);
    expect(planPriming(plan, { border: { style: 'cropmarks', pen: 'cut', inset: 12 } }, { height: 140, margin: 4.5 }).record).toHaveLength(1);
    expect(() => planPriming(plan, {}, { height: 140, margin: 4.5 })).toThrow(/at least 9 mm/);
  });

  it('writes the stroke as the first path of its layer, before everything vpype made, and leaves the other layers alone', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="279.4mm" height="431.8mm" viewBox="0 0 279.4 431.8">'
      + '<g inkscape:groupmode="layer" inkscape:label="1-gold" data-pen-id="gold" data-passes="1" fill="none" stroke="#c9a54a" stroke-width="0.39"></g>'
      + '<g inkscape:groupmode="layer" inkscape:label="2-carbon" data-pen-id="carbon" data-passes="1" fill="none" stroke="#22282c" stroke-width="0.25"></g></svg>';
    const vpype = '<svg viewBox="0 0 1056 1632">'
      + '<g fill="none" inkscape:groupmode="layer" id="layer1" inkscape:label="1"><polyline points="0,0 96,96"/><line x1="0" y1="0" x2="96" y2="0"/></g>'
      + '<g fill="none" inkscape:groupmode="layer" id="layer2" inkscape:label="2"><polyline points="0,0 96,0"/></g></svg>';
    const plan = new Map([[1, { label: '1-gold', penId: 'gold', passes: 1 }], [2, { label: '2-carbon', penId: 'carbon', passes: 1 }]]);
    const plain = toSketchGrammar(vpype, source, plan);
    const primed = toSketchGrammar(vpype, source, plan, new Map([[1, 'M4,14L6,17.333']]));
    expect(primed).toBe(plain.replace(/(<g [^>]*data-pen-id="gold"[^>]*>\n)/, '$1<path d="M4,14L6,17.333"/>\n'));
    expect(primed.split('\n').filter((l) => l.startsWith('<path')).slice(0, 2)).toEqual(['<path d="M4,14L6,17.333"/>', '<path d="M0,0L25.4,25.4"/>']);
  });
});

describe('the stack options are checked when the stack is read', () => {
  const write = (defaults: unknown) => { const path = join(fresh(), 'stack.json'); writeFileSync(path, JSON.stringify({ out: 'x', pieces: [lWhite], defaults })); return path; };
  it('refuses a gelSpeed or a prime that is not a boolean', () => {
    expect(loadStack(write({ gelSpeed: true, prime: true })).defaults).toEqual({ gelSpeed: true, prime: true });
    expect(loadStack(write({ gelSpeed: false })).defaults?.gelSpeed).toBe(false);
    expect(() => loadStack(write({ gelSpeed: 'yes' }))).toThrow('Stack defaults.gelSpeed must be true or false');
    expect(() => loadStack(write({ prime: 1 }))).toThrow('Stack defaults.prime must be true or false');
  });
});

const hasVpype = spawnSync('vpype', ['--version']).status === 0;
const hasPlotterServer = existsSync(join(process.env.PLOTTER_SERVER_DIR ?? join(homedir(), 'git', 'plotter-server'), 'src', 'pen-plan.ts'));

interface Run { dir: string; reports: Record<string, PieceReport> }
async function run(defaults: Stack['defaults']): Promise<Run> {
  const out = fresh();
  const stack = stackIn(out, [lWhite, lBlack], defaults === undefined ? {} : { defaults });
  const reports: Record<string, PieceReport> = {};
  for (const p of stack.pieces) reports[p.name] = await finalize(stack, p);
  return { dir: out, reports };
}
const layersOf = (svg: string) => svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1).map((chunk) => ({
  id: /data-pen-id="([^"]*)"/.exec(chunk)![1], paths: [...chunk.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]),
}));
const points = (d: string) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
const configOf = (r: Run, name: string) => JSON.parse(readFileSync(join(r.dir, name, 'config.json'), 'utf8')) as { layers: Record<string, unknown>[]; preparation: unknown };
const plotReady = (r: Run, name: string) => layersOf(readFileSync(join(r.dir, name, 'plot-ready.svg'), 'utf8'));

describe.skipIf(!hasVpype)('gentler gel plotting, end to end (local vpype)', () => {
  let off: Run, absent: Run, on: Run;
  beforeAll(async () => {
    [off, absent, on] = [await run({ gelSpeed: false, prime: false }), await run(undefined), await run(gelOn)];
  }, 240_000);

  it('changes nothing when the stack does not opt in: no speed_pendown, no priming, the config as it was', () => {
    for (const name of ['lintel-l-white', 'lintel-l-black']) {
      const a = configOf(off, name), b = configOf(absent, name);
      expect(JSON.stringify(a.layers)).not.toContain('speed_pendown');
      expect(a.layers.map((l) => Object.keys(l))).toEqual(a.layers.map(() => ['id', 'name', 'color', 'width', 'passes', 'parts']));
      // Everything but the hash of the prepared file, which vpype's reloop does not keep from run to run.
      expect({ ...a, preparation: undefined }).toEqual({ ...b, preparation: undefined });
      expect(off.reports[name].priming).toBeUndefined();
      expect(absent.reports[name].priming).toBeUndefined();
      expect(off.reports[name].layers.every((l) => l.speedPendown === undefined)).toBe(true);
      expect(plotReady(off, name).map((l) => l.paths.length)).toEqual(plotReady(absent, name).map((l) => l.paths.length));
    }
  });

  it('gives the gel layers speed_pendown 15, the cut and border layers their cut ink’s, and a fineliner’s layers none', () => {
    const speeds = (name: string) => Object.fromEntries(configOf(on, name).layers.map((l) => [l.id, l.speed_pendown]));
    // The black ply is drawn in gold and cut with gold; the white ply in carbon and cut with the Micron 08.
    expect(speeds('lintel-l-black')).toEqual({ gold: 15, black: 15, 'finishing-border': 15 });
    expect(speeds('lintel-l-white')).toEqual({ carbon: undefined, 'finishing-border': undefined });
    expect(JSON.stringify(configOf(on, 'lintel-l-white').layers)).not.toContain('speed_pendown');
    expect(on.reports['lintel-l-black'].layers.map((l) => l.speedPendown)).toEqual([15, 15, 15]);
  });

  it('times a layer at its own speed: 36 mm/s at 15 percent where 60 mm/s is the 25 percent default', () => {
    const slow = on.reports['lintel-l-black'].layers, base = off.reports['lintel-l-black'].layers;
    for (const [i, l] of slow.entries()) {
      expect(l.minutes).toBeCloseTo(l.passes * 1.1 * (l.drawMm / 36 + l.travelMm / 200) / 60, 9);
      expect(l.minutes).toBeGreaterThan(base[i].minutes);
    }
    for (const l of on.reports['lintel-l-white'].layers) expect(l.speedPendown, `${l.label} runs at the job's speed`).toBeUndefined();
  });

  it('starts each gel layer with its priming stroke, in the margin outside the crop line and inside the page', () => {
    const report = on.reports['lintel-l-black'];
    // The fixture sheet is 100 x 140 mm with a 16 mm margin, so its crop line stands at 16 mm.
    expect(report.priming).toEqual([{ layer: '1-gold', pen: 'gold', box: { x0: 4, y0: 19, x1: 6, y1: 39 } }]);
    const [gold, ...rest] = plotReady(on, 'lintel-l-black');
    expect(gold.id).toBe('gold');
    expect(gold.paths[0]).toBe(primingPath(report.priming![0].box));
    const zig = points(gold.paths[0]);
    for (const p of zig) {
      expect(p.x, 'inside the page, left of the crop line').toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(16);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(140);
    }
    // Nothing else of the layer is in the margin; the other layers are as many paths as without it, and none is a priming stroke.
    const plain = plotReady(off, 'lintel-l-black');
    expect(gold.paths.length).toBe(plain[0].paths.length + 1);
    expect(gold.paths.slice(1).every((d) => points(d).some((p) => p.x >= 16))).toBe(true);
    expect(rest.map((l) => l.paths.length)).toEqual(plain.slice(1).map((l) => l.paths.length));
    expect(rest.flatMap((l) => l.paths)).not.toContain(gold.paths[0]);
  });

  it('adds no stroke to a ply with no gel layer, nor to the cut and border layers of one cut with a gel', () => {
    expect(on.reports['lintel-l-white'].priming).toEqual([]);
    expect(plotReady(on, 'lintel-l-white').map((l) => l.paths.length)).toEqual(plotReady(off, 'lintel-l-white').map((l) => l.paths.length));
    expect(plotReady(on, 'lintel-l-black').map((l) => l.id)).toEqual(['gold', 'black', 'finishing-border']);
    expect(plotReady(on, 'lintel-l-black').slice(1).map((l) => l.paths.length)).toEqual(plotReady(off, 'lintel-l-black').slice(1).map((l) => l.paths.length));
  });

  it.skipIf(!hasPlotterServer)('still passes plotter-server’s own checks, each with its negative control rejected', () => {
    const check = spawnSync(process.execPath, ['--import', 'tsx', 'cli/plotter-check.ts', join(on.dir, 'lintel-l-white'), join(on.dir, 'lintel-l-black')], { cwd: process.cwd(), encoding: 'utf8' });
    expect(check.stdout.match(/^OK .*negative control rejected/gm)).toHaveLength(2);
    expect(check.status).toBe(0);
  });
});
