import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Build a sketch's lab into `out`: `worker.js` (the sketch and `runtime.ts`, bundled for the browser) and `index.html`
 * (the tuning page, titled with the sketch's name, starting at `seed`). Publish `index.html` with `worker.js` beside it.
 */
export async function buildLab(options: { entry: string; out: string; title?: string; seed?: number }): Promise<{ page: string; worker: string; bytes: number }> {
  const entry = resolve(options.entry);
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const worker = join(out, 'worker.js');
  const contents = `import * as mod from ${JSON.stringify(pathToFileURL(entry).pathname)};\nimport { serveLab } from ${JSON.stringify(join(here, 'runtime.ts'))};\nserveLab(mod.default, mod.labSheets);\n`;
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'lab-entry.ts' },
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, outfile: worker, logLevel: 'silent', metafile: true,
  });
  const bytes = Object.values(result.metafile.outputs).reduce((t, o) => t + o.bytes, 0);
  const { default: sketch } = await import(pathToFileURL(entry).href) as { default: { name: string } };
  const page = (await readFile(join(here, 'page.html'), 'utf8')).replaceAll('{{TITLE}}', escapeHtml(options.title ?? sketch.name)).replaceAll('{{SEED}}', String(options.seed ?? 0));
  const pagePath = join(out, 'index.html');
  await writeFile(pagePath, page);
  return { page: pagePath, worker, bytes };
}
