import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { RenderResult } from '../../src/sketch/types.js';

export interface SavedPin {
  pinId: string;
  pinnedAt: string;
  result: RenderResult;
}

const PIN_ID = /^\d{8}T\d{6}Z-[0-9a-f-]{36}$/;

/** The JSON manifest is written last. A pin only becomes visible when complete. */
export async function savePin(outputDir: string, result: RenderResult): Promise<SavedPin> {
  await mkdir(outputDir, { recursive: true });
  const pinnedAt = new Date().toISOString();
  const pinId = `${pinnedAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}-${randomUUID()}`;
  const directory = join(outputDir, pinId);
  await mkdir(directory); // Exclusive: never reuse a pin directory.
  const pin = { pinId, pinnedAt, result };
  try {
    const png = new Resvg(result.svg, { background: result.metadata.page.paper ?? '#ffffff', fitTo: { mode: 'width', value: 1600 } }).render().asPng();
    await writeFile(join(directory, 'art.svg'), result.svg, { flag: 'wx' });
    await writeFile(join(directory, 'preview.png'), png, { flag: 'wx' });
    await writeFile(join(directory, 'result.json'), JSON.stringify(pin, null, 2), { flag: 'wx' });
    return pin;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function listPins(outputDir: string): Promise<SavedPin[]> {
  let names: string[];
  try { names = await readdir(outputDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const pins = await Promise.all(names.filter(name => PIN_ID.test(name)).map(async name => {
    try { return await loadPin(outputDir, name); }
    catch { return null; } // Ignore an incomplete pin still being written.
  }));
  return pins.filter((pin): pin is SavedPin => pin !== null).sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
}

export async function loadPin(outputDir: string, pinId: string): Promise<SavedPin> {
  if (!PIN_ID.test(pinId)) throw new Error('Invalid pin ID');
  const pin = JSON.parse(await readFile(join(outputDir, pinId, 'result.json'), 'utf8')) as SavedPin;
  if (pin.pinId !== pinId || pin.result?.schemaVersion !== 1 || typeof pin.result.svg !== 'string') {
    throw new Error('Invalid pin manifest');
  }
  return pin;
}

export function pinFile(outputDir: string, pinId: string, kind: 'svg' | 'png'): string {
  if (!PIN_ID.test(pinId)) throw new Error('Invalid pin ID');
  return join(outputDir, pinId, kind === 'svg' ? 'art.svg' : 'preview.png');
}
