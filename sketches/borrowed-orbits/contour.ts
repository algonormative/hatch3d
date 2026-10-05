/**
 * Clean iso-contours of a smooth scalar field: marching squares on a regular grid, segments joined into continuous
 * polylines by shared cell edges (no endpoint-distance guessing), and every vertex then projected exactly onto the
 * level set with Newton steps along the gradient. The projection removes the interpolation error of the linear
 * edge crossing, so the polyline vertices satisfy |f - level| ~ 1e-12 and the line shows no grid artefacts.
 */

export interface P2 { x: number; y: number }
export interface Box { xMin: number; xMax: number; yMin: number; yMax: number }

/** Edge id: horizontal edges `0 + 2 * (j * (nx + 1) + i)`, vertical edges `1 + 2 * (j * (nx + 1) + i)`; the edge starts at node (i, j). */
const hEdge = (nx: number, i: number, j: number): number => 2 * (j * (nx + 1) + i);
const vEdge = (nx: number, i: number, j: number): number => 2 * (j * (nx + 1) + i) + 1;

/**
 * Contour lines of `field` = `level` inside `box`, sampled on `cells` cells along the longer side. Closed loops
 * repeat their first point as the last. `gradient` must be the field's gradient (used only to project vertices).
 * With `tolerance` > 0 (in the field's length units) each segment whose exact midpoint lies farther than `tolerance` from it is
 * split there, so sharp tips are resolved to that chord error whatever the grid.
 */
export function contourLines(field: (x: number, y: number) => number, gradient: (x: number, y: number) => P2, level: number, box: Box, cells: number, tolerance = 0): P2[][] {
  const w = box.xMax - box.xMin, h = box.yMax - box.yMin;
  const size = Math.max(w, h) / cells;
  const nx = Math.max(2, Math.ceil(w / size)), ny = Math.max(2, Math.ceil(h / size));
  const dx = w / nx, dy = h / ny;
  const value = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const v = field(box.xMin + i * dx, box.yMin + j * dy);
    // A node on a point singularity reads as very large, never NaN.
    value[j * (nx + 1) + i] = Number.isFinite(v) ? v : 1e300;
  }
  const at = (i: number, j: number): number => value[j * (nx + 1) + i];
  const point = new Map<number, P2>();
  const crossing = (edge: number, i: number, j: number, horizontal: boolean): number => {
    if (!point.has(edge)) {
      const a = at(i, j), b = horizontal ? at(i + 1, j) : at(i, j + 1);
      const t = (level - a) / (b - a);
      const x = box.xMin + i * dx + (horizontal ? t * dx : 0), y = box.yMin + j * dy + (horizontal ? 0 : t * dy);
      point.set(edge, { x, y });
    }
    return edge;
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v00 = at(i, j), v10 = at(i + 1, j), v11 = at(i + 1, j + 1), v01 = at(i, j + 1);
    const c = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
    if (c === 0 || c === 15) continue;
    // Cell edges: bottom (j, horizontal at i), right (vertical at i + 1), top (horizontal at j + 1), left (vertical at i).
    const bottom = (): number => crossing(hEdge(nx, i, j), i, j, true);
    const right = (): number => crossing(vEdge(nx, i + 1, j), i + 1, j, false);
    const top = (): number => crossing(hEdge(nx, i, j + 1), i, j + 1, true);
    const left = (): number => crossing(vEdge(nx, i, j), i, j, false);
    switch (c) {
      case 1: case 14: link(left(), bottom()); break;
      case 2: case 13: link(bottom(), right()); break;
      case 3: case 12: link(left(), right()); break;
      case 4: case 11: link(right(), top()); break;
      case 6: case 9: link(bottom(), top()); break;
      case 7: case 8: link(left(), top()); break;
      default: {
        // Saddle (5 or 10): decide by the cell-centre value.
        const centre = (v00 + v10 + v11 + v01) / 4 >= level;
        if (c === 5) { if (centre) { link(left(), top()); link(bottom(), right()); } else { link(left(), bottom()); link(right(), top()); } }
        else if (centre) { link(left(), bottom()); link(right(), top()); } else { link(left(), top()); link(bottom(), right()); }
      }
    }
  }
  // Join: walk each chain from an end (degree 1) first, then the remaining loops.
  const seen = new Set<number>();
  const chains: number[][] = [];
  const walk = (start: number): number[] => {
    const chain = [start];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find(n => n !== prev && !seen.has(n));
      if (next === undefined) {
        // Close a loop when the chain returns to its start.
        if ((links.get(cur) ?? []).includes(start) && chain.length > 2 && prev !== start) chain.push(start);
        break;
      }
      chain.push(next);
      seen.add(next);
      prev = cur;
      cur = next;
    }
    return chain;
  };
  for (const [edge, ns] of links) if (ns.length === 1 && !seen.has(edge)) chains.push(walk(edge));
  for (const edge of links.keys()) if (!seen.has(edge)) chains.push(walk(edge));
  const project = (p: P2): P2 => {
    let { x, y } = p;
    for (let it = 0; it < 4; it++) {
      const f = field(x, y) - level;
      const g = gradient(x, y);
      const n2 = g.x * g.x + g.y * g.y;
      if (!(n2 > 1e-24) || !Number.isFinite(f)) break;
      x -= (f * g.x) / n2;
      y -= (f * g.y) / n2;
    }
    return { x, y };
  };
  /** Insert exact level-set midpoints where a segment strays more than `tolerance` from the curve. */
  const refine = (a: P2, b: P2, depth: number, out: P2[]): void => {
    if (tolerance > 0 && depth < 14) {
      const m = project({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const off = len > 0 ? Math.abs((m.x - a.x) * dy - (m.y - a.y) * dx) / len : 0;
      if (off > tolerance && len > 4 * tolerance) {
        refine(a, m, depth + 1, out);
        refine(m, b, depth + 1, out);
        return;
      }
    }
    out.push(b);
  };
  return chains.filter(c => c.length >= 2).map(chain => {
    const line = chain.map(id => project(point.get(id)!));
    if (tolerance <= 0) return line;
    const out: P2[] = [line[0]];
    for (let i = 1; i < line.length; i++) refine(line[i - 1], line[i], 0, out);
    return out;
  });
}

/** Total length of a polyline. */
export const polylineLength = (line: P2[]): number => line.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - line[i].x, p.y - line[i].y), 0);
