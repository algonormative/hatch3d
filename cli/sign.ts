#!/usr/bin/env tsx
/**
 * Sign plot-ready SVGs: one small single-stroke line, "@algonormative  v1  234f812  2026-10-09",
 * in the bottom-right corner below the art, drawn as paths on the lettering pen so it plots
 * with the rest of the sheet. Re-signing replaces the previous signature.
 *
 *   npm run sign -- <print-queue-dir>...            edition, build and created from each index.md;
 *                                                   signs plot-ready.svg and rewrites its prepared_sha256
 *   npm run sign -- --text "<line>" <file.svg>...   sign loose files with a given line
 *
 * Options: --handle <name> (default @algonormative), --dry (report placement, write nothing).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureStrokeText, strokeText } from '../packages/plot-core/src/stroke-text.ts';

const LETTERING_LAYER = 'inkscape:groupmode="layer" inkscape:label="6-lettering" data-pen-id="lettering" data-passes="1" fill="none" stroke="#22282c" stroke-width="0.13" stroke-linecap="round" stroke-linejoin="round"';
const SIGNATURE = /\n?<g id="signature"[\s\S]*?<\/g><!--\/signature-->/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Extent of every path coordinate in the sheet (absolute M/L paths, as hatch3d and vpype emit). */
function artBounds(svg: string) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const n = m[1].match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
    for (let i = 0; i + 1 < n.length; i += 2) {
      x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]);
      y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]);
    }
  }
  return { x0, y0, x1, y1 };
}

/** Returns the signed SVG; throws when the sheet has no room below the art. */
export function signSvg(source: string, text: string): { svg: string; note: string } {
  let svg = source.replace(SIGNATURE, '');
  const view = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!view) throw new Error('no "0 0 W H" viewBox');
  const [W, H] = [Number(view[1]), Number(view[2])];
  const art = artBounds(svg);
  const gap = H - art.y1;
  // Cap height in mm: 0.7 on a pocket card, ~1.8 on an 11 x 17 sheet.
  const height = Math.min(1.1, Math.max(0.7, W / 250)) * (W > 100 ? 1.6 : 1);
  if (gap < height * 1.8) throw new Error(`only ${gap.toFixed(2)} mm below the art`);
  const style = { face: 'sans' as const, height };
  const x = art.x1 - measureStrokeText(text, style);
  const top = art.y1 + (gap - height) / 2;
  const d = strokeText(text, x, top, style)
    .map(p => 'M' + p.map(q => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join('L')).join('');
  const sig = `<g id="signature" data-signature="${text}"><path d="${d}"/></g><!--/signature-->`;
  const lettering = /(<g [^>]*inkscape:label="6-lettering"[^>]*>)/;
  svg = lettering.test(svg)
    ? svg.replace(lettering, `$1\n${sig}`)
    : svg.replace(/<\/svg>\s*$/, `<g ${LETTERING_LAYER}>\n${sig}</g>\n</svg>\n`);
  return { svg, note: `${W}x${H} mm, ${height.toFixed(2)} mm text at ${x.toFixed(1)},${top.toFixed(1)}` };
}

function frontmatter(md: string, key: string): string | undefined {
  return md.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1].trim();
}

function main() {
  const args = process.argv.slice(2);
  const take = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const text = take('--text');
  const handle = take('--handle') ?? '@algonormative';
  const dry = args.includes('--dry');
  const targets = args.filter(a => a !== '--dry');
  if (!targets.length) { console.error('usage: npm run sign -- [--dry] [--handle @name] (<print-queue-dir>... | --text "<line>" <file.svg>...)'); process.exit(2); }

  let failed = 0;
  for (const target of targets) {
    try {
      if (statSync(target).isDirectory()) {
        const file = join(target, 'plot-ready.svg');
        const index = readFileSync(join(target, 'index.md'), 'utf8');
        const [edition, build, created] = ['edition', 'build', 'created'].map(k => frontmatter(index, k));
        if (!existsSync(file) || !edition || !build || !created) throw new Error('needs plot-ready.svg and edition, build, created in index.md');
        const line = text ?? `${handle}  ${edition}  ${build}  ${created}`;
        const before = readFileSync(file, 'utf8');
        const { svg, note } = signSvg(before, line);
        const [oldSha, newSha] = [sha256(before), sha256(svg)];
        // Every record of the prepared file's hash (index.md, config.json, finalize-report.json) follows it.
        const records = readdirSync(target).filter(f => /\.(md|json)$/.test(f) && readFileSync(join(target, f), 'utf8').includes(oldSha));
        console.log(`${dry ? 'would sign' : 'signed'} ${target}  "${line}"  ${note}  (${records.length} hash records)`);
        if (dry) continue;
        writeFileSync(file, svg);
        for (const f of records) {
          let body = readFileSync(join(target, f), 'utf8').replaceAll(oldSha, newSha);
          if (f === 'index.md') body = /^signature:/m.test(body)
            ? body.replace(/^signature:.*$/m, `signature: "${line}"`)
            : body.replace(/^(prepared_sha256:.*)$/m, `$1\nsignature: "${line}"`);
          writeFileSync(join(target, f), body);
        }
      } else {
        if (!text) throw new Error('loose files need --text');
        const { svg, note } = signSvg(readFileSync(target, 'utf8'), text);
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

main();
