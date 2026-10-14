#!/usr/bin/env tsx
/**
 * Sign plot-ready SVGs: one small single-stroke line, "@algonormative  v1  234f812  2026-10-09",
 * in the bottom-right corner below the art, drawn as paths on the lettering pen so it plots
 * with the rest of the sheet. Re-signing replaces the previous signature.
 *
 *   npm run sign -- <print-queue-dir>...            edition, build and created from each index.md;
 *                                                   signs plot-ready.svg and rewrites its prepared_sha256
 *                                                   (older folders: render.svg, signed with the date alone)
 *   npm run sign -- --text "<line>" <file.svg>...   sign loose files with a given line
 *
 * Options: --handle <name> (default @algonormative), --dry (report placement, write nothing).
 *
 * Plies of an assembly (and any sheet whose layers are fixed) sign into a layer that already exists:
 *
 *   --pen <id>             sign into the existing layer with that data-pen-id, in its ink, instead of the lettering layer
 *   --box x0,y0,x1,y1      right-align the signature at the bottom of this box (millimetres) instead of below the art
 *
 * In a print-queue directory, `sign_pen` and `sign_box` in index.md's frontmatter stand in for the flags (the flags win),
 * and an entry with `sign: false` is skipped. A directory with a config.json is never given a new layer: plotter-server
 * rejects a changed layer count, so it must be signed into a layer it already has.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { measureStrokeText, strokeText } from '../packages/plot-core/src/stroke-text.ts';

const LETTERING_LAYER = (strokeWidth: string) => `inkscape:groupmode="layer" inkscape:label="6-lettering" data-pen-id="lettering" data-passes="1" fill="none" stroke="#22282c" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
const SIGNATURE = /\n?<g id="signature"[\s\S]*?<\/g><!--\/signature-->/;
const MM_PER: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96, '': 25.4 / 96 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const numbers = (s: string) => s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];

/** translate / scale / matrix, the transforms hatch3d and vpype write on groups. */
function parseTransform(attr: string): Matrix {
  let m = IDENTITY;
  for (const [, fn, args] of attr.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const a = numbers(args);
    if (fn === 'translate') m = multiply(m, [1, 0, 0, 1, a[0], a[1] ?? 0]);
    else if (fn === 'scale') m = multiply(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
    else if (fn === 'matrix') m = multiply(m, a as Matrix);
    else throw new Error(`unsupported transform ${fn}()`);
  }
  return m;
}

/**
 * Extent of the drawn geometry in user units: absolute M/L paths and polylines, through any
 * group transforms; a sheet clipped to a margin rect returns that rect.
 */
function artBounds(svg: string) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const stack: Matrix[] = [IDENTITY];
  const body = svg.replace(/<defs[\s\S]*?<\/defs>|<clipPath[\s\S]*?<\/clipPath>/g, '');
  for (const [, close, tag, attrs] of body.matchAll(/<(\/?)(g|path|polyline|polygon)\b([^>]*)>/g)) {
    if (tag === 'g') {
      if (close) stack.pop();
      else if (!attrs.endsWith('/')) {
        const t = attrs.match(/transform="([^"]+)"/);
        stack.push(t ? multiply(stack[stack.length - 1], parseTransform(t[1])) : stack[stack.length - 1]);
      }
      continue;
    }
    const geometry = attrs.match(tag === 'path' ? / d="([^"]+)"/ : / points="([^"]+)"/);
    if (!geometry) continue;
    const m = stack[stack.length - 1];
    const n = numbers(geometry[1]);
    for (let i = 0; i + 1 < n.length; i += 2) {
      const x = m[0] * n[i] + m[2] * n[i + 1] + m[4], y = m[1] * n[i] + m[3] * n[i + 1] + m[5];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  if (!Number.isFinite(x1 + y1)) throw new Error('no drawn geometry found');
  // An unframed render clipped to its margin box signs against that box, not wherever the drawing ends.
  const clip = svg.match(/<clipPath[^>]*>\s*<rect ([^>]*)\/?>/);
  if (clip) {
    const v = (k: string) => Number(clip[1].match(new RegExp(`(?<![\\w-])${k}="([^"]+)"`))?.[1] ?? 0);
    return { x0: v('x'), y0: v('y'), x1: v('x') + v('width'), y1: v('y') + v('height') };
  }
  return { x0, y0, x1, y1 };
}

export interface SignBox { x0: number; y0: number; x1: number; y1: number }
export interface SignOptions {
  /** Sign into the existing layer with this data-pen-id. */
  pen?: string;
  /** Right-align at the bottom of this box (millimetres) rather than below the art. */
  box?: SignBox;
  /** False: never append a layer (throw instead). */
  newLayer?: boolean;
}

/** Returns the signed SVG; throws when the sheet has no room below the art (or in the box), or no layer to sign into. */
export function signSvg(source: string, text: string, options: SignOptions = {}): { svg: string; note: string } {
  let svg = source.replace(SIGNATURE, '');
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const view = root.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!view) throw new Error('no "0 0 W H" viewBox');
  const [W, H] = [Number(view[1]), Number(view[2])];
  // Physical size: user units per mm from the root width (hatch3d writes mm, vpype cm over a px viewBox).
  const width = root.match(/\swidth="([\d.]+)(mm|cm|in|pt|px)?"/);
  const perMm = width ? W / (Number(width[1]) * MM_PER[width[2] ?? '']) : 1;
  const [Wmm, Hmm] = [W / perMm, H / perMm];
  // Cap height in mm: 0.7 on a pocket card, ~1.8 on an 11 x 17 or A3 sheet.
  const heightMm = Math.min(1.1, Math.max(0.7, Wmm / 250)) * (Wmm > 100 ? 1.6 : 1);
  const height = heightMm * perMm;
  const style = { face: 'sans' as const, height };
  let x: number, top: number;
  if (options.box) {
    // The box is a place the sketch kept clear for the signature: no art to measure, just whether the line fits.
    // The ink's own bounds (descenders included) go to the box's bottom right corner.
    const { x0, y0, x1, y1 } = options.box;
    const ink = strokeText(text, 0, 0, style).flat();
    const [left, right] = [Math.min(...ink.map(q => q.x)), Math.max(...ink.map(q => q.x))];
    const [high, low] = [Math.min(...ink.map(q => q.y)), Math.max(...ink.map(q => q.y))];
    if (right - left > (x1 - x0) * perMm || low - high > (y1 - y0) * perMm) {
      throw new Error(`the signature is ${((right - left) / perMm).toFixed(1)} x ${((low - high) / perMm).toFixed(2)} mm, which does not fit the ${+(x1 - x0).toFixed(2)} x ${+(y1 - y0).toFixed(2)} mm box`);
    }
    x = x1 * perMm - right;
    top = y1 * perMm - low;
  } else {
    const art = artBounds(svg);
    const gap = H - art.y1;
    if (gap < height * 1.8) throw new Error(`only ${(gap / perMm).toFixed(2)} mm below the art`);
    x = art.x1 - measureStrokeText(text, style);
    top = art.y1 + (gap - height) / 2;
  }
  const d = strokeText(text, x, top, style)
    .map(p => 'M' + p.map(q => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join('L')).join('');
  const attr = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const sig = `<g id="signature" data-signature="${attr}"><path d="${d}"/></g><!--/signature-->`;
  const lettering = /(<g [^>]*inkscape:label="6-lettering"[^>]*>)/;
  if (options.pen !== undefined) {
    // An existing layer, in its own ink: the signature group inherits that layer's stroke.
    const layer = [...svg.matchAll(/<g\b[^>]*>/g)].find(m => /inkscape:groupmode="layer"/.test(m[0]) && m[0].includes(` data-pen-id="${options.pen}"`));
    if (!layer) throw new Error(`no layer with data-pen-id="${options.pen}" to sign into`);
    const end = layer.index! + layer[0].length;
    svg = `${svg.slice(0, end)}\n${sig}${svg.slice(end)}`;
  } else if (lettering.test(svg)) svg = svg.replace(lettering, m => `${m}\n${sig}`);
  else {
    if (options.newLayer === false) throw new Error('no lettering layer to sign into, and a new layer would change the layer count that plotter-server checks: sign into an existing layer with --pen');
    if (!/xmlns:inkscape=/.test(root)) svg = svg.replace(root, root.replace(/^<svg\b/, '<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'));
    svg = svg.replace(/<\/svg>\s*$/, () => `<g ${LETTERING_LAYER(+(0.13 * perMm).toFixed(4) + '')}>\n${sig}</g>\n</svg>\n`);
  }
  return { svg, note: `${+Wmm.toFixed(1)}x${+Hmm.toFixed(1)} mm, ${heightMm.toFixed(2)} mm text at ${(x / perMm).toFixed(1)},${(top / perMm).toFixed(1)} mm` };
}

/** Record the signature line in index.md's frontmatter, after prepared_sha256 or created. */
function withSignature(md: string, line: string): string {
  if (/^signature:/m.test(md)) return md.replace(/^signature:.*$/m, `signature: "${line}"`);
  const after = /^prepared_sha256:.*$/m.test(md) ? /^(prepared_sha256:.*)$/m : /^(created:.*)$/m;
  return md.replace(after, `$1\nsignature: "${line}"`);
}

function frontmatter(md: string, key: string): string | undefined {
  return md.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1].trim();
}

