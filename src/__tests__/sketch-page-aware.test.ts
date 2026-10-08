import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { main as sketchCli, pageShorthand } from '../../cli/sketch.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';

const targetModule = resolve(import.meta.dirname, '../sketch/render-target.ts');
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

/**
 * A sketch that draws its page's inner diagonal from `ctx.page`, plus a sibling module that lays itself out on
 * load from the render target (adopting it when the page is not its default), like a format module does.
 */
async function fixture(pageAware: boolean): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'hatch3d-page-aware-'));
  await writeFile(join(dir, 'layout.ts'), `import { adoptRenderTarget, renderTarget } from ${JSON.stringify(targetModule)};
    const requested = renderTarget().page;
    export const WIDTH = requested?.width ?? 100;
    if (WIDTH !== 100) adoptRenderTarget();`);
  const path = join(dir, `${pageAware ? 'aware' : 'legacy'}.ts`);
  await writeFile(path, `import { WIDTH } from './layout.ts';
    export default {
      name: 'page', page: { width: 100, height: 160, margin: 10, paper: '#ffffff' }, ${pageAware ? 'pageAware: true,' : ''}
      pens: [{ id: 'ink', color: '#111111', width: 0.3 }], controls: [],
      draw(ctx) {
        const page = ctx.page, m = page.margin ?? 0;
        return [{ id: 'diagonal', pen: 'ink', paths: [[{ x: m, y: m }, { x: page.width - m, y: page.height - m }]] },
          { id: 'layout', pen: 'ink', paths: [[{ x: m, y: m }, { x: m + WIDTH / 10, y: m }]] }];
      },
    };`);
  return path;
}

describe('page-aware sketches', () => {
  it('derives the target page: requested size, given or proportional margin, declared paper', () => {
    const declared = { width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' };
    expect(targetPage(declared)).toBe(declared);
    expect(targetPage(declared, { width: 70, height: 120 })).toEqual({ width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' });
    expect(targetPage(declared, { width: 70, height: 120, margin: 3, paper: '#fff' })).toEqual({ width: 70, height: 120, margin: 3, paper: '#fff' });
    expect(targetPage(declared, { width: 279.4, height: 431.8 })).toEqual(declared);
  });

  it('parses --page WxH[,margin] into finishing.page, keeping the rest of finishing', () => {
    expect(pageShorthand('70x120', undefined)).toEqual({ page: { width: 70, height: 120 } });
    expect(pageShorthand('70x120,4.5', { border: { style: 'simple', pen: 'ink' }, page: { width: 1, height: 1, paper: '#fff' } }))
      .toEqual({ border: { style: 'simple', pen: 'ink' }, page: { width: 70, height: 120, margin: 4.5, paper: '#fff' } });
    expect(() => pageShorthand('70 by 120', undefined)).toThrow(/--page/);
  });

  it('a render with --page 70x120 draws on a 70 x 120 mm ctx.page, without a rescale', async () => {
    const entry = await fixture(true);
    const out = join(dir!, 'out');
    const log = console.log;
    console.log = () => {};
    try { await sketchCli(['render', entry, '--page', '70x120', '--out', out]); } finally { console.log = log; }
    const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')) as RenderResult;
    // Margin 10 on a 100 x 160 page scales by min(0.7, 0.75) to 7.
    expect(result.metadata.page).toEqual({ width: 70, height: 120, margin: 7, paper: '#ffffff' });
    expect(result.metadata.sourcePage).toEqual({ width: 100, height: 160, margin: 10, paper: '#ffffff' });
    expect(result.finishing).toEqual({ page: { width: 70, height: 120 } });
    expect(result.parts.find(part => part.id === 'diagonal')!.paths[0]).toEqual([{ x: 7, y: 7 }, { x: 63, y: 113 }]);
    // The layout module saw the requested page while loading.
    expect(result.parts.find(part => part.id === 'layout')!.paths[0]).toEqual([{ x: 7, y: 7 }, { x: 14, y: 7 }]);
  });

  it('at its own page, through finishing, a page-aware render matches the legacy one exactly', async () => {
    const aware = await fixture(true);
    const legacy = await fixture(false);
    const finishing = { page: { width: 100, height: 160, margin: 10, paper: '#f4ede0' }, border: { style: 'double' as const, pen: 'ink', inset: 4, contentGap: 2 } };
    const [a, b] = await Promise.all([renderSketch({ entry: aware, seed: 3, finishing }), renderSketch({ entry: legacy, seed: 3, finishing })]);
    expect(a.svg).toBe(b.svg);
    expect(a.parts).toEqual(b.parts);
    expect(a.metadata).toEqual(b.metadata);
    expect(a.identity).toBe(b.identity);
    const [plainA, plainB] = await Promise.all([renderSketch({ entry: aware, seed: 3 }), renderSketch({ entry: legacy, seed: 3 })]);
    expect(plainA.svg).toBe(plainB.svg);
  });

  it('a sketch that is not page-aware keeps its page and is fitted, even when a module it loads adopted the target', async () => {
    const legacy = await fixture(false);
    const result = await renderSketch({ entry: legacy, finishing: { page: { width: 50, height: 80 } } });
    // Drawn on 100 x 160 with the layout at its default width (a 10 mm stroke), then fitted by a uniform 0.375
    // into the inherited 10 mm margin.
    expect(result.metadata.page).toEqual({ width: 50, height: 80, margin: 10, paper: '#ffffff' });
    expect(result.parts.find(part => part.id === 'layout')!.paths[0]).toEqual([{ x: 10, y: 13.75 }, { x: 13.75, y: 13.75 }]);
  });

  it('records format options in the result and identity only when given', async () => {
    const entry = await fixture(true);
    const [plain, formatted] = await Promise.all([renderSketch({ entry }), renderSketch({ entry, format: { fit: 'width' } })]);
    expect(plain.format).toBeUndefined();
    expect(formatted.format).toEqual({ fit: 'width' });
    expect(formatted.svg).toBe(plain.svg);
    expect(formatted.identity).not.toBe(plain.identity);
    await expect(renderSketch({ entry, format: { fit: { nested: true } } as never })).rejects.toThrow(/Format option fit/);
  });
});
