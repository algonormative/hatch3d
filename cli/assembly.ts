/**
 * Preview an assembly: lay its finalized plies on top of each other, bottom to top, as the glued panel will look.
 *
 *   node --import tsx cli/assembly.ts preview <stack.json> [--assembly name] [--shadow] [--out dir]
 *
 * Every ply must be finalized (`cli/finalize.ts run`). Per assembly of the stack it writes, to
 * `<out>/_assembly/<name>/` (`--out` defaults to the stack's `out`):
 *
 *   assembled.svg   the panel, trimmed at the crop marks: each sheet ply on its paper, with its waste and its parts
 *                   cut out (so the guides in the waste go with it and the ply below shows through), and each onlay
 *                   being the part of its source ply, moved onto its footprint by the rigid fit of one ring to the other
 *   assembled.png   the same, rendered
 *   exploded.png    every ply side by side on its own paper, guides visible
 *
 * `--shadow` adds a soft drop shadow under any ply that declares a `lift`. Nothing here plots or uploads anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSvgPng } from './sketch/export-png.ts';
import { montagePng } from './sheet.ts';
import { fitMatrix, congruentFit, parseFrom, plyCuts, readPlyResult, worldCuts, type PlyResult } from './assembly-world.ts';
import { loadSketch, loadStack, plyOf, slug, type Piece, type Stack } from './finalize.ts';
import type { AssemblySpec, Point } from '../src/sketch/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fail(message: string): never { throw new Error(message); }
const num = (n: number) => String(+n.toFixed(4));

interface Group { name: string; spec: AssemblySpec; members: { piece: Piece; ply: string }[] }
/** A finalized sheet ply: its paper, its artwork as the plotter gets it, and what its render says about the world. */
interface Sheet { piece: Piece; dir: string; paper: string; layers: string; result: PlyResult }

async function loadGroup(stack: Stack, name: string): Promise<Group> {
  const pieces = stack.pieces.filter(p => p.assembly === name);
  if (!pieces.length) fail(`no piece of the stack belongs to assembly ${name}`);
  const loaded = await loadSketch(stack, pieces[0].sketch);
  const spec = loaded.assembly ?? fail(`${pieces[0].sketch} does not declare an assembly`);
  return { name, spec, members: pieces.map(piece => ({ piece, ply: plyOf(stack, piece, loaded).ply.id })) };
}

function readSheet(stack: Stack, group: Group, ply: string): Sheet {
  const piece = group.members.find(m => m.ply === ply)?.piece ?? fail(`assembly ${group.name} has no piece for ply ${ply} in the stack`);
  const dir = resolve(ROOT, stack.out, slug(piece.name));
  for (const file of ['report.json', 'plot-ready.svg', join('source', 'result.json')]) {
    if (!existsSync(join(dir, file))) fail(`ply ${ply} of ${group.name}: ${piece.name} is not finalized (no ${file}); run cli/finalize.ts first`);
  }
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { paper: string };
  const prepared = readFileSync(join(dir, 'plot-ready.svg'), 'utf8');
  return { piece, dir, paper: report.paper, layers: prepared.replace(/^\s*<svg\b[^>]*>\s*/, '').replace(/\s*<\/svg>\s*$/, ''), result: readPlyResult(dir) };
}

const ringPath = (ring: Point[]) => `M${ring.map(p => `${num(p.x)},${num(p.y)}`).join('L')}Z`;

export interface Assembled { svg: string; width: number; height: number; tiles: { label: string; image: string | Buffer }[] }

/**
 * The panel, as an SVG trimmed at the crop marks, and the tiles of its exploded view. Throws, naming the ply, when a
 * ply is not finalized or an onlay's footprint is not its part.
 */
