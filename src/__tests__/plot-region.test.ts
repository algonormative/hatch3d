import { describe, expect, it } from 'vitest';
import { clipToRegion, distanceToRings, inRegion, offsetRing, ringsSimple, signedArea } from '../sketch/region.ts';
import type { Region } from '../sketch/region.ts';
import type { Point } from '../sketch/types.ts';

const P = (x: number, y: number): Point => ({ x, y });
/** A rectangle ring, counter-clockwise in a y-up frame. */
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const line = (...c: number[]): Point[] => c.reduce<Point[]>((out, v, i) => (i % 2 ? out : [...out, P(v, c[i + 1])]), []);
const length = (paths: Point[][]): number => paths.reduce((sum, path) => sum + path.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0), 0);
const mulberry32 = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
/** The ring's vertices, in any rotation, as a sorted list: orientation- and start-independent. */
const vertexSet = (ring: Point[]): string[] => ring.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();

describe('clipToRegion: rings', () => {
  const box: Region = { rings: [rect(10, 10, 20, 20)] };

  it('cuts a segment exactly at each ring crossing', () => {
    const [kept, ...rest] = clipToRegion([line(0, 15, 30, 15)], box);
    expect(rest).toHaveLength(0);
    expect(kept).toHaveLength(2);
    expect(Math.abs(kept[0].x - 10)).toBeLessThan(1e-9);
    expect(Math.abs(kept[1].x - 20)).toBeLessThan(1e-9);
    expect(kept[0].y).toBeCloseTo(15, 12);
    const outside = clipToRegion([line(0, 15, 30, 15)], { not: box });
    expect(outside.map((path) => path.map((p) => p.x))).toEqual([[0, 10], [20, 30]]);
  });

  it('is exact on a diagonal crossing, to 1e-9 in both coordinates', () => {
    const kept = clipToRegion([line(0, 0, 30, 30)], box);
    expect(kept).toHaveLength(1);
    for (const [p, v] of [[kept[0][0], 10], [kept[0][1], 20]] as [Point, number][]) {
      expect(Math.abs(p.x - v)).toBeLessThan(1e-9);
      expect(Math.abs(p.y - v)).toBeLessThan(1e-9);
    }
  });

  it('uses even-odd area: a hole is outside, and the winding of a ring does not matter', () => {
    const holed: Region = { rings: [rect(0, 0, 30, 30), rect(10, 10, 20, 20)] };
    expect(clipToRegion([line(-5, 15, 35, 15)], holed).map((path) => path.map((p) => p.x))).toEqual([[0, 10], [20, 30]]);
    const reversed: Region = { rings: [rect(0, 0, 30, 30).reverse(), rect(10, 10, 20, 20)] };
    expect(clipToRegion([line(-5, 15, 35, 15)], reversed)).toEqual(clipToRegion([line(-5, 15, 35, 15)], holed));
    expect(inRegion(P(5, 5), holed)).toBe(true);
    expect(inRegion(P(15, 15), holed)).toBe(false);
  });

  it('welds a polyline across segments and splits it at a gap', () => {
    const zigzag = line(0, 15, 15, 15, 15, 5, 18, 5, 18, 15, 40, 15);
    expect(clipToRegion([zigzag], box)).toEqual([[P(10, 15), P(15, 15), P(15, 10)], [P(18, 10), P(18, 15), P(20, 15)]]);
  });

  it('drops pieces with fewer than two points and keeps a segment inside whole', () => {
    expect(clipToRegion([line(15, 15, 15.0000000001, 15), [P(5, 5)]], box)).toEqual([]);
    expect(clipToRegion([line(12, 12, 18, 18)], box)).toEqual([line(12, 12, 18, 18)]);
  });

  it('handles a segment collinear with a ring edge deterministically: the lower and left edges count as inside', () => {
    const bottom = clipToRegion([line(0, 10, 30, 10)], box);
    expect(bottom).toEqual([line(10, 10, 20, 10)]);
    expect(clipToRegion([line(0, 10, 30, 10)], box)).toEqual(bottom);
    expect(clipToRegion([line(0, 20, 30, 20)], box)).toEqual([]);
    expect(clipToRegion([line(10, 0, 10, 30)], box)).toEqual([line(10, 10, 10, 20)]);
    expect(clipToRegion([line(20, 0, 20, 30)], box)).toEqual([]);
  });

  it('handles a ring vertex lying exactly on the segment', () => {
    const diamond: Region = { rings: [[P(10, 15), P(15, 10), P(20, 15), P(15, 20)]] };
    expect(clipToRegion([line(0, 15, 30, 15)], diamond)).toEqual([line(10, 15, 20, 15)]);
    // A vertex that only touches from outside changes nothing, and adds no vertex to the output.
    const spike: Region = { rings: [[P(10, 5), P(20, 5), P(15, 15)]] };
    expect(clipToRegion([line(0, 15, 30, 15)], { not: spike })).toEqual([line(0, 15, 30, 15)]);
    expect(clipToRegion([line(0, 15, 30, 15)], spike)).toEqual([]);
  });

  it('keeps a segment that enters a ring exactly at a vertex it passes through, to float rounding', () => {
    // The segment runs through the triangle's first vertex, which the crossing test meets at u = -1e-16 rather than 0.
    // Brute force over 200000 samples of inRegion is the independent answer: 3.0 mm inside.
    const A = P(2.261194377206266, 6.931398988235742), B = P(9.261572826653719, 1.8699655099771917);
    const triangle = [P(6.714092834139001, 3.7118517183329076), P(9.731123203071503, 2.7644723049303277), P(8.559289481243455, 1.1437299662513427)];
    const region: Region = { rings: [triangle] };
    const N = 200000, total = length([[A, B]]);
    let inside = 0;
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      if (inRegion(P(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t), region)) inside++;
    }
    const sampled = (inside / N) * total;
    expect(Math.abs(sampled - 3)).toBeLessThan(1e-3);
    const kept = clipToRegion([[A, B]], region);
    expect(Math.abs(length(kept) - sampled)).toBeLessThan((total / N) * 4);
    expect(Math.abs(length(kept) - 3)).toBeLessThan(1e-3);
  });

  it('treats an unclosed ring as closed, and ignores a repeated closing point', () => {
    const closedRing: Region = { rings: [[...rect(10, 10, 20, 20), P(10, 10)]] };
    expect(clipToRegion([line(0, 15, 30, 15)], closedRing)).toEqual([line(10, 15, 20, 15)]);
  });
});

