import type { SketchMetadata, Part } from './types.js';
const quantize = (n: number): number => Math.round(n * 1000) / 1000;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number): string => String(quantize(n));
export function svgFor(metadata: SketchMetadata, parts: Part[]): string {
  const page = metadata.page;
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(page.width)}mm" height="${num(page.height)}mm" viewBox="0 0 ${num(page.width)} ${num(page.height)}">`];
  for (const [index, pen] of metadata.pens.entries()) {
    lines.push(`<g inkscape:groupmode="layer" inkscape:label="${index + 1}-${esc(pen.id)}" data-pen-id="${esc(pen.id)}" data-passes="${pen.passes ?? 1}" fill="none" stroke="${esc(pen.color)}" stroke-width="${num(pen.width)}" stroke-linecap="round" stroke-linejoin="round">`);
    for (const part of parts) {
      if (part.pen !== pen.id || part.diagnostic) continue;
      lines.push(`<g data-part-id="${esc(part.id)}">`);
      for (const path of part.paths) lines.push(`<path d="${path.map((p, i) => `${i ? 'L' : 'M'}${num(p.x)},${num(p.y)}`).join('')}"/>`);
      lines.push('</g>');
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

