import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bandHatch, bandMarks, bandOutlines, circlePath, discHatch, hatchedBar, hatchedDisc, sideOf } from '../../sketches/kit/fills.ts';
import { alongRay, collapseBand, helixStrands, strandPoint, towerFrame } from '../../sketches/kit/helix.ts';
import {
  glyphMask, groundWord, onWordBox, planSloganAttempts, rigidWords, type SloganEnv,
} from '../../sketches/kit/lettering.ts';
import { densityPitch, facetStrokes, faceDarkness, pageExtent, rakingLight, slabGeometry, slabMatrix, slabStrokes, sliverShade, solid } from '../../sketches/kit/slabs.ts';
import { horizonCamera, pageOf, tabloidFrameCamera } from '../../sketches/kit/perspective.ts';
import { TABLOID_HORIZON_Y, TABLOID_RASTER } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
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
});
