import { Resvg } from '@resvg/resvg-js';
import type { RenderResult } from '../../src/sketch/types.ts';

export const PNG_SCALES = [1, 2, 3, 4, 6, 8] as const;
export const DEFAULT_PNG_SCALE = 6;
export type PngTheme = 'paper' | 'light' | 'dark';
const MAX_PNG_PIXELS = 32_000_000;

function darkPreviewInk(color: string): string {
  if (color.toLowerCase() === 'black') return '#e8e6e1';
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const channels = hex.length === 3 ? [...hex].map(char => parseInt(char + char, 16)) : [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16));
  return channels[0] === channels[1] && channels[1] === channels[2] && channels[0] <= 0x44 ? '#e8e6e1' : color;
}

export function pngOptions(theme: unknown = 'paper', scale: unknown = DEFAULT_PNG_SCALE): { theme: PngTheme; scale: number } {
  if (theme !== 'paper' && theme !== 'light' && theme !== 'dark') throw new Error('PNG theme must be paper, light, or dark');
  const number = typeof scale === 'string' && /^(1|2|3|4|6|8)$/.test(scale) ? Number(scale) : scale;
  if (typeof number !== 'number' || !PNG_SCALES.includes(number as typeof PNG_SCALES[number])) throw new Error('PNG scale must be 1, 2, 3, 4, 6, or 8 pixels per millimeter');
  return { theme, scale: number };
}

/** Presentation only: the canonical SVG and its physical ink colors stay untouched. */
export function exportSketchPng(result: RenderResult, theme: PngTheme = 'paper', scale = DEFAULT_PNG_SCALE): Buffer {
  const selected = pngOptions(theme, scale);
  const page = result.metadata.page;
  const width = Math.ceil(page.width * selected.scale);
  const height = Math.ceil(page.height * selected.scale);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PNG_PIXELS) {
    throw new Error('PNG dimensions exceed the 32 million pixel limit');
  }
  let svg = result.svg;
  if (selected.theme === 'dark') {
    svg = svg.replace(/stroke="([^"]+)"/gi, (_full, color: string) => `stroke="${darkPreviewInk(color)}"`);
  }
  svg = svg.replace(/^<svg\b[^>]*>/, (root) => root
    .replace(/\bwidth="[^"]*"/, `width="${width}px"`)
    .replace(/\bheight="[^"]*"/, `height="${height}px"`));
  const background = selected.theme === 'paper' ? page.paper ?? '#ffffff' : selected.theme === 'light' ? '#ffffff' : '#2a2a2f';
  return Buffer.from(new Resvg(svg, { background }).render().asPng());
}
