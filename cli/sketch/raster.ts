import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { PNG } from 'pngjs';
import type { AssetDeclaration, AssetMetadata, RasterAsset } from '../../src/sketch/types.ts';

function paperRgb(paper: string | undefined): [number, number, number] {
  const value = (paper ?? '#ffffff').toLowerCase();
  if (value === 'white') return [255, 255, 255];
  if (value === 'black') return [0, 0, 0];
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) return [...short[1]].map((c) => parseInt(c + c, 16)) as [number, number, number];
  const long = /^#([0-9a-f]{6})$/.exec(value);
  if (long) return [0, 2, 4].map((i) => parseInt(long[1].slice(i, i + 2), 16)) as [number, number, number];
  throw new Error(`Paper color must be white, black, #rgb, or #rrggbb for PNG assets: ${paper}`);
}

export async function loadRasterAssets(
  entry: string,
  declarations: Record<string, AssetDeclaration>,
  paper: string | undefined,
): Promise<{ assets: Record<string, RasterAsset>; metadata: Record<string, AssetMetadata> }> {
  const assets: Record<string, RasterAsset> = {};
  const metadata: Record<string, AssetMetadata> = {};
  const [pr, pg, pb] = paperRgb(paper);
  for (const [id, declaration] of Object.entries(declarations)) {
    const path = resolve(dirname(entry), declaration.path);
    if (!path.toLowerCase().endsWith('.png')) throw new Error(`Asset ${id} must be a PNG: ${declaration.path}`);
    const bytes = await readFile(path);
    const png = PNG.sync.read(bytes);
    const { width, height, data } = png;
    const brightness = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const j = i * 4;
      const a = data[j + 3] / 255;
      const r = data[j] * a + pr * (1 - a);
      const g = data[j + 1] * a + pg * (1 - a);
      const b = data[j + 2] * a + pb * (1 - a);
      brightness[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    const box = declaration.box;
    const scale = declaration.fit === 'contain'
      ? Math.min(box.width / width, box.height / height)
      : Math.max(box.width / width, box.height / height);
    const placedWidth = width * scale;
    const placedHeight = height * scale;
    const left = box.x + (box.width - placedWidth) / 2;
    const top = box.y + (box.height - placedHeight) / 2;
    const paperBrightness = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
    assets[id] = {
      width, height, brightness, box: { ...box }, fit: declaration.fit,
      sample(xMm, yMm) {
        if (xMm < box.x || yMm < box.y || xMm >= box.x + box.width || yMm >= box.y + box.height) return paperBrightness;
        const px = Math.floor((xMm - left) / scale);
        const py = Math.floor((yMm - top) / scale);
        if (px < 0 || py < 0 || px >= width || py >= height) return paperBrightness;
        return brightness[py * width + px];
      },
    };
    metadata[id] = { ...declaration, box: { ...box }, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height };
  }
  return { assets, metadata };
}
