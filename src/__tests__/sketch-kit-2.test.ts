import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bandHatch, bandMarks, bandOutlines, circlePath, discHatch, hatchedBar, hatchedDisc, sideOf } from '../../sketches/kit/fills.ts';
import { alongRay, collapseBand, helixStrands, narrowStrands, ribbonEdges, ribbonMidline, ribbonWidths, strandPoint, strandStrokes, towerFrame } from '../../sketches/kit/helix.ts';
import {
  glyphMask, groundWord, onWordBox, planSloganAttempts, rigidWords, type SloganEnv,
} from '../../sketches/kit/lettering.ts';
import { densityPitch, facetStrokes, faceDarkness, pageExtent, rakingLight, slabGeometry, slabMatrix, slabStrokes, sliverShade, solid } from '../../sketches/kit/slabs.ts';
import { horizonCamera, oversampledView, pageOf, tabloidFrameCamera } from '../../sketches/kit/perspective.ts';
import { TABLOID_HORIZON_Y, TABLOID_RASTER } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { thinParallel } from '../../sketches/kit/density.ts';
import { Clearance, reduceAtScale, segDist, simplify, straightened } from '../../sketches/kit/page.ts';
import { PartBuckets, fineDepth } from '../../sketches/kit/strokes.ts';
import { renderDepthBufferCPU } from '../sketch/depth-buffer.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const page = { width: 279.4, height: 431.8 };

describe('sketch kit: slabs', () => {
  it('places a slab by its position and rotation', () => {
    const s = solid(2, 3, 4, 2, 1, 0.5, 0, 'stack');
    const m = slabMatrix(s);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([2, 3, 4]);
    // Turned a quarter about z, its long side stands up: the box is 1 wide and 2 tall.
    const turned = { ...s, rz: Math.PI / 2 };
    const box = new THREE.Box3().setFromBufferAttribute(slabGeometry(turned).getAttribute('position') as THREE.BufferAttribute);
    expect(box.max.x - box.min.x).toBeCloseTo(1, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(2, 6);
    expect((box.max.x + box.min.x) / 2).toBeCloseTo(2, 6);
    expect((box.max.y + box.min.y) / 2).toBeCloseTo(3, 6);
  });

  it('draws the cathedral hatch: six carbon outline strokes first, denser with density', () => {
    const s = solid(0, 0, 0, 3, 1, 1, 0, 'stack');
    const sparse = slabStrokes(s, 0.1, false), dense = slabStrokes(s, 1, false);
    expect(dense.length).toBeGreaterThan(sparse.length);
    expect(dense.slice(0, 6).every(st => st.ink === 'carbon')).toBe(true);
    expect(dense.every(st => st.group === 'tower')).toBe(true);
    expect(slabStrokes({ ...s, role: 'debris' }, 1, false).every(st => st.group === 'collapse')).toBe(true);
    expect(densityPitch(0, 0.12, 0.044, 0.032)).toBe(0.12);
    expect(densityPitch(0.55, 0.12, 0.044, 0.032)).toBeCloseTo(0.044, 12);
    expect(densityPitch(1, 0.12, 0.044, 0.032)).toBeCloseTo(0.032, 12);
  });

  it('gives darker faces more contour rings', () => {
    const s = solid(0, 0, 0, 3, 1.4, 1, 0, 'stack');
    const eye = new THREE.Vector3(0, 0, 20);
    const rings = (light: THREE.Vector3) => facetStrokes(s, light, eye, false).filter(st => st.family === 'hatch' && st.points.length === 5).length;
    const lit = rings(new THREE.Vector3(0, 0, 1)), dark = rings(new THREE.Vector3(0, 0, -1));
    expect(dark).toBeGreaterThan(lit);
    expect(faceDarkness(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), 1))
      .toBeGreaterThan(faceDarkness(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), 1));
    // Outline only: twelve edges' worth of strokes, nothing else; and faces turned away draw nothing.
    expect(facetStrokes(s, new THREE.Vector3(0, 0, -1), eye, true).every(st => st.family === 'edge')).toBe(true);
    expect(facetStrokes(s, new THREE.Vector3(0, 0, -1), eye, false).filter(st => st.family === 'hatch').every(st => st.points.every(p => p.z > 0))).toBe(true);
  });

  it('leaves a slab untrimmed at tabloid, whatever trim a card asks for small cards, and measures it on the page', () => {
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 300 });
    const thin = solid(3, 4, -40, 6, 0.02, 4, 0, 'stack');
    thin.ry = 0.6;
    const light = new THREE.Vector3(0, 1, 0);
    for (const outline of [false, true]) {
      expect(facetStrokes(thin, light, view.position, outline, undefined, { view, shade: true })).toEqual(facetStrokes(thin, light, view.position, outline));
      expect(facetStrokes(thin, light, view.position, outline, undefined, { view, hidden: false })).toEqual(facetStrokes(thin, light, view.position, outline));
    }
    expect(sliverShade(thin, view, light)).toEqual([]);
    // Its box on the page: centred about its centre's projection, its 6 x 4 footprint turned 0.6 rad spanning about
    // 7.2 units across, at 10.6 mm a unit 40 units out.
    const extent = pageExtent(view, thin), centre = pageOf(view, new THREE.Vector3(3, 4, -40));
    expect(extent.x).toBeCloseTo(centre.x, 0);
    expect(extent.y).toBeCloseTo(centre.y, 0);
    expect(extent.size).toBeGreaterThan(72);
    expect(extent.size).toBeLessThan(80);
  });

  it('lowers the raking light as the angle control falls', () => {
    const grazing = rakingLight(sketchContext(1, { lightAngle: 0 })), high = rakingLight(sketchContext(1, { lightAngle: 1 }));
    expect(grazing.length()).toBeCloseTo(1, 6);
    expect(high.y).toBeGreaterThan(grazing.y);
  });
});