describe('clipToRegion: near', () => {
  const ring = rect(10, 10, 20, 20);

  it('breaks exactly on the discs at an edge end, not only on the slab', () => {
    // Along y = 9 the line is 1 below the bottom edge: the capsule of radius 2 spans x in 10 - sqrt(3) .. 20 + sqrt(3).
    const kept = clipToRegion([line(0, 9, 30, 9)], { near: [ring], distance: 2 });
    expect(kept).toHaveLength(1);
    expect(Math.abs(kept[0][0].x - (10 - Math.sqrt(3)))).toBeLessThan(1e-9);
    expect(Math.abs(kept[0][1].x - (20 + Math.sqrt(3)))).toBeLessThan(1e-9);
  });

  it('treats a one-point ring as a disc: it breaks where the line enters and leaves it', () => {
    const disc: Region = { near: [[P(0, 0)]], distance: 1 };
    expect(clipToRegion([line(-2, 0, 2, 0)], disc)).toEqual([line(-1, 0, 1, 0)]);
    expect(clipToRegion([line(-2, 0, 2, 0)], { not: disc })).toEqual([line(-2, 0, -1, 0), line(1, 0, 2, 0)]);
    expect(inRegion(P(0.5, 0), disc)).toBe(true);
    expect(inRegion(P(1.5, 0), disc)).toBe(false);
  });

  it('measures a two-point ring as a capsule round its one segment', () => {
    const capsule: Region = { near: [[P(0, 0), P(10, 0)]], distance: 1 };
    expect(clipToRegion([line(-2, 0, 12, 0)], capsule)).toEqual([line(-1, 0, 11, 0)]);
    const kept = clipToRegion([line(5, -3, 5, 3)], capsule);
    expect(kept).toHaveLength(1);
    expect(Math.abs(kept[0][0].y + 1)).toBeLessThan(1e-9);
    expect(Math.abs(kept[0][1].y - 1)).toBeLessThan(1e-9);
  });

  it('keeps the band either side of each edge', () => {
    const kept = clipToRegion([line(0, 15, 30, 15)], { near: [ring], distance: 2 });
    expect(kept.map((path) => path.map((p) => p.x))).toEqual([[8, 12], [18, 22]]);
  });

  it('keeps no point closer than d to the ring when the band is excluded, and a path at d + 0.05 whole', () => {
    const d = 2;
    const rng = mulberry32(7);
    const star = Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2, r = 12 + 9 * (i % 2); return P(50 + r * Math.cos(a), 50 + r * Math.sin(a)); });
    const paths = Array.from({ length: 60 }, () => line(rng() * 100, rng() * 100, rng() * 100, rng() * 100));
    const far: Region = { not: { near: [star], distance: d } };
    const pieces = clipToRegion(paths, far);
    expect(pieces.length).toBeGreaterThan(40);
    expect(length(pieces)).toBeLessThan(length(paths)); // the band really removed something
    for (const piece of pieces) {
      for (const [a, b] of piece.slice(1).map((p, i) => [piece[i], p])) {
        for (let k = 0; k <= 20; k++) expect(distanceToRings(P(a.x + ((b.x - a.x) * k) / 20, a.y + ((b.y - a.y) * k) / 20), [star])).toBeGreaterThan(d - 1e-6);
      }
    }
    // The cut ends of every kept piece sit on the band's edge, to 1e-9.
    let cutEnds = 0;
    for (const piece of pieces) for (const end of [piece[0], piece[piece.length - 1]]) {
      const onPath = paths.some((path) => (end.x === path[0].x && end.y === path[0].y) || (end.x === path[1].x && end.y === path[1].y));
      if (onPath) continue;
      cutEnds++;
      expect(Math.abs(distanceToRings(end, [star]) - d)).toBeLessThan(1e-9);
    }
    expect(cutEnds).toBeGreaterThan(20);
    const parallel = line(0, 10 - d - 0.05, 30, 10 - d - 0.05);
    expect(clipToRegion([parallel], { not: { near: [ring], distance: d } })).toEqual([parallel]);
    const inside = clipToRegion([line(0, 10 - d + 0.05, 30, 10 - d + 0.05)], { not: { near: [ring], distance: d } });
    expect(inside).toHaveLength(2);
  });

  it('is open: a path at exactly d is outside the band, and distance 0 is the empty band', () => {
    expect(inRegion(P(15, 8), { near: [ring], distance: 2 })).toBe(false);
    expect(inRegion(P(15, 8.001), { near: [ring], distance: 2 })).toBe(true);
    expect(clipToRegion([line(0, 15, 30, 15)], { near: [ring], distance: 0 })).toEqual([]);
  });

  it('measures to ring EDGES, so the middle of a ring is not near it', () => {
    expect(inRegion(P(15, 15), { near: [ring], distance: 2 })).toBe(false);
    expect(distanceToRings(P(15, 15), [ring])).toBeCloseTo(5, 12);
  });
});

