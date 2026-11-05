import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Build a sketch's lab into `out`: `worker.js` (the sketch and `runtime.ts`, bundled for the browser) and `index.html`
 * (the tuning page, titled with the sketch's name, starting at `seed`). Publish `index.html` with `worker.js` beside it.
 * `starts` is a JSON file of named sets to start from (see `docs/sketch-lab.md`), `brief` an HTML fragment shown on a tab of its own.
 */
export async function buildLab(options: { entry: string; out: string; title?: string; seed?: number; starts?: string; brief?: string }): Promise<{ page: string; worker: string; bytes: number }> {
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
  // In a <script>, a closing tag in the JSON would end it.
  const data = options.starts ? JSON.stringify(JSON.parse(await readFile(resolve(options.starts), 'utf8'))).replaceAll('</', '<\\/') : 'null';
  const fill: Record<string, string> = { TITLE: escapeHtml(options.title ?? sketch.name), SEED: String(options.seed ?? 0), ENTRY: JSON.stringify(relative(ROOT, entry)), DATA: data, BRIEF: options.brief ? await readFile(resolve(options.brief), 'utf8') : '' };
  const page = (await readFile(join(here, 'page.html'), 'utf8')).replace(/\{\{(TITLE|SEED|ENTRY|DATA|BRIEF)\}\}/g, (_, key: string) => fill[key]);
  const pagePath = join(out, 'index.html');
  await writeFile(pagePath, page);
  return { page: pagePath, worker, bytes };
}
