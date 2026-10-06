import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import type { Part, SketchContext } from '../sketch/types.ts';
import { renderDepthBufferCPU, densifyProjectedPolyline } from '../sketch/depth-buffer.ts';
import { projectPolylinesClipped } from '../projection.ts';
import { splitPolylineByDepth } from '../occlusion.ts';
import { letterScratchMargin, letterScratchSize, scratchLetterRun, scratchRandom, scratchRun } from '../../sketches/phase-garden/scratch.ts';
import { CATHEDRAL_CHARSET, strokeText } from '../sketch/stroke-text.ts';
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
    // Every scratched mark lies near clean visible ink: at most a dropped sub-0.5 mm visible fragment,
    // plus the longest overshoot (1.8 mm), a re-strike offset (0.3 mm) and wobble. Nothing hidden by
    // the depth pass reappears elsewhere.
    const segments = art(clean.parts).flatMap(p => p.paths).flatMap(path => path.slice(1).map((b, i) => [path[i], b] as const));
    const grid = new Map<string, (typeof segments)[number][]>();
    for (const seg of segments) {
      const [a, b] = seg;
      for (let gx = Math.floor(Math.min(a.x, b.x) / 4); gx <= Math.floor(Math.max(a.x, b.x) / 4); gx++)
        for (let gy = Math.floor(Math.min(a.y, b.y) / 4); gy <= Math.floor(Math.max(a.y, b.y) / 4); gy++) {
          const key = `${gx},${gy}`; if (!grid.has(key)) grid.set(key, []); grid.get(key)!.push(seg);
        }
    }
    const distance = (p: { x: number; y: number }) => {
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [a, b] of grid.get(`${Math.floor(p.x / 4) + dx},${Math.floor(p.y / 4) + dy}`) ?? []) {
        const vx = b.x - a.x, vy = b.y - a.y, l = vx * vx + vy * vy;
        const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l)) : 0;
        best = Math.min(best, Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy));
      }
      return best;
    };
    let worst = 0;
    for (const part of art(rough.parts)) for (const path of part.paths) for (const p of path) worst = Math.max(worst, distance(p));
    expect(worst).toBeLessThanOrEqual(2.8);
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

  describe('ruled lettering', () => {
    type P = { x: number; y: number; depth: number };
    const MM = 0.02; // a fine flat "pixel" for audits without a depth buffer
    const env = { bias: 0.0014, mmPerPx: MM };
    const toPx = (path: { x: number; y: number }[]): P[] => path.map(p => ({ x: p.x / MM, y: p.y / MM, depth: 0.5 }));
    const segDist = (p: { x: number; y: number }, a: P, b: P) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    const scratchGlyph = (char: string, cap: number, rough: number, seed: number) =>
      strokeText(char, 0, 0, { face: 'cathedral', height: cap }).map((path, i) =>
        ({ clean: toPx(path), marks: scratchLetterRun(toPx(path), rough, scratchRandom(seed, `glyph-${char}`, i), env, cap) }));

    it('is the slab-edge routine itself, scaled to the cap height', () => {
      for (let seed = 0; seed < 20; seed++) for (const cap of [2.2, 3]) {
        const run = toPx(strokeText('B', 0, 0, { face: 'cathedral', height: cap })[0]);
        expect(scratchLetterRun(run, 0.425, scratchRandom(seed, 'x', 0), env, cap))
          .toEqual(scratchRun(run, 'edge', 0.425, scratchRandom(seed, 'x', 0), [true, true], env, letterScratchSize(cap)));
      }
    });

    it('keeps at least 70% of every glyph inked and draws nothing beyond its own margin (no strays or tilts)', () => {
      let worst = 1;
      for (const rough of [0.375, 0.425, 1]) for (let seed = 0; seed < 8; seed++) for (const char of CATHEDRAL_CHARSET) {
        const strokes = scratchGlyph(char, 2.2, rough, seed);
        const marks = strokes.flatMap(s => s.marks).flatMap(m => m.slice(1).map((b, i) => [m[i], b] as const));
        const margin = letterScratchMargin(2.2, rough) / MM + 1e-6;
        const clean = strokes.flatMap(s => s.clean.slice(1).map((b, i) => [s.clean[i], b] as const));
        let inked = 0, total = 0;
        for (const [a, b] of clean) {
          const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(len / 2));
          for (let k = 0; k < n; k++) {
            const p = { x: a.x + (b.x - a.x) * (k + 0.5) / n, y: a.y + (b.y - a.y) * (k + 0.5) / n };
            total += len / n;
            if (marks.some(([m0, m1]) => segDist(p, m0, m1) < 0.06 / MM)) inked += len / n;
          }
        }
        if (total > 0) worst = Math.min(worst, inked / total);
        for (const [m0] of marks) expect(Math.min(...clean.map(([a, b]) => segDist(m0, a, b)))).toBeLessThanOrEqual(margin);
      }
      expect(worst).toBeGreaterThanOrEqual(0.7);
    });
  });
});
