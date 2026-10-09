/**
 * The vector side of the print export: a sketch's layered SVG as pen layers of strokes (mm, page space), and back
 * as SVG elements. Sketch SVGs use absolute `M`/`L` in millimetres, one `<g inkscape:groupmode="layer">` per pen
 * with `<g data-part-id>` groups inside (the grammar `cli/finalize.ts` reads), so that is all this reads.
 */
import type { Point } from '../../src/sketch/types.ts';

/** One drawn line: its points, the part it came from, its stroke width (mm), and whether the gap guard held it back. */
export interface Stroke { points: Point[]; part: string; width: number; capped?: boolean }
export interface PenLayer { label: string; penId: string; color: string; strokes: Stroke[] }
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** The runs of one `d` attribute. Only absolute `M` and `L` are read; anything else is an error, not a guess. */
export function parsePath(d: string): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (const m of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    if (m[1] !== 'M' && m[1] !== 'L') throw new Error(`print-export: path command ${m[1]} is not supported (sketch paths are absolute M/L)`);
    const n = (m[2].match(NUMBER) ?? []).map(Number);
    if (n.length === 0 || n.length % 2) throw new Error(`print-export: malformed path data "${m[0]}"`);
    for (let i = 0; i < n.length; i += 2) {
      if (m[1] === 'M' && i === 0) flush();
      run.push({ x: n[i], y: n[i + 1] });
    }
  }
  flush();
  return runs;
}

/** Pen layers of a sketch SVG, in paint order. */
export function parseLayers(svg: string): PenLayer[] {
  const layers: PenLayer[] = [];
  for (const chunk of svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const open = /^<g\b([^>]*)>/.exec(chunk)?.[1] ?? '';
    const attr = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(open)?.[1];
    const width = Number(attr('stroke-width'));
    if (!(width > 0)) throw new Error(`print-export: layer ${attr('inkscape:label')} has no stroke-width`);
    const strokes: Stroke[] = [];
    let part = '';
    for (const m of chunk.matchAll(/<g data-part-id="([^"]*)">|<path d="([^"]*)"\s*\/>/g)) {
      if (m[1] !== undefined) part = m[1];
      else for (const points of parsePath(m[2])) strokes.push({ points, part, width });
    }
    layers.push({ label: attr('inkscape:label') ?? '', penId: attr('data-pen-id') ?? '', color: attr('stroke') ?? '#000000', strokes });
  }
  return layers;
}

/** The page size a sketch SVG declares, in millimetres (its viewBox). */
export function svgPageMm(svg: string): { width: number; height: number } {
  const box = /<svg\b[^>]*\bviewBox="\s*0[ ,]+0[ ,]+([\d.]+)[ ,]+([\d.]+)\s*"/.exec(svg);
  if (!box) throw new Error('print-export: the sketch SVG has no 0 0 w h viewBox');
  return { width: Number(box[1]), height: Number(box[2]) };
}

/** The extent of a layer set's centrelines, optionally widened by each stroke's own half width. */
export function strokeBounds(layers: PenLayer[], options: { skip?: (layer: PenLayer) => boolean; widened?: boolean } = {}): Bounds | null {
  let b: Bounds | null = null;
  for (const layer of layers) {
    if (options.skip?.(layer)) continue;
    for (const s of layer.strokes) {
      const h = options.widened ? s.width / 2 : 0;
      for (const p of s.points) {
        b = b ? { x0: Math.min(b.x0, p.x - h), y0: Math.min(b.y0, p.y - h), x1: Math.max(b.x1, p.x + h), y1: Math.max(b.y1, p.y + h) } : { x0: p.x - h, y0: p.y - h, x1: p.x + h, y1: p.y + h };
      }
    }
  }
  return b;
}

/** A coordinate as the sketches write it: millimetres to a thousandth. */
export const mm = (v: number): string => String(Math.round(v * 1000) / 1000);

export const pathData = (points: readonly Point[]): string => `M${points.map(p => `${mm(p.x)},${mm(p.y)}`).join('L')}`;

/**
 * Pen layers as SVG elements in page millimetres: one group per layer in its ink, round caps and joins, and inside
 * it one group per stroke width (so a layer thickened with the gap guard stays compact).
 */
export function layersSvg(layers: readonly PenLayer[]): string {
  return layers.filter(l => l.strokes.length).map(layer => {
    const byWidth = new Map<number, string[]>();
    for (const s of layer.strokes) {
      if (s.points.length < 2) continue;
      const w = Math.round(s.width * 1000) / 1000;
      const list = byWidth.get(w) ?? [];
      list.push(`<path d="${pathData(s.points)}"/>`);
      byWidth.set(w, list);
    }
    const groups = [...byWidth].map(([w, paths]) => `<g stroke-width="${mm(w)}">${paths.join('')}</g>`).join('');
    return `<g fill="none" stroke="${layer.color}" stroke-linecap="round" stroke-linejoin="round" data-pen-id="${layer.penId}">${groups}</g>`;
  }).join('\n');
}

/**
 * The SVG document the rasterizer renders: `body` (page millimetres, origin at the trim's corner) placed `offsetMm`
 * in from the canvas corner, on a canvas of `canvasMm`, rendered at `widthPx` × `heightPx`.
 */
export function canvasSvg(body: string, canvasMm: { width: number; height: number }, offsetMm: number, widthPx: number, heightPx: number): string {
  const n = (v: number) => String(+v.toFixed(6));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${n(canvasMm.width)} ${n(canvasMm.height)}">`
    + `<g transform="translate(${n(offsetMm)} ${n(offsetMm)})">\n${body}\n</g></svg>`;
}