describe('clipToRegion: boolean trees', () => {
  it('and([]) is everything and or([]) is nothing', () => {
    const path = line(0, 0, 10, 10, 20, 0);
    expect(inRegion(P(3, 3), { and: [] })).toBe(true);
    expect(inRegion(P(3, 3), { or: [] })).toBe(false);
    expect(clipToRegion([path], { and: [] })).toEqual([path]);
    expect(clipToRegion([path], { or: [] })).toEqual([]);
    expect(clipToRegion([path], { not: { or: [] } })).toEqual([path]);
    expect(clipToRegion([path], { all: true })).toEqual([path]);
  });

  it('keeps the exact answer when leaves overlap: and, or and not agree with their point tests', () => {
    const a: Region = { rings: [rect(10, 10, 40, 40)] };
    const b: Region = { near: [rect(30, 30, 60, 60)], distance: 4 };
    const both: Region = { and: [a, { not: b }] };
    const rng = mulberry32(11);
    let split = 0;
    for (let n = 0; n < 40; n++) {
      const path = line(rng() * 70, rng() * 70, rng() * 70, rng() * 70);
      for (const region of [both, { or: [a, b] } as Region, { and: [a, b] } as Region, { not: both } as Region]) {
        const kept = length(clipToRegion([path], region));
        const rest = length(clipToRegion([path], { not: region }));
        expect(kept + rest).toBeCloseTo(length([path]), 8);
        // Brute force: the sampled fraction inside agrees with the exact length to within the sampling step.
        const samples = 4000;
        let inside = 0;
        for (let k = 0; k < samples; k++) {
          const t = (k + 0.5) / samples;
          if (inRegion(P(path[0].x + (path[1].x - path[0].x) * t, path[0].y + (path[1].y - path[0].y) * t), region)) inside++;
        }
        expect(Math.abs(kept - (inside / samples) * length([path]))).toBeLessThan(length([path]) / samples * 6 + 1e-9);
        if (kept > 1e-6 && rest > 1e-6) split++;
      }
    }
    expect(split).toBeGreaterThan(60); // most trials had both an inside and an outside part
  });

  it('is deterministic', () => {
    const region: Region = { and: [{ not: { near: [rect(20, 20, 60, 60)], distance: 3 } }, { or: [{ rings: [rect(0, 0, 50, 50)] }, { near: [rect(40, 40, 90, 90)], distance: 5 }] }] };
    const rng = mulberry32(3);
    const paths = Array.from({ length: 30 }, () => line(rng() * 100, rng() * 100, rng() * 100, rng() * 100, rng() * 100, rng() * 100));
    expect(clipToRegion(paths, region)).toEqual(clipToRegion(paths, region));
  });
});

