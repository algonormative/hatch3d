/**
 * Review sheets for the steering loop: renders side by side, close-ups, and what changed between
 * two renders. PNG or JPEG in (diff: PNG), PNG out; nothing is re-rendered.
 *
 *   node --import tsx cli/sheet.ts montage <out.png> [--width 520] <label=render.png> ...
 *   node --import tsx cli/sheet.ts crop <in.png> <out.png> <x0> <y0> <x1> <y1> [--scale 3]
 *   node --import tsx cli/sheet.ts diff <before.png> <after.png> <out.png> [--threshold 40] [--regions 8]
 *
 * `crop` takes fractions of the image (0..1). `diff` finds where the two renders differ, groups the
 * changed pixels into regions, and lays each region out before | after, largest first; it prints the
 * changed pixel count and each region's box, and exits 1 when nothing changed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';

interface Image { id: string; href: string; width: number; height: number }
type Tile = { label: string; image: Image; view?: [number, number, number, number] };

let loaded = 0;
/** A JPEG's size, from its start-of-frame marker. */
export function jpegSize(bytes: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('sheet: no JPEG frame header found');
}

/**
 * A PNG or JPEG as an embeddable image. A PNG shown at `targetWidth` or less is first shrunk by a
 * whole factor with a box filter: the renderer's own downscale aliases fine hatching into moiré.
 * JPEGs are embedded as they are (there is no decoder here), so pass renders as PNG where possible.
 */
function load(path: string, targetWidth?: number): Image {
  const bytes = readFileSync(path);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const { width, height } = jpegSize(bytes);
    return { id: `img${loaded++}`, href: `data:image/jpeg;base64,${bytes.toString('base64')}`, width, height };
  }
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`sheet: ${path} is neither PNG nor JPEG`);
  const png = PNG.sync.read(bytes);
  const k = targetWidth ? Math.floor(png.width / targetWidth) : 1;
  if (k < 2) return { id: `img${loaded++}`, href: `data:image/png;base64,${bytes.toString('base64')}`, width: png.width, height: png.height };
  const w = Math.floor(png.width / k), h = Math.floor(png.height / k);
  const small = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sum = [0, 0, 0, 0];
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = ((y * k + dy) * png.width + (x * k + dx)) * 4;
      for (let c = 0; c < 4; c++) sum[c] += png.data[i + c];
    }
    for (let c = 0; c < 4; c++) small.data[(y * w + x) * 4 + c] = Math.round(sum[c] / (k * k));
  }
  // Keep the source's size so crop views stay in source pixels.
  return { id: `img${loaded++}`, href: `data:image/png;base64,${PNG.sync.write(small).toString('base64')}`, width: png.width, height: png.height };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderSvg(svg: string, out: string): void {
  writeFileSync(out, new Resvg(svg, { background: 'white' }).render().asPng());
}

/**
 * Rows of tiles, each tile scaled to `width` and labelled underneath; a tile may be a crop (`view`,
 * a source rectangle). Each image is embedded once and every tile refers to it, so a sheet of many
 * crops of one render stays small.
 */