describe('sketch kit: helix', () => {
  it('seeds two strands and honours the frame it is given', () => {
    const ctx = sketchContext(7);
    const [a, b] = helixStrands(ctx);
    expect([a.id, b.id]).toEqual(['a', 'b']);
    expect(helixStrands(ctx)).toEqual([a, b]);
    const frame = { centre: 2, intensity: 0, bot: 0, top: 10 };
    const [fa] = helixStrands(ctx, frame);
    expect(fa.centre).toBe(2);
    expect(fa.swell).toBeCloseTo(0.35, 12);
    expect(fa.y0).toBeGreaterThanOrEqual(-0.6);
    expect(fa.y0).toBeLessThanOrEqual(1.2);
    // The default frame is the tower's own breach band.
    const band = collapseBand(ctx);
    expect(towerFrame(ctx)).toMatchObject({ centre: band.centre, intensity: band.intensity });
    expect(a.centre).toBe(band.centre);
  });

  it('starts and ends the strand on its y0 and y1, on its radius from the axis', () => {
    const [s] = helixStrands(sketchContext(3));
    const start = strandPoint(s, 0, 0), end = strandPoint(s, 1, 0);
    expect(start.y).toBeCloseTo(s.y + s.y0, 9);
    expect(end.y).toBeCloseTo(s.y + s.y1, 9);
    // The width runs off the axis, so the spine (v = 0) is farther out than the edge at the tapered ends.
    for (const p of [start, end]) expect(Math.hypot(p.x - s.x, (p.z - s.z - 0.25) / s.depth)).toBeGreaterThan(s.radius * 0.7);
    // Width at the middle exceeds the width at the tapered end.
    const span = (t: number) => strandPoint(s, t, 1).distanceTo(strandPoint(s, t, -1));
    expect(span(0.5)).toBeGreaterThan(span(0.001));
  });

  it('stands a strand along a ray', () => {
    const turn = alongRay(new THREE.Vector3(1, 2, 3), Math.PI / 3);
    const up = new THREE.Vector3(0, 10, 0).applyMatrix4(turn).sub(new THREE.Vector3(1, 2, 3));
    expect(up.x).toBeCloseTo(10 * Math.cos(Math.PI / 3), 9);
    expect(up.y).toBeCloseTo(10 * Math.sin(Math.PI / 3), 9);
    expect(up.z).toBeCloseTo(0, 9);
  });
});