describe('ring geometry', () => {
  const square = rect(0, 0, 10, 10);
  const ell = [P(0, 0), P(10, 0), P(10, 4), P(4, 4), P(4, 10), P(0, 10)];

  it('signedArea is positive counter-clockwise and negative clockwise', () => {
    expect(signedArea(square)).toBeCloseTo(100, 12);
    expect(signedArea([...square].reverse())).toBeCloseTo(-100, 12);
    expect(signedArea(ell)).toBeCloseTo(64, 12);
  });

  it('distanceToRings is the minimum over every ring edge, and Infinity for none', () => {
    expect(distanceToRings(P(15, 5), [square])).toBeCloseTo(5, 12);
    expect(distanceToRings(P(13, 14), [square])).toBeCloseTo(5, 12);
    expect(distanceToRings(P(5, 5), [square, rect(20, 0, 30, 10)])).toBeCloseTo(5, 12);
    expect(distanceToRings(P(5, 5), [])).toBe(Infinity);
  });

  for (const [name, wind] of [['counter-clockwise', (r: Point[]) => r], ['clockwise', (r: Point[]) => [...r].reverse()]] as const) {
    it(`offsets a square ${name}: positive grows it, negative shrinks it`, () => {
      expect(vertexSet(offsetRing(wind(square), 1))).toEqual(vertexSet(rect(-1, -1, 11, 11)));
      expect(vertexSet(offsetRing(wind(square), -1))).toEqual(vertexSet(rect(1, 1, 9, 9)));
      expect(Math.abs(signedArea(offsetRing(wind(square), 2)))).toBeCloseTo(196, 9);
    });

    it(`offsets an L-shape ${name}: the reflex corner takes the intersection of the offset edges`, () => {
      const grown = [P(-1, -1), P(11, -1), P(11, 5), P(5, 5), P(5, 11), P(-1, 11)];
      const shrunk = [P(1, 1), P(9, 1), P(9, 3), P(3, 3), P(3, 9), P(1, 9)];
      expect(vertexSet(offsetRing(wind(ell), 1))).toEqual(vertexSet(grown));
      expect(vertexSet(offsetRing(wind(ell), -1))).toEqual(vertexSet(shrunk));
      expect(Math.abs(signedArea(offsetRing(wind(ell), 1)))).toBeCloseTo(108, 9);
      expect(Math.abs(signedArea(offsetRing(wind(ell), -1)))).toBeCloseTo(28, 9);
    });
  }

  it('does not mutate its input, drops a closing repeat, and returns the ring itself for d = 0', () => {
    const closedSquare = [...square, P(0, 0)];
    const before = JSON.stringify(closedSquare);
    expect(offsetRing(closedSquare, 1)).toHaveLength(4);
    expect(JSON.stringify(closedSquare)).toBe(before);
    expect(vertexSet(offsetRing(closedSquare, 0))).toEqual(vertexSet(square));
  });

  it('bevels a corner whose miter would pass the limit, and mitres it otherwise', () => {
    const spike = [P(0, 0), P(40, 0), P(0, 6)]; // a sharp corner at (40, 0)
    const reach = (ring: Point[]) => Math.max(...ring.map((p) => Math.min(...spike.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))));
    const bevelled = offsetRing(spike, 1);
    expect(bevelled.length).toBeGreaterThan(3);
    expect(reach(bevelled)).toBeLessThanOrEqual(4 + 1e-9);
    const mitred = offsetRing(spike, 1, 100);
    expect(mitred).toHaveLength(3);
    expect(reach(mitred)).toBeGreaterThan(4);
    // Shrinking never bevels: the offset edges overlap there.
    expect(offsetRing(spike, -0.2)).toHaveLength(3);
  });

  it('a bevelled sharp corner joins the two offset edges in order, so the offset ring is simple', () => {
    const needle = [P(0, 0), P(20, 1), P(0, 2)];
    const grown = offsetRing(needle, 0.3);
    expect(grown).toHaveLength(4);
    expect(ringsSimple([grown])).toBe(true);
    // The bevel joins the first edge's offset end to the second's: both sit 0.3 from the ring, either side of the tip.
    for (const p of grown.slice(1, 3)) expect(Math.abs(distanceToRings(p, [needle]) - 0.3)).toBeLessThan(1e-9);
    expect(grown[1].y).toBeLessThan(grown[2].y);
    expect(Math.abs(signedArea(grown))).toBeGreaterThan(Math.abs(signedArea(needle)));
  });

  it('ringsSimple: simple rings pass; self-crossing, crossing, touching and degenerate rings fail', () => {
    expect(ringsSimple([square])).toBe(true);
    expect(ringsSimple([ell])).toBe(true);
    expect(ringsSimple([[...square, P(0, 0)]])).toBe(true);
    expect(ringsSimple([square, rect(20, 0, 30, 10)])).toBe(true);
    expect(ringsSimple([rect(0, 0, 30, 30), rect(10, 10, 20, 20)])).toBe(true); // an outer ring with a hole
    expect(ringsSimple([[P(0, 0), P(10, 10), P(10, 0), P(0, 10)]])).toBe(false); // a bow tie
    expect(ringsSimple([square, rect(5, 5, 15, 15)])).toBe(false); // crossing
    expect(ringsSimple([square, rect(10, 0, 20, 10)])).toBe(false); // sharing an edge
    expect(ringsSimple([square, rect(10, 10, 20, 20)])).toBe(false); // touching at a corner
    expect(ringsSimple([[P(0, 0), P(10, 0)]])).toBe(false);
    expect(ringsSimple([[P(0, 0), P(10, 0), P(5, 0)]])).toBe(false); // folds back on itself
    expect(ringsSimple([[P(0, 0), P(10, 0), P(10, 10), P(5, 0)]])).toBe(false);
  });
});
