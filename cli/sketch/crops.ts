import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Part } from '../../src/sketch/types.ts';

type Point = { x: number; y: number };

export interface CropsOptions {
  /** PNG of the sheet. */
  image: string;
  page: { width: number; height: number; margin?: number };
  /** Named page points (mm) to crop around. */
  at: Record<string, Point>;
  /** Side of each square crop, mm. Default 40. */
  sizeMm?: number;
  /** Height of the whole-sheet thumbnail, px. Default 240. */
  thumbPx?: number;
  out: string;
  /** The PNG covers only the trim (page inset by margin), as `assembly preview` writes assembled.png. */
  trimmed?: boolean;
}

const CROP_PX = 600;

/** Area-averaged resample of the float source rectangle [x0,x1) x [y0,y1) into w x h; outside the source is white. */
function resample(src: PNG, x0: number, y0: number, x1: number, y1: number, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  const sw = (x1 - x0) / w;
  const sh = (y1 - y0) / h;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ax = x0 + i * sw;
      const ay = y0 + j * sh;
      const ix0 = Math.floor(ax);
      const iy0 = Math.floor(ay);
      const ix1 = Math.max(ix0, Math.ceil(ax + sw) - 1);
      const iy1 = Math.max(iy0, Math.ceil(ay + sh) - 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = iy0; y <= iy1; y++) {
        for (let x = ix0; x <= ix1; x++) {
          if (x >= 0 && y >= 0 && x < src.width && y < src.height) {
            const k = (y * src.width + x) * 4;
            const a = src.data[k + 3] / 255;
            r += src.data[k] * a + 255 * (1 - a);
            g += src.data[k + 1] * a + 255 * (1 - a);
            b += src.data[k + 2] * a + 255 * (1 - a);
          } else { r += 255; g += 255; b += 255; }
          n++;
        }
      }
      const o = (j * w + i) * 4;
      out.data[o] = Math.round(r / n); out.data[o + 1] = Math.round(g / n); out.data[o + 2] = Math.round(b / n); out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * The readability check: `thumb.png` (the sheet at viewing-distance scale) and `crop-<name>.png` (a square `sizeMm`
 * around each named page point, 600 px wide) written into `out`.
 */
export async function readabilityCrops(options: CropsOptions): Promise<{ thumb: string; crops: Record<string, string> }> {
  const { page, at, out } = options;
  const sizeMm = options.sizeMm ?? 40;
  const thumbPx = options.thumbPx ?? 240;
  if (!(sizeMm > 0) || !(thumbPx >= 1)) throw new Error('crops: sizeMm and thumbPx must be positive');
  const src = PNG.sync.read(await readFile(options.image));
  const margin = options.trimmed ? page.margin ?? 0 : 0;
  const coveredW = page.width - 2 * margin;
  const coveredH = page.height - 2 * margin;
  if (!(coveredW > 0) || !(coveredH > 0)) throw new Error('crops: page margin leaves no area');
  const pxPerMmX = src.width / coveredW;
  const pxPerMmY = src.height / coveredH;
  await mkdir(out, { recursive: true });

  const thumbW = Math.max(1, Math.round(thumbPx * src.width / src.height));
  const thumb = join(out, 'thumb.png');
  await writeFile(thumb, PNG.sync.write(resample(src, 0, 0, src.width, src.height, thumbW, Math.round(thumbPx))));

  const crops: Record<string, string> = {};
  for (const [name, p] of Object.entries(at)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`crops: unsafe point name "${name}"`);
    const x0 = (p.x - sizeMm / 2 - margin) * pxPerMmX;
    const x1 = (p.x + sizeMm / 2 - margin) * pxPerMmX;
    const y0 = (p.y - sizeMm / 2 - margin) * pxPerMmY;
    const y1 = (p.y + sizeMm / 2 - margin) * pxPerMmY;
    const file = join(out, `crop-${name}.png`);
    await writeFile(file, PNG.sync.write(resample(src, x0, y0, x1, y1, CROP_PX, CROP_PX)));
    crops[name] = file;
  }
  return { thumb, crops };
}

/** Landmarks from diagnostic parts named `landmark-<name>`: the first point of the first path. */
export function landmarksOf(parts: Part[]): Record<string, Point> {
  const found: Record<string, Point> = {};
  for (const part of parts) {
    if (!part.id.startsWith('landmark-')) continue;
    const at = part.paths[0]?.[0];
    if (at) found[part.id.slice('landmark-'.length)] = { x: at.x, y: at.y };
  }
  return found;
}
