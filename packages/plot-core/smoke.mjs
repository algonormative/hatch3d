import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(root, '../..');
const temp = mkdtempSync(join(tmpdir(), 'plot-core-pack-'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root));
  assert(packed.length === 1, 'Expected one package tarball');
  const archive = join(temp, packed[0].filename);
  const unpack = join(temp, 'unpack');
  mkdirSync(unpack);
  run('tar', ['-xzf', archive, '-C', unpack], temp);
  const files = packed[0].files.map(({ path }) => path);
  for (const name of ['dist/index.js', 'dist/index.d.ts', 'dist/planar.js', 'dist/planar.d.ts', 'dist/spatial.js', 'dist/spatial.d.ts', 'LICENSE']) {
    assert(files.includes(name), `Packed package missing ${name}`);
  }
  for (const name of ['index', 'planar']) {
    const code = readFileSync(join(unpack, 'package/dist', `${name}.js`), 'utf8');
    assert(!/from ["'](?:three|simplex-noise|react|react-dom|node:)/.test(code), `${name} imports an optional runtime`);
    assert(!/renderDepthBufferCPU|WebGLRenderingContext|CompositionRegistry/.test(code), `${name} contains 3D or GPU code`);
  }
  assert(!/\/Users\/chronick-mbp|\.\.\/\.\.\/src\//.test(readFileSync(join(unpack, 'package/dist/spatial.d.ts'), 'utf8')), 'Spatial types leak checkout paths');
  const setup = (name, peers) => {
    const dir = join(temp, name);
    const scope = join(dir, 'node_modules/@hatch3d');
    mkdirSync(scope, { recursive: true });
    cpSync(join(unpack, 'package'), join(scope, 'plot-core'), { recursive: true });
    for (const peer of peers) { const target = join(dir, 'node_modules', peer); mkdirSync(dirname(target), { recursive: true }); symlinkSync(join(checkout, 'node_modules', peer), target); }
    writeFileSync(join(dir, 'package.json'), '{"type":"module","private":true}\n');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: false }, include: ['consumer.ts'] }));
    return dir;
  };
  const core = setup('core-only', []);
  writeFileSync(join(core, 'consumer.mjs'), `import { validateSketch, svgFor, strokeText } from '@hatch3d/plot-core';\nimport { createHatch3d2DSketch } from '@hatch3d/plot-core/planar';\nconst sketch = createHatch3d2DSketch({ composition: { id:'line', name:'Line', generate:()=>[[{x:0,y:0},{x:10,y:10}]] }, page:{width:100,height:100}, pen:{id:'ink',color:'#000',width:0.3}, transform:false });\nif(validateSketch(sketch).name !== 'Line' || !svgFor({name:'Line',page:sketch.page,pens:sketch.pens,controls:[],assets:{}}, [{id:'x',pen:'ink',paths:strokeText('A',0,0,{height:5})}]).includes('data-part-id')) throw Error('Core/planar smoke failed');\n`);
  writeFileSync(join(core, 'consumer.ts'), `import type { Sketch, RenderResult } from '@hatch3d/plot-core';\nimport { createHatch3d2DSketch } from '@hatch3d/plot-core/planar';\nconst sketch: Sketch = createHatch3d2DSketch({composition:{id:'line',name:'Line',generate:()=>[]},page:{width:100,height:100},pen:{id:'ink',color:'#000',width:0.3}});\ndeclare const result: RenderResult; void [sketch,result];\n`);
  run('node', ['consumer.mjs'], core);
  run(process.execPath, [join(checkout, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], core);
  const spatial = setup('with-spatial', ['three', 'simplex-noise', '@types/three']);
  writeFileSync(join(spatial, 'consumer.mjs'), `import { createHatch3d3DSketch } from '@hatch3d/plot-core/spatial';\nconst sketch=createHatch3d3DSketch({composition:{id:'simple',name:'Simple',layers:()=>[{surface:'torus',hatch:{family:'u',count:3,samples:6}}]},page:{width:100,height:100,margin:10},pen:{id:'ink',color:'#000',width:0.3},canvas:{width:40,height:40}});\nconst params=Object.fromEntries(sketch.controls.map(c=>[c.id,c.default]));\nconst parts=await sketch.draw({params,seed:1,assets:{},random:()=>()=>0.5});\nif(!Array.isArray(parts)||parts.length!==1||parts[0].id!=='simple-solids') throw Error('Spatial smoke failed');\n`);
  writeFileSync(join(spatial, 'consumer.ts'), `import type { Sketch } from '@hatch3d/plot-core';\nimport { createHatch3d3DSketch, type Legacy3DOptions } from '@hatch3d/plot-core/spatial';\nconst options: Legacy3DOptions={composition:{id:'simple',name:'Simple',layers:()=>[{surface:'torus',hatch:{count:3}}]},page:{width:100,height:100},pen:{id:'ink',color:'#000',width:0.3}};\nconst sketch: Sketch=createHatch3d3DSketch(options); void sketch;\n`);
  run('node', ['consumer.mjs'], spatial);
  run(process.execPath, [join(checkout, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], spatial);
  console.log('Packed core, planar, and spatial imports and declarations passed in separate consumers.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