export interface SignRun {
  /** The line to sign; a directory's own default is the handle, edition, build and created date. */
  text?: string;
  handle: string;
  dry: boolean;
  /** Flags; in a directory they win over `sign_pen` and `sign_box` in index.md. */
  pen?: string;
  box?: SignBox;
}

/** `x0,y0,x1,y1` in millimetres, with the box wider and taller than nothing. */
export function parseBox(value: string): SignBox {
  const n = value.split(',').map(Number);
  if (n.length !== 4 || n.some(v => !Number.isFinite(v)) || !(n[2] > n[0]) || !(n[3] > n[1])) throw new Error(`--box must be x0,y0,x1,y1 in millimetres, with x1 > x0 and y1 > y0 (got ${JSON.stringify(value)})`);
  return { x0: n[0], y0: n[1], x1: n[2], y1: n[3] };
}

/** Sign one print-queue directory; returns what to report. An entry marked `sign: false` is left alone. */
export function signDirectory(target: string, run: SignRun): string {
  // Older folders (before finalize) plot render.svg and record no edition or build.
  const file = join(target, existsSync(join(target, 'plot-ready.svg')) ? 'plot-ready.svg' : 'render.svg');
  const index = readFileSync(join(target, 'index.md'), 'utf8');
  if (frontmatter(index, 'sign') === 'false') return `skipped ${target}: sign: false in index.md (this ply is not signed)`;
  const [edition, build, created] = ['edition', 'build', 'created'].map(k => frontmatter(index, k));
  if (!existsSync(file) || !created) throw new Error('needs plot-ready.svg or render.svg, and created in index.md');
  const line = run.text ?? [run.handle, edition, build, created].filter(Boolean).join('  ');
  const before = readFileSync(file, 'utf8');
  const recorded = frontmatter(index, 'sign_box');
  const { svg, note } = signSvg(before, line, {
    pen: run.pen ?? frontmatter(index, 'sign_pen'),
    box: run.box ?? (recorded ? parseBox(recorded) : undefined),
    // plotter-server rejects a changed layer count, so a configured entry takes no new layer.
    newLayer: !existsSync(join(target, 'config.json')),
  });
  const [oldSha, newSha] = [sha256(before), sha256(svg)];
  // Every record of the prepared file's hash (index.md, config.json, finalize-report.json) follows it.
  const records = readdirSync(target).filter(f => /\.(md|json)$/.test(f) && readFileSync(join(target, f), 'utf8').includes(oldSha));
  const report = `${run.dry ? 'would sign' : 'signed'} ${target}  "${line}"  ${note}  (${records.length} hash records)`;
  if (run.dry) return report;
  writeFileSync(file, svg);
  if (!records.includes('index.md')) records.push('index.md');
  for (const f of records) {
    let body = readFileSync(join(target, f), 'utf8').replaceAll(oldSha, newSha);
    if (f === 'index.md') body = withSignature(body, line);
    writeFileSync(join(target, f), body);
  }
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const take = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const text = take('--text');
  const handle = take('--handle') ?? '@algonormative';
  const pen = take('--pen');
  const boxArg = take('--box');
  const dry = args.includes('--dry');
  const targets = args.filter(a => a !== '--dry');
  if (!targets.length) { console.error('usage: npm run sign -- [--dry] [--handle @name] [--pen <id>] [--box x0,y0,x1,y1] (<print-queue-dir>... | --text "<line>" <file.svg>...)'); process.exit(2); }

  let failed = 0;
  for (const target of targets) {
    try {
      const run: SignRun = { text, handle, dry, pen, ...(boxArg ? { box: parseBox(boxArg) } : {}) };
      if (statSync(target).isDirectory()) {
        console.log(signDirectory(target, run));
      } else {
        if (!text) throw new Error('loose files need --text');
        const { svg, note } = signSvg(readFileSync(target, 'utf8'), text, { pen: run.pen, box: run.box });
        console.log(`${dry ? 'would sign' : 'signed'} ${target}  ${note}`);
        if (!dry) writeFileSync(target, svg);
      }
    } catch (err) {
      failed++;
      console.error(`FAIL ${target}: ${(err as Error).message}`);
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