describe('sketch kit: lettering', () => {
  it('keeps a hairline clear of glyph strokes', () => {
    const mask = glyphMask([[{ x: 50, y: 50 }, { x: 70, y: 50 }]], 0.8);
    expect(mask({ x: 60, y: 50 })).toBe(true);
    expect(mask({ x: 60, y: 50.6 })).toBe(true);
    expect(mask({ x: 60, y: 51.2 })).toBe(false);
    expect(mask({ x: 49, y: 50 })).toBe(false);
    expect(mask({ x: -5, y: 50 })).toBe(false);
    expect(glyphMask([], 1)({ x: 1, y: 1 })).toBe(false);
  });

  it('moves each word as one rigid piece and keeps it within its limits', () => {
    const word = (x: number, key: string) => [{ key, path: [{ x, y: 100 }, { x: x + 3, y: 100 }, { x: x + 3, y: 104 }] }];
    // Two strokes a word-space apart cluster; a far one stays its own word.
    const items = [...word(100, 'a'), ...word(105, 'a'), ...word(200, 'b')];
    const shift = (p: { x: number; y: number }) => ({ x: p.x + 10, y: p.y });
    const limits = { x0: 0, x1: 215, y0: 0, y1: 300 };
    const { words, boxes } = rigidWords(items, shift, limits);
    expect(boxes.length).toBe(2);
    expect(words.length).toBe(3);
    // Rigid: the stroke's own shape survives the move.
    expect(words[0].path[1].x - words[0].path[0].x).toBeCloseTo(3, 9);
    // The far word would land past x1: it is pulled back inside.
    expect(Math.max(...words[2].path.map(p => p.x))).toBeLessThanOrEqual(215 + 1e-9);
    expect(onWordBox(boxes, { x: boxes[0].cx, y: boxes[0].cy })).toBe(true);
    expect(onWordBox(boxes, { x: 0, y: 0 })).toBe(false);
  });

  it('retries the slogan only while nothing is placed and the slogan is on', () => {
    const env = {} as SloganEnv;
    const calls: string[] = [];
    const attempts = [undefined, 'one', 'two'].map(salt => ({ surfaces: () => { calls.push(salt ?? 'first'); return []; }, salt }));
    expect(planSloganAttempts(sketchContext(1, { sloganCount: 1 }), env, attempts).placed).toEqual([]);
    expect(calls).toEqual(['first', 'one', 'two']);
    calls.length = 0;
    planSloganAttempts(sketchContext(1, { sloganCount: 0 }), env, attempts);
    expect(calls).toEqual(['first']);
  });

  it('paints a word flat on the ground, centred where it was asked', () => {
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 250 });
    const strokes = groundWord(view, 'ok', { x: 140, y: 340 }, { face: 'sans', height: 4 });
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.flat().every(p => p.y === 0.01)).toBe(true);
    const pts = strokes.flat().map(p => pageOf(view, p, page));
    const cx = (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2;
    const cy = (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2;
    expect(Math.abs(cx - 140)).toBeLessThan(3);
    expect(Math.abs(cy - 340)).toBeLessThan(3);
  });
});