export async function composeAssembly(stack: Stack, name: string, options: { shadow?: boolean } = {}): Promise<Assembled> {
  const group = await loadGroup(stack, name);
  const sheets = new Map(group.spec.plies.filter(p => !p.onlay).map(p => [p.id, readSheet(stack, group, p.id)]));
  const first = [...sheets.values()][0] ?? fail(`assembly ${name} has no sheet ply`);
  const { width: W, height: H, margin } = first.result.metadata.page;
  for (const sheet of sheets.values()) {
    const page = sheet.result.metadata.page;
    if (page.width !== W || page.height !== H) fail(`assembly ${name}: ${sheet.piece.name} is ${page.width} x ${page.height} mm, but ${first.piece.name} is ${W} x ${H} mm`);
  }
  // Trim at the crop marks: the rectangle they stand at the corners of.
  const inset = first.result.finishing?.border?.inset ?? margin ?? 0;
  const trim = { x: inset, y: inset, width: W - 2 * inset, height: H - 2 * inset };
  const cutsOf = (result: PlyResult, spec: AssemblySpec, ply: string) => worldCuts(result.parts, spec).filter(c => c.ply === ply);
  const defs: string[] = [`<clipPath id="asm-trim"><rect x="${num(trim.x)}" y="${num(trim.y)}" width="${num(trim.width)}" height="${num(trim.height)}"/></clipPath>`];
  const body: string[] = [];
  const tiles: Assembled['tiles'] = [];
  for (const [position, ply] of group.spec.plies.entries()) {
    const clip = `asm-clip-${ply.id}`;
    let inner: string;
    if (!ply.onlay) {
      const sheet = sheets.get(ply.id)!;
      // The sheet less every cut (waste and parts alike): even-odd over the page rectangle and each cut's rings.
      const rings = cutsOf(sheet.result, group.spec, ply.id).flatMap(c => c.rings);
      defs.push(`<clipPath id="${clip}"><path clip-rule="evenodd" d="M0,0H${num(W)}V${num(H)}H0Z${rings.map(ringPath).join('')}"/></clipPath>`);
      inner = `<g clip-path="url(#${clip})"><rect x="0" y="0" width="${num(W)}" height="${num(H)}" fill="${sheet.paper}"/>\n${sheet.layers}\n</g>`;
      tiles.push({ label: `${position + 1} ${ply.id} (${ply.paper.id} paper)`, image: join(sheet.dir, 'plot-ready.png') });
    } else {
      const label = `onlay ${ply.id} of ${name} (${ply.onlay.from})`;
      const ref = parseFrom(ply.onlay.from);
      const sourceGroup = ref.assembly === name ? group : await loadGroup(stack, ref.assembly);
      const source = sourceGroup === group && sheets.has(ref.ply) ? sheets.get(ref.ply)! : readSheet(stack, sourceGroup, ref.ply);
      const kind = plyCuts(source.result.parts, sourceGroup.spec, ref.ply).find(c => c.id === ref.cut)?.kind;
      if (kind !== 'part') fail(`${label}: ply ${ref.ply} of ${ref.assembly} has no part cut ${ref.cut}`);
      const part = cutsOf(source.result, sourceGroup.spec, ref.ply).find(c => c.id === ref.cut)!;
      const footprint = cutsOf(first.result, group.spec, ply.id)[0] ?? fail(`${label}: no footprint in the render`);
      const fit = congruentFit(part.rings, footprint.rings, label);
      defs.push(`<clipPath id="${clip}"><path clip-rule="evenodd" d="${part.rings.map(ringPath).join('')}"/></clipPath>`);
      const piece = `<g clip-path="url(#${clip})"><rect x="0" y="0" width="${num(W)}" height="${num(H)}" fill="${source.paper}"/>\n${source.layers}\n</g>`;
      inner = `<g transform="${fitMatrix(fit)}">${piece}</g>`;
      // Shown on its own, where it is cut from, on a grey ground.
      const alone = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(W)}mm" height="${num(H)}mm" viewBox="0 0 ${num(W)} ${num(H)}"><defs><clipPath id="${clip}"><path clip-rule="evenodd" d="${part.rings.map(ringPath).join('')}"/></clipPath></defs>${piece}</svg>`;
      tiles.push({ label: `${position + 1} ${ply.id} (onlay, cut from ${ref.assembly}/${ref.ply})`, image: renderSvgPng(alone, { width: W, height: H, paper: '#9a9a9a' }, 'paper', 3) });
    }
    if (options.shadow && ply.lift) {
      defs.push(`<filter id="asm-shadow-${ply.id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${num(W)}" height="${num(H)}" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="${num(ply.lift)}" stdDeviation="${num(ply.lift * 0.75)}" flood-color="#000000" flood-opacity="0.45"/></filter>`);
      inner = `<g filter="url(#asm-shadow-${ply.id})">${inner}</g>`;
    }
    body.push(`<g id="asm-ply-${ply.id}" data-ply="${ply.id}">${inner}</g>`);
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(trim.width)}mm" height="${num(trim.height)}mm" viewBox="${num(trim.x)} ${num(trim.y)} ${num(trim.width)} ${num(trim.height)}">`,
    `<defs>${defs.join('\n')}</defs>`,
    `<g clip-path="url(#asm-trim)">`, ...body, '</g>', '</svg>', '',
  ].join('\n');
  return { svg, width: trim.width, height: trim.height, tiles };
}

/** Where the preview of an assembly goes. */
export const previewDir = (stack: Stack, name: string, out?: string) => join(out ? resolve(out) : resolve(ROOT, stack.out), '_assembly', name);

/** Writes `assembled.svg`, `assembled.png` and `exploded.png`, and returns their directory. */
export async function previewAssembly(stack: Stack, name: string, options: { shadow?: boolean; out?: string } = {}): Promise<string> {
  const assembled = await composeAssembly(stack, name, options);
  const dir = previewDir(stack, name, options.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'assembled.svg'), assembled.svg);
  writeFileSync(join(dir, 'assembled.png'), renderSvgPng(assembled.svg, { width: assembled.width, height: assembled.height, paper: '#ffffff' }, 'paper', 4));
  writeFileSync(join(dir, 'exploded.png'), montagePng([assembled.tiles], 400));
  return dir;
}

async function main(argv: string[]): Promise<number> {
  const [command, stackPath, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (command !== 'preview' || !stackPath) {
    console.error('usage: node --import tsx cli/assembly.ts preview <stack.json> [--assembly name] [--shadow] [--out dir]');
    return 2;
  }
  const stack = loadStack(stackPath);
  const names = flag('assembly') ? [flag('assembly')!] : [...new Set(stack.pieces.flatMap(p => (p.assembly ? [p.assembly] : [])))];
  if (!names.length) { console.error('the stack has no assembly pieces'); return 2; }
  let failed = 0;
  for (const name of names) {
    try {
      const dir = await previewAssembly(stack, name, { shadow: rest.includes('--shadow'), out: flag('out') });
      console.log(`OK    ${name}: ${dir}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}: ${(error as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error((e as Error).message); process.exitCode = 2; });
}
