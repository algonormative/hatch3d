import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';

const entry = resolve('sketches/fault-choir/sketch.ts');

describe('Fault Choir composition', () => {
  it('replays exactly, varies its seeded composition, and gives every physical pen a voice', async () => {
    const first = await renderSketch({ entry, seed: 17 });
    const replay = await renderSketch({ entry, seed: 17 });
    const other = await renderSketch({ entry, seed: 73 });

    expect(replay.identity).toBe(first.identity);
    expect(replay.parts).toEqual(first.parts);
    expect(other.identity).not.toBe(first.identity);
    expect(other.parts).not.toEqual(first.parts);

    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pathCount).toBeGreaterThan(1500);
      expect(result.stats.pointCount).toBeLessThan(200_000);
      const byPen = new Map<string, number>();
      for (const part of result.parts) byPen.set(part.pen, (byPen.get(part.pen) ?? 0) + part.paths.length);
      for (const pen of result.metadata.pens) expect(byPen.get(pen.id)).toBeGreaterThan(80);
    }
  });
});
