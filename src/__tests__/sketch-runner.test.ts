import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { main as sketchCli } from '../../cli/sketch.ts';

const base = `name:'test', page:{width:100,height:100,margin:10,paper:'#ffffff'}, pens:[{id:'ink',color:'#111111',width:0.3}], controls:[{type:'slider',id:'n',label:'Number',min:0,max:10,step:1,default:2}]`;
let dir: string;
let entry: string;

async function sketch(source: string): Promise<string> {
  await writeFile(entry, `export default {${source}};`);
  return entry;
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hatch3d-sketch-test-')); entry = join(dir, 'sketch.ts'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('sketch runner', () => {
  it('produces stable named random streams, paths, SVG, and identity', async () => {
    await sketch(`${base},draw(ctx){const a=ctx.random('one');const b=ctx.random('two');return [{id:'one',pen:'ink',paths:[[{x:10,y:10},{x:10+a()*20,y:20}]]},{id:'two',pen:'ink',paths:[[{x:20,y:20},{x:20+b()*20,y:30}]]},{id:'guide',pen:'ink',diagnostic:true,paths:[[{x:0,y:0},{x:100,y:100}]]}]}`);
    const a = await renderSketch({ entry, seed: 41 });
    const b = await renderSketch({ entry, seed: 41 });
    const c = await renderSketch({ entry, seed: 42 });
    expect(a.parts).toEqual(b.parts);
    expect(a.svg).toBe(b.svg);
    expect(a.identity).toBe(b.identity);
    expect(Object.hasOwn(a.metadata, 'navigators')).toBe(false);
    expect(Object.hasOwn(a.metadata, 'macros')).toBe(false);
    expect(Object.hasOwn(a, 'effectiveParams')).toBe(false);
    expect(c.identity).not.toBe(a.identity);
    expect(a.svg).toContain('inkscape:groupmode="layer"');
    expect(a.svg).toContain('data-part-id="one"');
    expect(a.svg).not.toContain('data-part-id="guide"');
    expect(a.stats.pathCount).toBe(2);
  });

  it('rejects bad schema, controls, and nonfinite geometry before serialization', async () => {
    await sketch(`${base},draw(){return [{id:'a',pen:'missing',paths:[[{x:0,y:0},{x:1,y:1}]]}]}`);
    await expect(renderSketch({ entry })).rejects.toThrow(/declared pen/);
    await sketch(`${base},draw(){return [{id:'a',pen:'ink',paths:[[{x:0,y:0},{x:NaN,y:1}]]}]}`);
    await expect(renderSketch({ entry })).rejects.toThrow(/non-finite point/);
    await expect(renderSketch({ entry, params: { n: 1.5 } })).rejects.toThrow(/step/);
    await expect(renderSketch({ entry, params: { bad: 1 } })).rejects.toThrow(/Unknown parameter/);
    await sketch(`${base},pens:[{id:'ink',color:'#000',width:0.3},{id:'ink',color:'#111',width:0.3}],draw(){return []}`);
    await expect(inspectSketch({ entry })).rejects.toThrow(/Duplicate pen/);
  });

  it('validates grouped and conditional control metadata while retaining hidden values', async () => {
    const controls = `[{type:'select',id:'mode',label:'Mode',default:'flat',options:['flat','deep'],optionLabels:{flat:'Flat study',deep:'Deep study'},group:'Composition'},` +
      `{type:'slider',id:'depth',label:'Depth',min:0,max:10,step:1,default:2,group:'Details',showWhen:{control:'mode',equals:'deep'}}]`;
    const source = (definition: string) => `${base.replace(/controls:\[.*\]$/, `controls:${definition}`)},draw(ctx){return [{id:'line',pen:'ink',paths:[[{x:10,y:10},{x:20+Number(ctx.params.depth),y:20}]]}]}`;
    await sketch(source(controls));
    const meta = await inspectSketch({ entry });
    expect(meta.controls[0]).toMatchObject({ group: 'Composition', optionLabels: { flat: 'Flat study' } });
    expect(meta.controls[1]).toMatchObject({ group: 'Details', showWhen: { control: 'mode', equals: 'deep' } });
    const hidden = await renderSketch({ entry, params: { mode: 'flat', depth: 8 } });
    expect(hidden.params).toEqual({ mode: 'flat', depth: 8 });
    expect(hidden.parts[0].paths[0][1].x).toBe(28);
    await expect(renderSketch({ entry, params: { mode: 'flat', depth: 8.5 } })).rejects.toThrow(/step/);

    for (const [invalid, message] of [
      [controls.replace("group:'Details'", "group:'   '"), /Invalid group/],
      [controls.replace("control:'mode'", "control:'missing'"), /Invalid showWhen reference/],
      [controls.replace("equals:'deep'", 'equals:2'), /Invalid value for select/],
      [controls.replace("equals:'deep'", "equals:'absent'"), /Invalid value for select/],
      [controls.replace("flat:'Flat study'", "absent:'Absent'"), /Invalid option labels/],
      [controls.replace("control:'mode'", "control:'depth'"), /Invalid showWhen reference/],
    ] as const) {
      await sketch(source(invalid));
      await expect(inspectSketch({ entry })).rejects.toThrow(message);
    }
  });

  it('exposes native navigation metadata and passes effective macro values only to draw', async () => {
    const controls = `[{type:'slider',id:'drive',label:'Drive',min:0,max:10,step:1,default:5},` +
      `{type:'slider',id:'x',label:'X',min:0,max:10,step:1,default:2},` +
      `{type:'slider',id:'y',label:'Y',min:0,max:10,step:1,default:2},` +
      `{type:'slider',id:'z',label:'Z',min:0,max:10,step:1,default:2}]`;
    const source = `${base.replace(/controls:\[.*\]$/, `controls:${controls}`)},navigators:[{id:'space',label:'Space',axes:['x','y','z']}],macros:[{control:'drive',targets:[{control:'x',amount:6}]}],draw(ctx){return [{id:'line',pen:'ink',paths:[[{x:10,y:10},{x:20+ctx.params.x,y:20}]]}]}`;
    await sketch(source);
    const metadata = await inspectSketch({ entry });
    expect(metadata.navigators).toEqual([{ id: 'space', label: 'Space', axes: ['x', 'y', 'z'] }]);
    expect(metadata.macros).toEqual([{ control: 'drive', targets: [{ control: 'x', amount: 6 }] }]);
    const neutral = await renderSketch({ entry });
    expect(neutral.params.x).toBe(2);
    expect(neutral.effectiveParams?.x).toBe(2);
    const moved = await renderSketch({ entry, params: { drive: 10 } });
    expect(moved.params).toEqual({ drive: 10, x: 2, y: 2, z: 2 });
    expect(moved.effectiveParams).toEqual({ drive: 10, x: 5, y: 2, z: 2 });
    expect(moved.parts[0].paths[0][1].x).toBe(25);
    expect(moved.identity).not.toBe(neutral.identity);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const output = join(dir, 'macro-render');
      await sketchCli(['render', entry, '--params', '{"drive":10}', '--out', output]);
      const cliResult = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
      expect(cliResult.params).toEqual(moved.params);
      expect(cliResult.effectiveParams).toEqual(moved.effectiveParams);
      expect(cliResult.identity).toBe(moved.identity);
    } finally {
      log.mockRestore();
    }
  });

  it('rejects invalid navigator and macro references before rendering', async () => {
    const controls = `[{type:'slider',id:'a',label:'A',min:0,max:10,step:1,default:5},` +
      `{type:'slider',id:'b',label:'B',min:0,max:10,step:1,default:5},` +
      `{type:'slider',id:'c',label:'C',min:0,max:10,step:1,default:5},` +
      `{type:'slider',id:'d',label:'D',min:0,max:10,step:1,default:5},` +
      `{type:'slider',id:'flat',label:'Flat',min:1,max:1,step:1,default:1},` +
      `{type:'toggle',id:'flag',label:'Flag',default:false}]`;
    const source = (extra: string) => `${base.replace(/controls:\[.*\]$/, `controls:${controls}`)},${extra},draw(){return []}`;
    for (const [extra, message] of [
      [`navigators:[{id:'nav',label:'Nav',axes:['a','b']}]`, /3-8 axes/],
      [`navigators:[{id:'nav',label:'Nav',axes:['a','b','b']}]`, /Invalid navigator axis/],
      [`navigators:[{id:'nav',label:'Nav',axes:['a','b','missing']}]`, /Invalid navigator axis/],
      [`navigators:[{id:'nav',label:'Nav',axes:['a','b','flag']}]`, /Invalid navigator axis/],
      [`navigators:[{id:'nav',label:'Nav',axes:['a','b','c']},{id:'nav',label:'Again',axes:['a','b','c']}]`, /Duplicate navigator id/],
      [`macros:[{control:'flag',targets:[{control:'b',amount:1}]}]`, /Invalid macro source/],
      [`macros:[{control:'missing',targets:[{control:'b',amount:1}]}]`, /Invalid macro source/],
      [`macros:[{control:'a',targets:[{control:'flag',amount:1}]}]`, /Invalid macro target/],
      [`macros:[{control:'a',targets:[{control:'flat',amount:1}]}]`, /Invalid macro target/],
      [`macros:[{control:'flat',targets:[{control:'b',amount:1}]}]`, /Invalid macro source/],
      [`macros:[{control:'a',targets:[{control:'missing',amount:1}]}]`, /Invalid macro target/],
      [`macros:[{control:'a',targets:[{control:'b',amount:Infinity}]}]`, /Invalid macro target/],
      [`macros:[{control:'a',targets:[{control:'b',amount:1},{control:'b',amount:2}]}]`, /Duplicate macro target/],
      [`macros:[{control:'a',targets:[{control:'b',amount:1}]},{control:'a',targets:[{control:'c',amount:1}]}]`, /Duplicate macro source/],
      [`macros:[{control:'a',targets:[{control:'b',amount:1}]},{control:'b',targets:[{control:'c',amount:1}]}]`, /Invalid macro target/],
    ] as const) {
      await sketch(source(extra));
      await expect(inspectSketch({ entry })).rejects.toThrow(message);
    }
  });

  it('clips actual page geometry and retains a sketch-created hole', async () => {
    const helper = pathToFileURL(resolve('src/patch/region-hatch.ts')).href;
    await writeFile(entry, `import { hatchRegion } from ${JSON.stringify(helper)}; export default {${base},draw(){const outer=[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];const hole=[{x:30,y:30},{x:70,y:30},{x:70,y:70},{x:30,y:70}];return [{id:'hatch',pen:'ink',boundary:[outer,hole],paths:hatchRegion([outer,hole],0,10)}]}};`);
    const result = await renderSketch({ entry });
    const at50 = result.parts[0].paths.filter((line) => line[0].y === 50);
    expect(at50).toHaveLength(2);
    expect(at50.map((line) => [line[0].x, line.at(-1)!.x])).toEqual([[10, 30], [70, 90]]);
    for (const line of result.parts[0].paths) for (const p of line) expect(p.x >= 10 && p.x <= 90 && p.y >= 10 && p.y <= 90).toBe(true);
  });

  it('composes alpha on paper and preserves contain versus cover', async () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([0, 0, 0, 255, 0, 0, 0, 0]);
    await writeFile(join(dir, 'image.png'), PNG.sync.write(png));
    await sketch(`${base},assets:{contain:{path:'image.png',box:{x:0,y:0,width:20,height:20},fit:'contain'},cover:{path:'image.png',box:{x:40,y:0,width:20,height:20},fit:'cover'}},draw(ctx){return [{id:'samples',pen:'ink',paths:[[{x:10+ctx.assets.contain.sample(1,1),y:10+ctx.assets.contain.sample(5,10)},{x:20+ctx.assets.contain.sample(15,10),y:20+ctx.assets.cover.sample(45,10)}]]}]}`);
    const result = await renderSketch({ entry });
    const [a, b] = result.parts[0].paths[0];
    expect(a).toEqual({ x: 11, y: 10 }); // contain letterbox is paper, left source pixel black
    expect(b).toEqual({ x: 21, y: 20 }); // transparent right pixel is paper, cover crops to black
    expect(result.metadata.assets.contain.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('reloads changed transitive helpers in a fresh child', async () => {
    const helper = join(dir, 'helper.ts');
    await writeFile(helper, 'export const x = 20;');
    await writeFile(entry, `import { x } from './helper.ts'; export default {${base},draw(){return [{id:'p',pen:'ink',paths:[[{x:10,y:10},{x,y:20}]]}]}};`);
    const first = await renderSketch({ entry });
    await writeFile(helper, 'export const x = 30;');
    const second = await renderSketch({ entry });
    expect(first.parts[0].paths[0][1].x).toBe(20);
    expect(second.parts[0].paths[0][1].x).toBe(30);
  });

  it('terminates hung renders on timeout and abort', async () => {
    await sketch(`${base},async draw(){await new Promise(()=>{});return []}`);
    await expect(renderSketch({ entry, timeoutMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController();
    const pending = renderSketch({ entry, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('compares direct and pinned result JSON with a nonzero conflict exit', async () => {
    const beforeFile = join(dir, 'before.json');
    const afterFile = join(dir, 'after.json');
    const result = { schemaVersion: 1, identity: 'abc', metadata: { name: 'test', page: { width: 100, height: 100 }, pens: [{ id: 'ink', color: '#111', width: 0.3 }], controls: [], assets: {} }, params: {}, seed: 0, parts: [{ id: 'line', pen: 'ink', paths: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]] }], svg: '<svg/>', diagnostics: [], stats: { pathCount: 1, pointCount: 2, lengthMm: 1.414, partCount: 1 }, durationMs: 1 };
    await writeFile(beforeFile, JSON.stringify(result));
    await writeFile(afterFile, JSON.stringify({ pinId: 'pin', pinnedAt: 'now', result: { ...result, parts: [{ ...result.parts[0], paths: [[{ x: 1, y: 1 }, { x: 3, y: 2 }]] }] } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prior = process.exitCode;
    try {
      await sketchCli(['compare', beforeFile, '--after', afterFile, '--parts', 'line']);
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ ok: false, changes: [{ scope: 'part', id: 'line' }] });
      await expect(sketchCli(['compare', beforeFile, '--after', afterFile, '--parts', 'line', '--seed', '2'])).rejects.toMatchObject({ code: 'usage' });
      await expect(sketchCli(['replay', dir])).rejects.toMatchObject({ code: 'usage' });
    } finally {
      process.exitCode = prior;
      log.mockRestore();
    }
  });
});
