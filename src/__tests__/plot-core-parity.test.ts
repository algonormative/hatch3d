import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSketch } from '../../cli/sketch/runner.ts';

interface Golden {
  name: string; entry: string; seed: number; params?: Record<string, string | number | boolean>;
  finishing?: { border: { style: 'double'; pen: string; inset: number; contentGap: number } };
  identity: string; svgSha256: string; svgBytes: number;
  parts: { id: string; pen: string; pathCount: number }[];
  stats: { pathCount: number; pointCount: number; lengthMm: number; partCount: number };
}
const goldens = JSON.parse(readFileSync(resolve('packages/plot-core/fixtures/legacy-renders.json'), 'utf8')) as Golden[];

describe('pre-extraction canonical render fixtures', () => {
  for (const golden of goldens) {
    it(`preserves ${golden.name} identity, SVG, part plan and statistics`, async () => {
      const result = await renderSketch({ entry: resolve(golden.entry), seed: golden.seed, params: golden.params, finishing: golden.finishing, timeoutMs: 120_000 });
      expect(result.identity).toBe(golden.identity);
      expect(createHash('sha256').update(result.svg).digest('hex')).toBe(golden.svgSha256);
      expect(Buffer.byteLength(result.svg)).toBe(golden.svgBytes);
      expect(result.parts.map((part) => ({ id: part.id, pen: part.pen, pathCount: part.paths.length }))).toEqual(golden.parts);
      expect(result.stats).toEqual(golden.stats);
    }, 120_000);
  }
});
