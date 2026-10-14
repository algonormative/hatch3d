import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYER = (n: number, pen: string, stroke: string, width: string, body: string) =>
  `<g inkscape:groupmode="layer" inkscape:label="${n}-${pen}" data-pen-id="${pen}" data-passes="1" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</g>`;

/** A Breach-style prepared sheet: a 70 x 120 mm card with art in carbon, an (empty) lettering layer and the border. */
export const BREACH_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="70mm" height="120mm" viewBox="0 0 70 120">',
  LAYER(1, 'carbon', '#22282c', '0.25', '<path d="M10,12L60,12L60,100L10,100L10,12"/>\n<path d="M10,40L60,60"/>'),
  LAYER(6, 'lettering', '#22282c', '0.13', ''),
  LAYER(7, 'finishing-border', '#22282c', '0.25', '<path d="M4.5,4.5L65.5,4.5L65.5,115.5L4.5,115.5L4.5,4.5"/>'),
  '</svg>',
  '',
].join('\n');

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** A print-queue entry directory for the card: the prepared sheet, and the three records that carry its hash. */
export function writeBreachEntry(dir: string, options: { config?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const sha = sha256(BREACH_SVG);
  writeFileSync(join(dir, 'plot-ready.svg'), BREACH_SVG);
  writeFileSync(join(dir, 'index.md'), ['---', 'title: "Breach Tarot: Fixture"', 'created: 2026-10-07', 'status: prepped', 'edition: "v1"', 'build: abc1234', `prepared_sha256: ${sha}`, '---', '', '# Fixture', ''].join('\n'));
  if (options.config !== false) writeFileSync(join(dir, 'config.json'), JSON.stringify({ format: 'hatch3d-sketch-v1', preparation: { prepared_sha256: sha } }, null, 2));
  writeFileSync(join(dir, 'finalize-report.json'), JSON.stringify({ preparedSha256: sha }, null, 2));
  return sha;
}