export function sheetSvg(rows: Tile[][], width: number): string {
  const gap = 12, labelH = 40;
  const images = new Map<string, Image>();
  let y = gap, W = 0;
  const body = rows.map(tiles => {
    const sized = tiles.map(t => {
      images.set(t.image.id, t.image);
      const [vx, vy, vw, vh] = t.view ?? [0, 0, t.image.width, t.image.height];
      return { ...t, vx, vy, vw, vh, h: Math.round(vh * width / vw) };
    });
    W = Math.max(W, sized.length * (width + gap) + gap);
    const row = sized.map((t, i) => {
      const x = gap + i * (width + gap);
      return `<svg x="${x}" y="${y}" width="${width}" height="${t.h}" viewBox="${t.vx} ${t.vy} ${t.vw} ${t.vh}"><use href="#${t.image.id}"/></svg>`
        + `<text x="${x + 4}" y="${y + t.h + 28}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="black">${esc(t.label)}</text>`;
    }).join('');
    y += Math.max(...sized.map(t => t.h)) + labelH + gap;
    return row;
  }).join('');
  const defs = [...images.values()].map(im => `<image id="${im.id}" href="${im.href}" width="${im.width}" height="${im.height}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><defs>${defs}</defs><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
}

/** Changed regions between two same-size PNGs: boxes in pixels, largest first. */
export function changedRegions(before: Buffer, after: Buffer, threshold = 40, cell = 60): { changed: number; regions: { x0: number; y0: number; x1: number; y1: number; pixels: number }[] } {
  if (before.readUInt32BE(0) !== 0x89504e47 || after.readUInt32BE(0) !== 0x89504e47) throw new Error('sheet: diff compares PNG renders (render.png), not JPEGs');
  const a = PNG.sync.read(before), b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`sheet: sizes differ (${a.width}×${a.height} vs ${b.width}×${b.height})`);
  const cw = Math.ceil(a.width / cell), ch = Math.ceil(a.height / cell);
  const counts = new Uint32Array(cw * ch);
  let changed = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    const la = 0.3 * a.data[i] + 0.59 * a.data[i + 1] + 0.11 * a.data[i + 2];
    const lb = 0.3 * b.data[i] + 0.59 * b.data[i + 1] + 0.11 * b.data[i + 2];
    if (Math.abs(la - lb) > threshold) { changed++; counts[Math.floor(y / cell) * cw + Math.floor(x / cell)]++; }
  }
  // Group neighbouring cells with changes into regions.
  const seen = new Uint8Array(cw * ch);
  const regions: { x0: number; y0: number; x1: number; y1: number; pixels: number }[] = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pixels: 0 };
    while (stack.length) {
      const c = stack.pop()!, cx = c % cw, cy = Math.floor(c / cw);
      r.pixels += counts[c];
      r.x0 = Math.min(r.x0, cx * cell); r.y0 = Math.min(r.y0, cy * cell);
      r.x1 = Math.max(r.x1, Math.min(a.width, (cx + 1) * cell)); r.y1 = Math.max(r.y1, Math.min(a.height, (cy + 1) * cell));
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy, n = ny * cw + nx;
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && counts[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    regions.push(r);
  }
  regions.sort((p, q) => q.pixels - p.pixels);
  return { changed, regions };
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flag = (name: string, fallback: number) => { const i = rest.indexOf(name); return i >= 0 ? Number(rest[i + 1]) : fallback; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
  if (command === 'montage' && positional.length >= 2) {
    const [out, ...items] = positional;
    const tiles = items.map(item => { const at = item.indexOf('='); return { label: at > 0 ? item.slice(0, at) : item, image: load(at > 0 ? item.slice(at + 1) : item, flag('--width', 520)) }; });
    renderSvg(sheetSvg([tiles], flag('--width', 520)), out);
    return 0;
  }
  if (command === 'crop' && positional.length === 6) {
    const [input, out, ...f] = positional;
    const [x0, y0, x1, y1] = f.map(Number);
    const image = load(input);
    const view: [number, number, number, number] = [x0 * image.width, y0 * image.height, (x1 - x0) * image.width, (y1 - y0) * image.height];
    const scale = flag('--scale', 1);
    const w = Math.round(view[2] * scale), h = Math.round(view[3] * scale);
    renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${view.join(' ')}"><image href="${image.href}" width="${image.width}" height="${image.height}"/></svg>`, out);
    return 0;
  }
  if (command === 'diff' && positional.length === 3) {
    const [beforePath, afterPath, out] = positional;
    const { changed, regions } = changedRegions(readFileSync(beforePath), readFileSync(afterPath), flag('--threshold', 40));
    console.log(`changed px ${changed}; ${regions.length} region(s)`);
    if (!regions.length) return 1;
    const before = load(beforePath), after = load(afterPath);
    const pad = 40;
    const rows: Tile[][] = regions.slice(0, flag('--regions', 8)).map((r, i) => {
      const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad);
      const view: [number, number, number, number] = [x0, y0, Math.min(before.width, r.x1 + pad) - x0, Math.min(before.height, r.y1 + pad) - y0];
      console.log(`region ${i + 1}: x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1} px (${r.pixels} px changed)`);
      return [{ label: `${i + 1} before`, image: before, view }, { label: `${i + 1} after`, image: after, view }];
    });
    renderSvg(sheetSvg(rows, 420), out);
    return 0;
  }
  console.error('usage: node --import tsx cli/sheet.ts montage <out.png> [--width 520] <label=render.png> ... | crop <in.png> <out.png> <x0> <y0> <x1> <y1> [--scale 3] | diff <before.png> <after.png> <out.png> [--threshold 40] [--regions 8]');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exitCode = 2; }
}
