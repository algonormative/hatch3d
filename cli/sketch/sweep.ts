/**
 * Variant sweeps: one contact-sheet PNG answering an ambiguous request with a labelled grid of 3-9 variants (cap 25).
 * `vary` entries are the axes of a cartesian grid (the first is the rows, the second the columns; one entry is one
 * row). A plain sketch is rendered by the runner's child process; an assembly sketch is rendered in-process as the
 * assembled look (each ply's paper with its own cuts removed, its ink on top, onlays as their footprints).
 * See `docs/sketches.md` (Variant sweeps).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { montagePng } from '../sheet.ts';
import { PNG_SCALES, exportSketchPng, renderSvgPng } from './export-png.ts';
import { renderSketch } from './runner.ts';
import { renderSheets, type Flat, type LabSheets } from './lab/runtime.ts';
import type { Page, Sketch } from '../../src/sketch/types.ts';

export type SweepValue = number | string | boolean;
export interface SweepOptions {
  entry: string;
  vary: { id: string; values: SweepValue[] }[];
  params?: Record<string, unknown>;
  seed?: number;
  out: string;
  /** Width of one cell in the sheet, in pixels (default 360). */
  cellPx?: number;
  /** Plain sketches only: renders in flight at once (default 3). */
  concurrency?: number;
  /** An assembly renders through `draw` (the plot path) even when the sketch has a lab preview. */
  exact?: boolean;
}
export interface SweepResult { sheet: string; cells: { params: Record<string, unknown>; png: string }[] }

export const MAX_SWEEP_CELLS = 25;

/** `tilt=12,18,26` to an axis; numbers and true/false are typed, anything else stays a string. */
export function parseVary(spec: string): { id: string; values: SweepValue[] } {
  const eq = spec.indexOf('=');
  if (eq < 1) throw new Error(`--vary expects id=v1,v2,...; got "${spec}"`);
  const values = spec.slice(eq + 1).split(',').map((raw): SweepValue => {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  });
  if (!values.length || values.some(v => v === '')) throw new Error(`--vary ${spec.slice(0, eq)} needs at least one non-empty value`);
  return { id: spec.slice(0, eq).trim(), values };
}

const px = (n: number) => String(Math.round(n * 1000) / 1000);
const pathsOf = (f: Flat): string[] => {
  const out: string[] = [];
  for (let i = 0; i + 1 < f.starts.length; i++) {
    const pts: string[] = [];
    for (let k = f.starts[i]; k < f.starts[i + 1]; k++) pts.push(`${px(f.xy[2 * k])},${px(f.xy[2 * k + 1])}`);
    if (pts.length) out.push(pts.join(' '));
  }
  return out;
};
const ring = (pts: string) => `M${pts.replace(/ /g, 'L')}Z`;

/** The assembled look of one parameter set: the stack of plies, bottom to top, as one SVG in page millimetres. */
async function assembledSvg(sketch: Sketch, params: Record<string, unknown>, seed: number, preview?: LabSheets): Promise<string> {
  const { width: W, height: H } = sketch.page;
  const sheets = await renderSheets(sketch, params as never, seed, preview);
  const body = sheets.map((s, i) => {
    const rings = pathsOf(s.cuts).map(ring).join('');
    if (s.onlay) return rings ? `<path d="${rings}" fill="${s.paper}"/>` : '';
    const clip = `<clipPath id="c${i}"><path clip-rule="evenodd" d="M0,0H${W}V${H}H0Z${rings}"/></clipPath>`;
    const ink = s.layers.map(l => pathsOf(l.paths).map(p => `<polyline points="${p}" fill="none" stroke="${l.color}" stroke-width="${l.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')).join('');
    return `${clip}<g clip-path="url(#c${i})"><rect width="${W}" height="${H}" fill="${s.paper}"/>${ink}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#8a8a8a"/>${body}</svg>`;
}

const scaleFor = (page: Page, cellPx: number) => [...PNG_SCALES].reverse().find(s => page.width * s <= cellPx * 1.6) ?? 1;
const label = (cell: Record<string, unknown>, vary: SweepOptions['vary']) => vary.map(v => `${v.id} ${String(cell[v.id])}`).join(' · ');

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const { entry, vary, params = {}, seed = 0, cellPx = 360, concurrency = 3 } = options;
  if (vary.length < 1 || vary.length > 2) throw new Error('sweep needs one or two vary entries');
  if (vary.some(v => !v.values.length)) throw new Error('every vary entry needs at least one value');
  const total = vary.reduce((n, v) => n * v.values.length, 1);
  if (total > MAX_SWEEP_CELLS) throw new Error(`sweep of ${total} cells exceeds the cap of ${MAX_SWEEP_CELLS}`);
  const out = resolve(options.out);
  mkdirSync(join(out, 'cells'), { recursive: true });

  const rowAxis = vary[0], colAxis = vary[1];
  const grid: Record<string, unknown>[][] = rowAxis.values.map(rv =>
    (colAxis ? colAxis.values : [undefined]).map(cv => ({ ...params, [rowAxis.id]: rv, ...(colAxis ? { [colAxis.id]: cv } : {}) })));
  const flat = grid.flat();

  const file = resolve(entry);
  const mod = await import(pathToFileURL(file).href) as { default: Sketch; labSheets?: LabSheets };
  const sketch = mod.default;
  // An assembly previews from its lab preview when it has one (as the sketch lab does), unless `exact` asks for `draw`.
  const preview = options.exact ? undefined : mod.labSheets;
  if (!sketch?.page || !Array.isArray(sketch.pens)) throw new Error(`${entry} does not export a sketch with page and pens`);
  const scale = scaleFor(sketch.page, cellPx);
  const pngs: Buffer[] = new Array(flat.length);

  if (sketch.assembly) {
    // In-process and in order: a sketch's module-level caches carry across cells.
    for (let i = 0; i < flat.length; i++) pngs[i] = renderSvgPng(await assembledSvg(sketch, flat[i], seed, preview), sketch.page, 'paper', scale);
  } else {
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < flat.length; i = next++) pngs[i] = exportSketchPng(await renderSketch({ entry: file, params: flat[i] as never, seed }), 'paper', scale);
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, flat.length)) }, worker));
  }

  const cells = flat.map((p, i) => {
    const png = join(out, 'cells', `${String(i + 1).padStart(2, '0')}.png`);
    writeFileSync(png, pngs[i]);
    return { params: p, png };
  });
  const rows = grid.map((row, r) => row.map((cell, c) => ({ label: label(cell, vary), image: pngs[r * row.length + c] })));
  const sheet = join(out, 'sweep.png');
  writeFileSync(sheet, montagePng(rows, cellPx));
  writeFileSync(join(out, 'sweep.json'), JSON.stringify({ entry, seed, vary, cells: cells.map(c => c.params) }, null, 2) + '\n');
  return { sheet, cells };
}