describe('sketch kit: flat fills', () => {
  it('closes a circle and keeps every disc hatch line inside it', () => {
    const c = { x: 100, y: 200 };
    const ring = circlePath(c, 10, 144);
    expect(ring.length).toBe(145);
    expect(ring[0].x).toBeCloseTo(ring[144].x, 9);
    expect(ring.every(p => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - 10) < 1e-9)).toBe(true);
    const lines = discHatch(c, 10, [[Math.PI / 4, 0.55], [-Math.PI / 4, 0.8]]);
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) for (const p of line) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(10 + 1e-9);
    // Hatched disc: two rules, then the chords inside the inner one.
    const disc = hatchedDisc(c, 10, [[Math.PI / 4, 0.55]]);
    expect(disc.slice(0, 2).map(p => p.length)).toEqual([145, 145]);
    for (const line of disc.slice(2)) for (const p of line) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThan(9.1 + 1e-9);
  });

  it('fills a band between its mitred outlines, never past its edge', () => {
    const centreline = [{ x: 20, y: 0 }, { x: 40, y: 40 }, { x: 25, y: 80 }, { x: 45, y: 120 }];
    const half = 6, area = { x0: 0, x1: 100, y0: 0, y1: 120 };
    const [left, right] = bandOutlines(centreline, half);
    expect(left.length).toBe(centreline.length);
    // The ends are exactly half a band from the centreline; mitred corners stay at least that far.
    expect(sideOf(centreline, left[0]).dist).toBeCloseTo(half, 6);
    expect(sideOf(centreline, right[2]).dist).toBeGreaterThanOrEqual(half - 1e-9);
    const hatch = bandHatch(centreline, half, area);
    expect(hatch.length).toBeGreaterThan(20);
    for (const run of hatch) for (const p of run) expect(sideOf(centreline, p).dist).toBeLessThan(half - 0.5 + 0.2);
    expect(bandMarks(centreline, half, area).length).toBe(2 + hatch.length);
    // Narrower across than `narrow`, a band is its centreline alone; wider, or with no floor (tabloid's 0), a band.
    expect(bandMarks(centreline, 0.4, area, { narrow: 1 })).toEqual([centreline]);
    expect(bandMarks(centreline, 0.6, area, { narrow: 1 })).toEqual(bandMarks(centreline, 0.6, area));
    expect(bandMarks(centreline, 0.4, area, { narrow: 0 })).toEqual(bandMarks(centreline, 0.4, area));
    expect(bandMarks(centreline, half, area, { pitch: 0.8, narrow: 1 })).toEqual(bandMarks(centreline, half, area, { pitch: 0.8 }));
  });

  it('draws a hatched bar: an outer rule, an inner rule, and hatch inside both', () => {
    const bar = { cx: 100, cy: 100, l: 60, h: 12 };
    const tilt = 0.2;
    const { quad, paths } = hatchedBar(bar, tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]]);
    expect(quad.length).toBe(4);
    expect(paths[0].length).toBe(5);
    expect(paths[1].length).toBe(5);
    expect(paths.length).toBeGreaterThan(50);
    // In the bar's own frame, every hatch end lies inside the inner rule.
    const local = (p: { x: number; y: number }) => {
      const dx = p.x - bar.cx, dy = p.y - bar.cy;
      return { s: dx * Math.cos(tilt) + dy * Math.sin(tilt), t: -dx * Math.sin(tilt) + dy * Math.cos(tilt) };
    };
    for (const path of paths.slice(2)) for (const p of path) {
      const { s, t } = local(p);
      expect(Math.abs(s)).toBeLessThanOrEqual(bar.l / 2 - 1.6 + 1e-9);
      expect(Math.abs(t)).toBeLessThanOrEqual(bar.h / 2 - 1.6 + 1e-9);
    }
  });
});

