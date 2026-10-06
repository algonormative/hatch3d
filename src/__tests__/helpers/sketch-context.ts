import type { SketchContext } from '../../sketch/types.ts';

/** A direct draw context with a seeded stream per part id (FNV-style hash into an LCG), for geometry-level audits. */
export function sketchContext(seed: number, params: SketchContext['params'] = {}): SketchContext {
  return { params, seed, assets: {}, random: (id: string) => {
    let h = (seed * 2654435761) >>> 0;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 2 ** 32; };
  } };
}
