import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { RenderResult } from '../../src/sketch/types.js';
import { renderSvgPng } from './export-png.js';
import { preparationSummary, svgSha256, type PreparedDerivative } from './preparation.js';

export interface SavedPin {
  pinId: string;
  pinnedAt: string;
  result: RenderResult;
  preparation?: ReturnType<typeof preparationSummary>;
}

const PIN_ID = /^\d{8}T\d{6}Z-[0-9a-f-]{36}$/;

/** The JSON manifest is written last. A pin only becomes visible when complete. */
export async function savePin(outputDir: string, result: RenderResult, derivative?: PreparedDerivative): Promise<SavedPin> {
  if (derivative && (derivative.sourceIdentity !== result.identity || derivative.sourceSha256 !== svgSha256(result.svg) ||
      derivative.preparedSha256 !== svgSha256(derivative.bytes))) throw new Error('Prepared pin does not match its canonical source');
  await mkdir(outputDir, { recursive: true });
  const pinnedAt = new Date().toISOString();
  const pinId = `${pinnedAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}-${randomUUID()}`;
  const directory = join(outputDir, pinId);
  await mkdir(directory); // Exclusive: never reuse a pin directory.
  const pin: SavedPin = { pinId, pinnedAt, result, ...(derivative ? { preparation: preparationSummary(derivative) } : {}) };
  try {
    const png = derivative
      ? renderSvgPng(derivative.bytes.toString('utf8'), result.metadata.page, 'paper', 6)
      : new Resvg(result.svg, { background: result.metadata.page.paper ?? '#ffffff', fitTo: { mode: 'width', value: 1600 } }).render().asPng();
    await writeFile(join(directory, 'art.svg'), result.svg, { flag: 'wx' });
    if (derivative) {
      await writeFile(join(directory, 'prepared.svg'), derivative.bytes, { flag: 'wx' });
      await writeFile(join(directory, 'preparation.json'), JSON.stringify(pin.preparation, null, 2), { flag: 'wx' });
    }
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
  const directory = join(outputDir, pinId);
  const pin = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as SavedPin;
  if (pin.pinId !== pinId || pin.result?.schemaVersion !== 1 || typeof pin.result.svg !== 'string') {
    throw new Error('Invalid pin manifest');
  }
  if (pin.preparation) {
    const [source, prepared, summary] = await Promise.all([
      readFile(join(directory, 'art.svg')),
      readFile(join(directory, 'prepared.svg')),
      readFile(join(directory, 'preparation.json'), 'utf8'),
    ]);
    if (source.toString('utf8') !== pin.result.svg || pin.preparation.sourceIdentity !== pin.result.identity ||
        svgSha256(source) !== pin.preparation.sourceSha256 || svgSha256(prepared) !== pin.preparation.preparedSha256 ||
        JSON.stringify(JSON.parse(summary)) !== JSON.stringify(pin.preparation)) {
      throw new Error('Prepared pin bytes do not match their source and preparation manifest');
    }
  }
  return pin;
}

export function pinFile(outputDir: string, pinId: string, kind: 'svg' | 'png'): string {
  if (!PIN_ID.test(pinId)) throw new Error('Invalid pin ID');
  return join(outputDir, pinId, kind === 'svg' ? 'art.svg' : 'preview.png');
}
