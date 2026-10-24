import { describe, expect, it } from 'vitest';
import { area, traceMask } from '../../sketches/kit/outline.ts';
import { contourLines, isoLines, meshSdf, perVertex, platesOn, scatterOn, sphere } from '../../sketches/kit/sculpt.ts';

const unit = () => meshSdf(sphere([0, 0, 0], 1), [-1.2, -1.2, -1.2], [1.2, 1.2, 1.2], 0.05);

describe('sketch kit: sculpted solids', () => {
  it('meshes a field onto its surface, its normals the field\'s', () => {
    const m = unit();
    expect(m.tri.length).toBeGreaterThan(1000);
    for (let v = 0; v < m.pos.length; v += 3) {
      const r = Math.hypot(m.pos[v], m.pos[v + 1], m.pos[v + 2]);
      expect(Math.abs(r - 1)).toBeLessThan(1e-4);
      expect(m.nrm[v] * m.pos[v] + m.nrm[v + 1] * m.pos[v + 1] + m.nrm[v + 2] * m.pos[v + 2]).toBeGreaterThan(0.999);
    }
  });

  it('draws level sets as chained lines: a sphere\'s slices are its circles, whole', () => {
    const m = unit();
    const lines = isoLines(m, perVertex(m, p => p[2]), 0.25);
    const length = (pts: { p: number[] }[]) => pts.slice(1).reduce((t, q, i) => t + Math.hypot(q.p[0] - pts[i].p[0], q.p[1] - pts[i].p[1], q.p[2] - pts[i].p[2]), 0);
    for (const z of [-0.5, 0, 0.75]) {
      const at = lines.filter(l => Math.abs(l.level - z) < 1e-6);
      const r = Math.sqrt(1 - z * z);
      // Every point on its circle, and the pieces (a surface-nets mesh can split one at a non-manifold edge) as long
      // as the circle: nothing dropped, nothing doubled.
      for (const q of at.flatMap(l => l.points)) expect(Math.abs(Math.hypot(q.p[0], q.p[1]) - r)).toBeLessThan(0.01);
      expect(at.reduce((t, l) => t + length(l.points), 0) / (2 * Math.PI * r)).toBeCloseTo(1, 1);
      expect(at.length).toBeLessThanOrEqual(2);
    }
  });

  it('adds a wrapping phase unwrapped per triangle: a distance plus an angle draws a spiral', () => {
    // From the pole: 2π·(polar angle)/0.08 + azimuth, at levels 2π apart, is a spiral 0.08 rad of polar angle a turn,
    // so the scalar changes by several turns across one triangle. Unwrapping the whole sum (not the angle alone) puts
    // its points off the spiral.
    const m = unit();
    const turn = 0.08;
    const polar = perVertex(m, p => (Math.acos(Math.max(-1, Math.min(1, p[2]))) / turn) * 2 * Math.PI);
    const azimuth = perVertex(m, p => Math.atan2(p[1], p[0]));
    const lines = isoLines(m, polar, 2 * Math.PI, 0, undefined, { values: azimuth, period: 2 * Math.PI });
    const pts = lines.flatMap(l => l.points).filter(q => q.p[2] > -0.9 && q.p[2] < 0.9);
    expect(pts.length).toBeGreaterThan(500);
    for (const q of pts) {
      const v = (Math.acos(q.p[2]) / turn) * 2 * Math.PI + Math.atan2(q.p[1], q.p[0]);
      const off = Math.abs(v / (2 * Math.PI) - Math.round(v / (2 * Math.PI)));
      // Within a twentieth of a turn of the spiral.
      expect(off).toBeLessThan(0.05);
    }
  });

  it('keeps the segments of a level that lands exactly on a vertex', () => {
    // A fan: its centre exactly on level 0, its rim above. The nudged level still crosses every triangle near the centre.
    const sides = 6, pos = [0, 0, 0], tri: number[] = [];
    for (let k = 0; k < sides; k++) { const a = 2 * Math.PI * k / sides; pos.push(Math.cos(a), Math.sin(a), 0); tri.push(0, 1 + k, 1 + (k + 1) % sides); }
    const m = { pos: Float64Array.from(pos), nrm: Float64Array.from(pos.map((_, i) => (i % 3 === 2 ? 1 : 0))), tri: Uint32Array.from(tri), transform: unit().transform };
    const lines = isoLines(m, Float64Array.from([0, 1, 1, 1, 1, 1, 1]), 1, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].points.length).toBe(sides + 1);
  });

  it('scatters plate seeds apart and cuts the surface into plates round them', () => {
    const m = unit();
    let s = 1;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const seeds = scatterOn(m, 0.4, rng, p => p[2] > -0.5, [[0, 0, 1]]);
    expect(seeds[0]).toEqual([0, 0, 1]);
    expect(seeds.length).toBeGreaterThan(10);
    for (const a of seeds) for (const b of seeds) if (a !== b) expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThanOrEqual(0.4);
    for (const q of seeds) expect(q[2]).toBeGreaterThan(-0.5);
    const plates = platesOn(m, seeds);
    for (let v = 0; v < plates.plate.length; v += 37) {
      const p = [m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]];
      const d = seeds.map(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
      const order = d.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]);
      expect(plates.plate[v]).toBe(order[0][1]);
      expect(plates.second[v]).toBe(order[1][1]);
      expect(plates.gap[v]).toBeCloseTo(order[1][0] - order[0][0], 9);
    }
  });

  it('finds the silhouette seen from an eye: the circle where the view grazes the sphere', () => {
    const m = unit();
    const [line] = contourLines(m, [0, 0, 10]);
    expect(line.points.length).toBeGreaterThan(50);
    // Grazing points satisfy p·(eye − p) = 0, so z = 1/10 on the unit sphere.
    for (const q of line.points) expect(Math.abs(q.p[2] - 0.1)).toBeLessThan(0.01);
  });
});

