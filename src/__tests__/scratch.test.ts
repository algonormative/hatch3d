import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import type { Part, SketchContext } from '../sketch/types.ts';
import { renderDepthBufferCPU, densifyProjectedPolyline } from '../sketch/depth-buffer.ts';
import { projectPolylinesClipped } from '../projection.ts';
import { splitPolylineByDepth } from '../occlusion.ts';
import { scratchRandom, scratchRun } from '../../sketches/phase-garden/scratch.ts';
import { towerScene } from '../../sketches/breach-cathedral-tower/geometry.ts';

function context(seed: number, params: SketchContext['params'] = {}): SketchContext {
  return { params, seed, assets: {}, random: (id: string) => {
    let h = (seed * 2654435761) >>> 0;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 2 ** 32; };
  } };
}

const art = (parts: Part[]) => parts.filter(p => !p.id.startsWith('slogan-') && !p.id.startsWith('title-'));

describe('Line scratch', () => {
  it('never draws where the depth pass hides geometry, even when an end overshoots into an occluder', () => {
    // A wall in front of the right half of a line on the ground plane.
    const view = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50);
    view.position.set(0, 0, 20); view.lookAt(0, 0, 0); view.updateProjectionMatrix(); view.updateMatrixWorld();
    const wall = new THREE.BoxGeometry(4, 4, 1); wall.translate(2.5, 0, 1);
    const depth = renderDepthBufferCPU([wall], view, 200, 200);
    const env = { depth, bias: 0.0014, mmPerPx: 0.25 };
    const visibleAt = (p: { x: number; y: number; depth: number }) => splitPolylineByDepth([p, p], depth, 0.0014).visible.length > 0;
    let checked = 0;
    for (let k = 0; k < 40; k++) {
      // Lines ending (naturally) just short of the wall, and lines running under it.
      const y = -1.8 + k * 0.09;
      const strokes = [[new THREE.Vector3(-4, y, 0), new THREE.Vector3(0.45, y, 0)], [new THREE.Vector3(-4, y + 0.04, 0), new THREE.Vector3(4, y + 0.04, 0)]];
      const projected = projectPolylinesClipped(strokes, view, 200, 200).polylines;
      projected.forEach((line, i) => {
        const dense = densifyProjectedPolyline(line);
        for (const run of splitPolylineByDepth(dense, depth, 0.0014).visible) {
          const natural: [boolean, boolean] = [Math.hypot(run[0].x - line[0].x, run[0].y - line[0].y) < 0.5,
            Math.hypot(run.at(-1)!.x - line.at(-1)!.x, run.at(-1)!.y - line.at(-1)!.y) < 0.5];
          for (const family of ['edge', 'hatch', 'membrane'] as const) {
            for (const piece of scratchRun(run, family, 1, scratchRandom(k, family, i), natural, env)) {
              for (const p of densifyProjectedPolyline(piece)) { expect(visibleAt(p)).toBe(true); checked++; }
            }
          }
        }
      });
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('is deterministic, leaves lineRough 0 byte-identical, and adds only marks near visible lines', () => {
    const clean = towerScene(context(211));
    expect(towerScene(context(211, { lineRough: 0 })).parts).toEqual(clean.parts);
    const rough = towerScene(context(211, { lineRough: 1 }));
    expect(towerScene(context(211, { lineRough: 1 })).parts).toEqual(rough.parts);
    expect(rough.parts).not.toEqual(clean.parts);
    // Every scratched mark lies within 2 mm (the longest overshoot plus a re-strike) of clean visible ink:
    // nothing hidden by the depth pass reappears elsewhere.
    const cells = new Set<string>();
    for (const part of art(clean.parts)) for (const path of part.paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
      for (let k = 0; k <= n; k++) cells.add(`${Math.floor((a.x + (b.x - a.x) * k / n) / 2)},${Math.floor((a.y + (b.y - a.y) * k / n) / 2)}`);
    }
    const near = (x: number, y: number) => {
      const cx = Math.floor(x / 2), cy = Math.floor(y / 2);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (cells.has(`${cx + dx},${cy + dy}`)) return true;
      return false;
    };
    for (const part of art(rough.parts)) for (const path of part.paths) for (const p of path) expect(near(p.x, p.y)).toBe(true);
  });

  it('leaves the finishing border untouched and keeps the stack piece within the path budget', async () => {
    const entry = resolve('sketches/breach-cathedral-extended/sketch.ts');
    const finishing = { border: { style: 'double' as const, pen: 'carbon', inset: 12, contentGap: 6 } };
    // The densest stack piece, c033, with the lettering on.
    const params = { posterMode: 'abstract', mass: 0.9, rupture: 0.67, growth: 0.48, focusX: 0.63, focusY: 0.72, levels: 11, cantilever: 0.73,
      breach: 0.82, hatchDensity: 0.88, shellWidth: 2.5, shellTwist: 0.55, interruption: 0.5, worldX: 0.3, worldY: -0.7, worldZ: -0.2,
      occlusion: true, fullHeight: true, fitWhole: true, sloganCount: 1, sloganRough: 0.85, titleEnabled: true, titleRough: 0.65 };
    const plain = await renderSketch({ entry, seed: 613, params, finishing });
    const scratched = await renderSketch({ entry, seed: 613, params: { ...params, lineRough: 1 }, finishing });
    const border = (r: typeof plain) => r.parts.filter(p => p.id.startsWith('finishing'));
    expect(border(plain).length).toBeGreaterThan(0);
    expect(border(scratched)).toEqual(border(plain));
    expect(scratched.diagnostics).toEqual([]);
    expect(scratched.stats.pathCount).toBeLessThanOrEqual(8000);
  }, 60_000);
});
