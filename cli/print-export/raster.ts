/**
 * The raster side of the print export: rasterize the lines at a supersample, lay them over the paper tint (with
 * optional grain on the tint only), average down to the print resolution, and write an sRGB PNG with its dpi.
 *
 * The lines are rendered alone, on a transparent canvas, at `supersample` times the print resolution. The tint
 * canvas is built at the print resolution. Each output pixel then averages the supersample's `n × n` subpixels of
 * "line over tint" in one integer step, in sRGB values as the renderer's own anti-aliasing is: a line's edge pixel is
 * its coverage of the ink over the paper. Grain therefore only ever shows where the paper does, and never over a
 * line; a pixel half covered by a line carries half the grain.
 */
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { noise2 } from './noise.ts';

export type RGB = readonly [number, number, number];

export const hexRgb = (hex: string): RGB => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`print-export: colour ${hex} must be #rrggbb`);
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};

export interface Raster { width: number; height: number; /** RGBA, premultiplied. */ premul: Uint8Array }

/** Render an SVG at its declared pixel size. Text is not used (lettering is strokes), so no fonts are loaded. */
export function rasterizeSvg(svg: string): Raster {
  const image = new Resvg(svg, { font: { loadSystemFonts: false }, shapeRendering: 2, fitTo: { mode: 'original' } }).render();
  return { width: image.width, height: image.height, premul: image.pixels };
}

/**
 * Paper grain on the tint: a seeded value noise, two octaves (`grainMm` and twice it), scaling the tint's tone by up
 * to `strength` either side (0.04 is 4% of the tone) with the hue kept. `strength` is asked at each point of the page
 * (millimetres from the trim's corner), so a chart can show several strengths on one sheet; a card gives a constant.
 */
export interface Grain { seed: number; grainMm: number; strength: (xMm: number, yMm: number) => number }

export interface CanvasSpec { widthPx: number; heightPx: number; ppi: number; bleedPx: number }

/** The tint canvas, RGB, at the print resolution. With no grain it is flat. */
export function tintCanvas(canvas: CanvasSpec, tint: RGB, grain?: Grain): Uint8Array {
  const { widthPx: w, heightPx: h } = canvas;
  const out = new Uint8Array(w * h * 3);
  const mmPerPx = 25.4 / canvas.ppi;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let f = 1;
      if (grain) {
        const xm = (x + 0.5 - canvas.bleedPx) * mmPerPx, ym = (y + 0.5 - canvas.bleedPx) * mmPerPx;
        const s = grain.strength(xm, ym);
        if (s > 0) {
          // Canvas-anchored lattice, so a card's grain does not shift with its trim size.
          const cx = (x + 0.5) * mmPerPx, cy = (y + 0.5) * mmPerPx;
          const n = 0.6 * noise2(grain.seed, cx, cy, grain.grainMm) + 0.4 * noise2(grain.seed + 1, cx, cy, grain.grainMm * 2);
          f = 1 + s * n;
        }
      }
      const i = (y * w + x) * 3;
      out[i] = Math.min(255, Math.max(0, Math.round(tint[0] * f)));
      out[i + 1] = Math.min(255, Math.max(0, Math.round(tint[1] * f)));
      out[i + 2] = Math.min(255, Math.max(0, Math.round(tint[2] * f)));
    }
  }
  return out;
}

/**
 * The supersampled lines over the tint, averaged down by `factor`: RGB at the tint canvas's size. Exact integer
 * arithmetic, so the same inputs give the same bytes.
 */
export function compositeDownsample(lines: Raster, tint: Uint8Array, widthPx: number, heightPx: number, factor: number): Uint8Array {
  if (lines.width !== widthPx * factor || lines.height !== heightPx * factor) {
    throw new Error(`print-export: the lines are ${lines.width} × ${lines.height} px, not ${factor} × ${widthPx} × ${heightPx}`);
  }
  const out = new Uint8Array(widthPx * heightPx * 3);
  const n = factor * factor, full = n * 255;
  const P = lines.premul;
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * lines.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, i += 4) { r += P[i]; g += P[i + 1]; b += P[i + 2]; a += P[i + 3]; }
      }
      const o = (y * widthPx + x) * 3, rest = full - a;
      out[o] = Math.round((r * 255 + tint[o] * rest) / full);
      out[o + 1] = Math.round((g * 255 + tint[o + 1] * rest) / full);
      out[o + 2] = Math.round((b * 255 + tint[o + 2] * rest) / full);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * A PNG of an RGB image: 8-bit truecolour, no alpha, tagged sRGB (rendering intent perceptual), with the print
 * resolution in a pHYs chunk (pixels per metre, so 300 ppi is 11811) as the printer's upload will read it.
 */
export function encodePng(rgb: Uint8Array, width: number, height: number, ppi: number): Buffer {
  const png = new PNG({ width, height });
  for (let p = 0, q = 0; p < width * height; p++) {
    png.data[q++] = rgb[p * 3]; png.data[q++] = rgb[p * 3 + 1]; png.data[q++] = rgb[p * 3 + 2]; png.data[q++] = 255;
  }
  const bytes = PNG.sync.write(png, { colorType: 2, inputHasAlpha: true });
  const phys = Buffer.alloc(9);
  const perMetre = Math.round(ppi / 0.0254);
  phys.writeUInt32BE(perMetre, 0); phys.writeUInt32BE(perMetre, 4); phys[8] = 1;
  // After the 8-byte signature and the 25-byte IHDR, before the image data.
  return Buffer.concat([bytes.subarray(0, 33), chunk('sRGB', Uint8Array.of(0)), chunk('pHYs', phys), bytes.subarray(33)]);
}

export interface PngInfo { width: number; height: number; colorType: number; ppi: number | null; srgb: boolean }

/** A PNG's size, colour type and the dpi and sRGB tags it carries. */
export function pngInfo(bytes: Buffer): PngInfo {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('print-export: not a PNG');
  const info: PngInfo = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25], ppi: null, srgb: false };
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'pHYs' && bytes[at + 16] === 1) info.ppi = Math.round(bytes.readUInt32BE(at + 8) * 0.0254);
    if (type === 'sRGB') info.srgb = true;
    if (type === 'IDAT') break;
    at += 12 + length;
  }
  return info;
}

/** The pixels of a PNG as RGB (alpha dropped), for the checks and a back image. */
export function readRgb(bytes: Buffer): { width: number; height: number; rgb: Uint8Array } {
  const png = PNG.sync.read(bytes);
  const rgb = new Uint8Array(png.width * png.height * 3);
  for (let p = 0; p < png.width * png.height; p++) { rgb[p * 3] = png.data[p * 4]; rgb[p * 3 + 1] = png.data[p * 4 + 1]; rgb[p * 3 + 2] = png.data[p * 4 + 2]; }
  return { width: png.width, height: png.height, rgb };
}