describe('sketch kit: outlines traced from an inside test', () => {
  const box = { x0: 0, x1: 60, y0: 0, y1: 60 };

  it('traces a disc, and an annulus as an outer ring and a hole of opposite turn', () => {
    const [disc] = traceMask(p => Math.hypot(p.x - 30, p.y - 30) < 12, box, 0.25);
    expect(Math.abs(area(disc))).toBeCloseTo(Math.PI * 144, -1);
    const ring = traceMask(p => { const r = Math.hypot(p.x - 30, p.y - 30); return r < 20 && r > 8; }, box, 0.25);
    expect(ring).toHaveLength(2);
    expect(Math.sign(area(ring[0]))).toBe(-Math.sign(area(ring[1])));
    expect(Math.abs(area(ring[0])) + Math.abs(area(ring[1]))).toBeCloseTo(Math.PI * (400 + 64), -1);
  });

  it('closes a region that runs off the box along the box edge, inside it', () => {
    const rings = traceMask(p => p.y > 40, box, 0.25, { minRadius: 1 });
    expect(rings).toHaveLength(1);
    for (const p of rings[0]) {
      expect(p.x).toBeGreaterThanOrEqual(box.x0 - 0.13);
      expect(p.x).toBeLessThanOrEqual(box.x1 + 0.13);
      expect(p.y).toBeLessThanOrEqual(box.y1 + 0.13);
    }
  });

  it('erodes a sliver on the box edge as it would one inside', () => {
    expect(traceMask(p => p.y < 1.5, box, 0.1, { minRadius: 1 })).toHaveLength(0);
    expect(traceMask(p => p.y > 30 && p.y < 31.5, box, 0.1, { minRadius: 1 })).toHaveLength(0);
  });

  it('rounds every corner and fills every notch to the minimum radius', () => {
    // A square with a notch 1 mm wide and 10 deep cut into one side: with a 1.5 mm radius the notch closes and the
    // corners round.
    const inside = (p: { x: number; y: number }) => p.x > 10 && p.x < 50 && p.y > 10 && p.y < 50 && !(p.x > 29.5 && p.x < 30.5 && p.y > 40);
    const [sharp] = traceMask(inside, box, 0.25);
    const [round] = traceMask(inside, box, 0.25, { minRadius: 1.5 });
    // The notch closed: the area back past the notched square's.
    expect(Math.abs(area(round))).toBeGreaterThan(Math.abs(area(sharp)) + 4);
    // The corners on an arc: its middle is r(√2 − 1) in from the square's corner, where the sharp trace passes close by.
    const corners = [[10, 10], [50, 10], [50, 50], [10, 50]];
    const inFrom = (ring: { x: number; y: number }[]) => Math.min(...corners.map(c => Math.min(...ring.map(p => Math.hypot(p.x - c[0], p.y - c[1])))));
    expect(inFrom(sharp)).toBeLessThan(0.45);
    expect(inFrom(round)).toBeGreaterThan(1.5 * (Math.SQRT2 - 1) * 0.85);
  });
});
