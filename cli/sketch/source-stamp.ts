import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SketchMetadata } from '../../src/sketch/types.js';
import { readBounded } from './checkpoint-external.js';

const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Hash the resolved static import graph, installed package bytes, project manifests and declared assets. */
export async function sourceStamp(entry: string, assets: SketchMetadata['assets']): Promise<string> {
  const absoluteEntry = await realpath(resolve(entry));
  const workingDir = dirname(absoluteEntry);
  const child = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './child.ts' : './child.js', import.meta.url));
  const { build } = await import('esbuild');
  const built = await build({ entryPoints: [absoluteEntry, child], absWorkingDir: workingDir, outdir: join(workingDir, '.source-stamp-unused'), bundle: true, write: false,
    metafile: true, platform: 'node', format: 'esm', conditions: ['node'], mainFields: ['main'], logLevel: 'silent' });
  const files = new Set(Object.keys(built.metafile.inputs).map(path => resolve(workingDir, path)));
  for (const asset of Object.values(assets)) files.add(resolve(workingDir, asset.path));
  for (const path of [...files]) {
    const marker = `${sep}node_modules${sep}`;
    const at = path.lastIndexOf(marker);
    if (at < 0) continue;
    const packageParts = path.slice(at + marker.length).split(sep);
    const count = packageParts[0]?.startsWith('@') ? 2 : 1;
    files.add(join(path.slice(0, at + marker.length), ...packageParts.slice(0, count), 'package.json'));
  }
  // The lock and manifest affect package resolution even when esbuild does not list them as inputs.
  for (let dir = workingDir;; dir = dirname(dir)) {
    try {
      if ((await lstat(join(dir, 'package.json'))).isFile()) {
        files.add(join(dir, 'package.json'));
        try { if ((await lstat(join(dir, 'package-lock.json'))).isFile()) files.add(join(dir, 'package-lock.json')); }
        catch { /* A local viewer may open a package without a lockfile. */ }
        break;
      }
    } catch { /* Keep looking for the nearest installed project root. */ }
    if (dirname(dir) === dir) break;
  }
  if (files.size > MAX_FILES) throw new Error('Sketch source closure exceeds 256 local files');
  let total = 0;
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error(`Unsupported or oversized sketch source: ${path}`);
    total += info.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Sketch source closure exceeds 32 MiB');
    const bytes = await readBounded(path, MAX_FILE_BYTES);
    if (bytes.length !== info.size || bytes.length > MAX_FILE_BYTES) throw new Error(`Sketch source changed while checking: ${path}`);
    hash.update(path).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}