describe('sketch kit: shared card helpers', () => {
  it('builds a level camera in tabloid\'s frame: its horizon on tabloid\'s line, its lens as given', () => {
    const cam = tabloidFrameCamera({ fov: 54, eye: 6, near: 8, far: 4000 });
    expect(cam.position.toArray()).toEqual([0, 6, 0]);
    expect([cam.fov, cam.near, cam.far]).toEqual([54, 8, 4000]);
    const horizon = pageOf(cam, new THREE.Vector3(0, 6, -1000), TABLOID_PAGE);
    expect(horizon.x).toBeCloseTo(TABLOID_PAGE.width / 2, 6);
    expect(horizon.y).toBeCloseTo(TABLOID_HORIZON_Y, 6);
    // The same camera `horizonCamera` makes from tabloid's page, raster and horizon; near defaults as there.
    const by = horizonCamera({ fov: 54, eye: [0, 6, 0], target: [0, 6, -100], far: 4000, page: TABLOID_PAGE, depth: TABLOID_RASTER, horizonY: TABLOID_HORIZON_Y, fit: false });
    const plain = tabloidFrameCamera({ fov: 54, eye: 6, far: 4000 });
    expect(plain.near).toBe(0.5);
    expect(plain.projectionMatrix.equals(by.projectionMatrix) && plain.matrixWorldInverse.equals(by.matrixWorldInverse)).toBe(true);
  });

  it('reduces a path at the card\'s scale: the print\'s reducer at 1, finer on a small card, and a bucket takes it as its reducer', () => {
    // A 3 mm circle in 0.1 mm steps: `simplify` cuts its corners; on a 0.25 scale card the reducer keeps its curve.
    const ring = Array.from({ length: 189 }, (_, i) => ({ x: 3 * Math.cos(i / 188 * Math.PI * 2), y: 3 * Math.sin(i / 188 * Math.PI * 2) }));
    expect(reduceAtScale(ring, 1)).toEqual(simplify(ring));
    const small = reduceAtScale(ring, 0.25);
    expect(small.length).toBeGreaterThan(simplify(ring).length * 2);
    expect(small[0]).toBe(ring[0]);
    expect(small[small.length - 1]).toBe(ring[ring.length - 1]);
    expect(small.every(p => ring.includes(p))).toBe(true);
    expect(reduceAtScale(ring.slice(0, 2), 0.25)).toEqual(ring.slice(0, 2));
    // `PartBuckets` takes a reducer for its ordinary paths; an exact path skips it, and the default is `simplify`.
    const keepEnds = (pts: { x: number; y: number }[]) => [pts[0], pts[pts.length - 1]];
    const line = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 0 }, { x: 3, y: 0.5 }];
    const custom = new PartBuckets(0.4, { reduce: keepEnds }), plain = new PartBuckets(0.4);
    custom.add('a', line); custom.add('b', line, true); plain.add('a', line);
    expect(custom.get('a')).toEqual([[line[0], line[3]]]);
    expect(custom.get('b')).toEqual([line]);
    expect(plain.get('a')).toEqual([simplify(line)]);
  });

  it('straightens a path to its corners and curves, and measures a point to a segment', () => {
    const p = (x: number, y: number) => ({ x, y });
    expect(straightened([p(0, 0), p(1, 0), p(2, 0), p(2, 1)])).toEqual([p(0, 0), p(2, 0), p(2, 1)]);
    expect(straightened([p(0, 0), p(1, 0.01), p(2, 0)])).toEqual([p(0, 0), p(2, 0)]);
    expect(straightened([p(0, 0), p(1, 0.05), p(2, 0)])).toHaveLength(3);
    expect(straightened([p(0, 0), p(1, 0.05), p(2, 0)], 0.1)).toHaveLength(2);
    expect(straightened([p(0, 0), p(1, 1)])).toEqual([p(0, 0), p(1, 1)]);
    expect(segDist(p(1, 1), p(0, 0), p(2, 0))).toBe(1);
    expect(segDist(p(-3, 4), p(0, 0), p(2, 0))).toBe(5);
    expect(segDist(p(3, 0), p(1, 1), p(1, 1))).toBeCloseTo(Math.hypot(2, 1), 12);
  });

  it('tags each helix stroke with its role, and a strand\'s edges are found by it', () => {
    const ctx = sketchContext(5);
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 250 });
    const [a, b] = helixStrands(ctx).map(st => strandStrokes({ ...st, z: -30 }, 0.5, 0.3, ctx, view));
    expect([a, b].every(strokes => strokes.every(h => h.role))).toBe(true);
    expect(a.slice(0, 2).map(h => h.role)).toEqual(['edge', 'edge']);
    expect(a.filter(h => h.role === 'spine').map(h => h.ink)).toEqual(['acid']);
    expect(b.some(h => h.role === 'spine')).toBe(false);
    expect(new Set([...a, ...b].map(h => h.role))).toEqual(new Set(['edge', 'lamination', 'spine', 'rib', 'pulse']));
    const edges = ribbonEdges([...a, ...b], 'strand-b')!;
    expect(edges[0]).toBe(b[0]);
    expect(edges[1]).toBe(b[1]);
    // Not the first two strokes by position: a strand without its edges has none.
    expect(ribbonEdges([...a, ...b].filter(h => h.role !== 'edge'), 'strand-a')).toBeUndefined();
    const widths = ribbonWidths(edges, view), mid = ribbonMidline(edges);
    expect(widths).toHaveLength(481);
    expect(mid).toHaveLength(481);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(0);
    expect(mid[200].distanceTo(edges[0].points[200].clone().add(edges[1].points[200]).multiplyScalar(0.5))).toBeLessThan(1e-9);
  });

  it('draws a ribbon narrower than its limit as a line, by its median or its widest, keeping its spine or the rest', () => {
    const ctx = sketchContext(5);
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 250 });
    const [a, b] = helixStrands(ctx).map(st => strandStrokes({ ...st, z: -30 }, 0.5, 0.3, ctx, view));
    const strokes = [...a, ...b];
    const widths = ribbonWidths(ribbonEdges(strokes, 'strand-a')!, view).sort((x, y) => x - y);
    const median = widths[widths.length >> 1], widest = widths[widths.length - 1];
    expect(widest).toBeGreaterThan(median);
    // No limit (tabloid), or a ribbon wide enough: every stroke, as it was.
    expect(narrowStrands(strokes, view, { limit: 0 })).toBe(strokes);
    expect(narrowStrands(strokes, view, { limit: median * 0.5 })).toEqual(strokes);
    // Narrower than the limit: each strand is its line alone. Strand a keeps its spine, strand b has none, so its edges' midline.
    const lines = narrowStrands(strokes, view, { limit: 1e6 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(a.find(h => h.role === 'spine'));
    expect([lines[1].group, lines[1].ink]).toEqual(['strand-b', b[0].ink]);
    expect(lines[1].points).toEqual(ribbonMidline([b[0], b[1]]));
    // `rest` merges only the two edges of each strand into their midline and keeps everything else, in order.
    const rest = narrowStrands(strokes, view, { limit: 1e6, keep: 'rest' });
    expect(rest).toHaveLength(strokes.length - 2);
    expect(rest[0].points).toEqual(ribbonMidline([a[0], a[1]]));
    expect(rest.slice(1, a.length - 1)).toEqual(a.slice(2));
    // Between the median and the widest, the median says narrow and the widest says wide; a window that counts no sample says narrow.
    const between = (median + widest) / 2;
    expect(narrowStrands(strokes, view, { limit: between })).toHaveLength(2);
    expect(narrowStrands(strokes, view, { limit: between, measure: 'widest' })).toEqual(strokes);
    expect(narrowStrands(strokes, view, { limit: between, measure: 'widest', counts: () => false })).toHaveLength(2);
  });

  it('tests a small subject against a finer raster: a view of its own with the same projection, and the depth pass at m times the card\'s', () => {
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 40, height: 62 }, horizonY: 300 });
    const finer = oversampledView(view, 4);
    expect(finer).not.toBe(view);
    expect(finer.view).toMatchObject({ fullWidth: 160, fullHeight: 248, width: 160, height: 248 });
    expect(finer.projectionMatrix.equals(view.projectionMatrix)).toBe(true);
    finer.near = 3;
    expect(view.near).toBe(0.5);
    expect(oversampledView(view, 1).projectionMatrix.equals(view.projectionMatrix)).toBe(true);
    // The depth pass of a slab at 4 times a 40 x 62 raster, and the page millimetres per finer pixel.
    const slabs = [solid(0, 2, -30, 8, 6, 2, 0, 'stack')].map(slabGeometry);
    const raster = { W: 40, H: 62, MM_X: page.width / 40, MM_Y: page.height / 62 };
    const fine = fineDepth(slabs, finer, raster, 4, 0.01);
    expect([fine.env.width, fine.env.height, fine.env.bias, fine.env.view]).toEqual([160, 248, 0.01, finer]);
    expect([fine.env.depth.width, fine.env.depth.height]).toEqual([160, 248]);
    expect(fine.env.depth.depthData).toEqual(renderDepthBufferCPU(slabs, finer, 160, 248).depthData);
    expect([fine.mmX, fine.mmY]).toEqual([raster.MM_X / 4, raster.MM_Y / 4]);
    expect(fineDepth(slabs, view, raster, 1).env.depth.depthData).toEqual(renderDepthBufferCPU(slabs, view, 40, 62).depthData);
  });

  it('thins near-parallel strokes in rank order: the first path keeps its line, a neighbour closer than the limit loses the stretch beside it', () => {
    const line = (x0: number, x1: number, y: number) => [{ x: x0, y }, { x: x1, y }];
    const [outline, near, far, over, crossing] = thinParallel([line(0, 10, 0), line(0, 10, 0.2), line(0, 10, 1), line(-5, 5, 0.2), [{ x: 5, y: -3 }, { x: 5.1, y: 3 }]], 0.5);
    // A kept path is one run, cut into steps of 0.2 mm along its length.
    const ends = (runs: { x: number; y: number }[][]) => runs.map(r => [r[0], r[r.length - 1]]);
    expect(ends(outline)).toEqual([line(0, 10, 0)]);
    expect(near).toEqual([]);
    expect(ends(far)).toEqual([line(0, 10, 1)]);
    // Only the stretch beside the outline goes: from x = 0 on, the part before it carries on.
    expect(over).toHaveLength(1);
    expect(over[0][0]).toEqual({ x: -5, y: 0.2 });
    expect(over[0][over[0].length - 1].x).toBeCloseTo(0, 9);
    // A stroke that crosses at an angle is not beside it, and keeps its line.
    expect(crossing).toHaveLength(1);
    // The order ranks them: a path given first wins, and a path never crowds itself.
    expect(thinParallel([line(0, 10, 0.2), line(0, 10, 0)], 0.5).map(runs => runs.length)).toEqual([1, 0]);
    const [back] = thinParallel([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.1 }, { x: 0, y: 0.1 }]], 0.5);
    expect(back).toHaveLength(1);
    expect(back[0][back[0].length - 1]).toEqual({ x: 0, y: 0.1 });
    // A path that carries on from where another ends keeps its line; one the limit apart does too.
    expect(thinParallel([line(0, 10, 0), line(10.5, 20, 0.1)], 0.5)[1]).toHaveLength(1);
    expect(thinParallel([line(0, 10, 0), line(0, 10, 0.5)], 0.5)[1]).toHaveLength(1);
  });

  it('keeps paper clear round the marks drawn so far: a point within the gap of any registered mark is near', () => {
    const clear = new Clearance(1);
    expect(clear.near({ x: 5, y: 0 })).toBe(false);
    clear.add([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    // Along the whole mark, not just its ends or its vertices; strictly under the gap; past its end by the gap.
    for (const x of [0, 2.53, 5.03, 9.97]) expect(clear.near({ x, y: 0.9 })).toBe(true);
    expect(clear.near({ x: 5, y: 1 })).toBe(false);
    expect(clear.near({ x: 5, y: -2.5 })).toBe(false);
    expect(clear.near({ x: 10.9, y: 0 })).toBe(true);
    expect(clear.near({ x: 11.2, y: 0 })).toBe(false);
    expect(clear.near({ x: -0.5, y: -0.5 })).toBe(true);
    // A mark of one point, or none; and a sparser sampling step leaves gaps a point can slip through.
    clear.add([{ x: 20, y: 20 }]);
    clear.add([]);
    expect(clear.near({ x: 20.5, y: 20 })).toBe(true);
    const sparse = new Clearance(0.5, 4);
    sparse.add([{ x: 0, y: 0 }, { x: 8, y: 0 }]);
    expect(sparse.near({ x: 2, y: 0 })).toBe(false);
    expect(sparse.near({ x: 4.2, y: 0 })).toBe(true);
  });
});
