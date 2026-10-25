import * as THREE from 'three';

/**
 * Sculpted solids for the pen: a shape is a signed distance field (negative inside), built from a few primitives
 * blended with smooth unions, meshed by surface nets and snapped onto the field. Its lines are level sets of any
 * scalar on the surface (`isoLines`): planes through it give engraving slices that follow the form, an angle round an
 * axis gives meridians, the view's dot product with the normal gives the smooth silhouette (Hertzmann and Zorin's
 * interpolated contour). Units are the model's own; place it in the world with a matrix (`SculptMesh.transform`).
 */

/** A signed distance: negative inside the solid. Built from the primitives below, it carries its `node`. */
export type Sdf = ((x: number, y: number, z: number) => number) & { node?: SdfNode };
export type V3 = [number, number, number];

/**
 * What a field is made of, recorded by each primitive and blend beside its closure: enough to evaluate it elsewhere
 * (`sculpt-wgsl.ts` writes it as a GPU shader). The closures stay the field's definition; the node describes them.
 */
export type SdfNode =
  | { kind: 'sphere'; c: V3; r: number }
  | { kind: 'ellipsoid'; c: V3; r: V3 }
  | { kind: 'capsule'; a: V3; b: V3; ra: number; rb: number }
  | { kind: 'hull'; planes: [number, number, number, number][] }
  | { kind: 'blend'; base: SdfNode; parts: [SdfNode, number][] }
  | { kind: 'min'; a: SdfNode; b: SdfNode }
  | { kind: 'smin'; a: SdfNode; b: SdfNode; k: number }
  /** `child` read in a frame turned about `pivot`: x' = x·cu − z·su, z' = x·su + z·cu, then y'' = y·ct − z'·st, z'' = y·st + z'·ct. */
  | { kind: 'turned'; child: SdfNode; pivot: V3; ct: number; st: number; cu: number; su: number }
  | { kind: 'constant'; value: number };

/** The closure, carrying its node. */
export function tagged(f: (x: number, y: number, z: number) => number, node: SdfNode | undefined): Sdf {
  if (node) (f as Sdf).node = node;
  return f as Sdf;
}
const nodeOf = (f: Sdf): SdfNode | undefined => f.node;

/** The lesser of two fields (a hard union), recorded. */
export const minOf = (a: Sdf, b: Sdf): Sdf => tagged((x, y, z) => Math.min(a(x, y, z), b(x, y, z)), nodeOf(a) && nodeOf(b) ? { kind: 'min', a: nodeOf(a)!, b: nodeOf(b)! } : undefined);

// ── Primitives and blends ────────────────────────────────────────────

export const sphere = (c: V3, r: number): Sdf => tagged((x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r, { kind: 'sphere', c, r });

/** An ellipsoid (Quilez's bound: exact on the axes, close elsewhere). */
export function ellipsoid(c: V3, r: V3): Sdf {
  return tagged((x, y, z) => {
    const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
    const k0 = Math.hypot(px, py, pz);
    const k1 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
    return k1 === 0 ? -Math.min(...r) : k0 * (k0 - 1) / k1;
  }, { kind: 'ellipsoid', c, r });
}

/** A round cone: a capsule from `a` (radius `ra`) to `b` (radius `rb`). */
export function capsule(a: V3, b: V3, ra: number, rb = ra): Sdf {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], l2 = bx * bx + by * by + bz * bz || 1;
  return tagged((x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    const t = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / l2));
    return Math.hypot(px - t * bx, py - t * by, pz - t * bz) - (ra + (rb - ra) * t);
  }, { kind: 'capsule', a, b, ra, rb });
}

/**
 * The convex hull of a few points, sharp-edged: the greatest of its face planes' distances (exact inside and near the
 * faces, a lower bound off the edges and corners). For planar, faceted forms (a nose cut as a wedge).
 */
export function hull(points: V3[]): Sdf {
  const planes: [number, number, number, number][] = [];
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) for (let k = j + 1; k < points.length; k++) {
    const u = sub(points[j], points[i]), v = sub(points[k], points[i]);
    let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    let d = nx * points[i][0] + ny * points[i][1] + nz * points[i][2];
    const side = points.map(p => nx * p[0] + ny * p[1] + nz * p[2] - d);
    if (side.every(x => x <= 1e-9)) planes.push([nx, ny, nz, d]);
    else if (side.every(x => x >= -1e-9)) { nx = -nx; ny = -ny; nz = -nz; d = -d; planes.push([nx, ny, nz, d]); }
  }
  // Points that span no volume (fewer than four, or all on a line) bound nothing: everywhere is outside.
  if (!planes.length) return tagged(() => 1e9, { kind: 'constant', value: 1e9 });
  return tagged((x, y, z) => { let m = -Infinity; for (const [a, b, c, d] of planes) m = Math.max(m, a * x + b * y + c * z - d); return m; }, { kind: 'hull', planes });
}

/** A polynomial smooth minimum over `k` (0 = a hard union). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Shapes blended smoothly into the first: `[shape, k]` pairs, `k` < 0 carving the shape away instead. */
export function blend(base: Sdf, ...parts: [Sdf, number][]): Sdf {
  const nodes = parts.map(([s]) => nodeOf(s));
  return tagged((x, y, z) => {
    let d = base(x, y, z);
    for (const [s, k] of parts) {
      const e = s(x, y, z);
      d = k >= 0 ? smin(d, e, k) : -smin(-d, e, -k);
    }
    return d;
  }, nodeOf(base) && nodes.every(Boolean) ? { kind: 'blend', base: nodeOf(base)!, parts: parts.map(([, k], i) => [nodes[i]!, k]) } : undefined);
}

/** The field's gradient by central differences (not normalised). */
export function gradient(f: Sdf, x: number, y: number, z: number, h = 1e-4): V3 {
  return [
    (f(x + h, y, z) - f(x - h, y, z)) / (2 * h),
    (f(x, y + h, z) - f(x, y - h, z)) / (2 * h),
    (f(x, y, z + h) - f(x, y, z - h)) / (2 * h),
  ];
}

// ── The mesh ─────────────────────────────────────────────────────────

/** A meshed solid: vertex positions and unit normals (model units), triangles, and its placement in the world. */
export interface SculptMesh {
  pos: Float64Array;
  nrm: Float64Array;
  tri: Uint32Array;
  /** Model to world. */
  transform: THREE.Matrix4;
}

/**
 * How much faster than distance a field may change (1 for an exact distance). The narrow band keeps this margin over
 * the ellipsoid bound and the smooth blends, which can run a little steeper than distance.
 */
const LIPSCHITZ = 1.5;
/** Grid cells per side of a narrow-band block. */
const BLOCK = 6;

/**
 * Mesh `f` inside the box `lo`..`hi` at cell size `step` (naive surface nets: a vertex in every cell the surface
 * crosses, a quad across every crossed grid edge), each vertex then snapped onto the surface by Newton steps along the
 * gradient, its normal the field's.
 *
 * The grid is filled in a narrow band: the field is read at the middle of each block of `BLOCK` cells, and a block the
 * surface cannot reach (farther than its half-diagonal and one cell, at `LIPSCHITZ`) takes that value's sign at every
 * point without evaluating them. No cell the surface crosses touches such a point, so the mesh is the one the full grid
 * gives (`band: false` evaluates every point, for checking that).
 */
export function meshSdf(f: Sdf, lo: V3, hi: V3, step: number, transform = new THREE.Matrix4(), options: { band?: boolean } = {}): SculptMesh {
  const nx = Math.ceil((hi[0] - lo[0]) / step) + 1, ny = Math.ceil((hi[1] - lo[1]) / step) + 1, nz = Math.ceil((hi[2] - lo[2]) / step) + 1;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const val = new Float64Array(nx * ny * nz);
  const point = (i: number, j: number, k: number) => f(lo[0] + i * step, lo[1] + j * step, lo[2] + k * step);
  if (options.band === false) {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) val[at(i, j, k)] = point(i, j, k);
  } else {
    // Exact blocks first, then far blocks fill only the points no exact block has (a shared face keeps exact values).
    const exact = new Uint8Array(nx * ny * nz);
    const far: [number, number, number, number, number, number, number][] = [];
    const cellDiag = step * Math.sqrt(3);
    for (let k0 = 0; k0 < nz - 1; k0 += BLOCK) for (let j0 = 0; j0 < ny - 1; j0 += BLOCK) for (let i0 = 0; i0 < nx - 1; i0 += BLOCK) {
      const i1 = Math.min(i0 + BLOCK, nx - 1), j1 = Math.min(j0 + BLOCK, ny - 1), k1 = Math.min(k0 + BLOCK, nz - 1);
      const dc = f(lo[0] + (i0 + i1) / 2 * step, lo[1] + (j0 + j1) / 2 * step, lo[2] + (k0 + k1) / 2 * step);
      const half = 0.5 * step * Math.hypot(i1 - i0, j1 - j0, k1 - k0);
      if (Math.abs(dc) > LIPSCHITZ * (half + cellDiag)) { far.push([i0, i1, j0, j1, k0, k1, dc]); continue; }
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const v = at(i, j, k);
        if (!exact[v]) { val[v] = point(i, j, k); exact[v] = 1; }
      }
    }
    for (const [i0, i1, j0, j1, k0, k1, dc] of far) for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const v = at(i, j, k);
      if (!exact[v]) val[v] = dc;
    }
  }
  const { pos, tri } = netsFromGrid(val, nx, ny, nz, lo, step);
  const { pos: P, nrm: N } = snapToField(f, pos);
  return { pos: P, nrm: N, tri, transform };
}

/**
 * Naive surface nets over a grid of field values (`nx` × `ny` × `nz` points from `lo`, `step` apart, x fastest): a vertex
 * in every cell the surface crosses, at the mean of its edges' crossings, and a quad across every crossed grid edge.
 * The vertices are not yet on the surface (`snapToField`).
 */
export function netsFromGrid(val: ArrayLike<number>, nx: number, ny: number, nz: number, lo: V3, step: number): { pos: Float64Array; tri: Uint32Array } {
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const cell = new Int32Array((nx - 1) * (ny - 1) * nz).fill(-1);
  const cellAt = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const d = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { d[c] = val[at(i + CORNERS[c][0], j + CORNERS[c][1], k + CORNERS[c][2])]; if (d[c] < 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, m = 0;
    for (const [a, b] of EDGES) {
      if ((d[a] < 0) === (d[b] < 0)) continue;
      const t = d[a] / (d[a] - d[b]);
      sx += CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
      sy += CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
      sz += CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
      m++;
    }
    cell[cellAt(i, j, k)] = pos.length / 3;
    pos.push(lo[0] + (i + sx / m) * step, lo[1] + (j + sy / m) * step, lo[2] + (k + sz / m) * step);
  }
  const tri: number[] = [];
  const quad = (a: number, b: number, c: number, e: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    if (flip) tri.push(a, c, b, a, e, c); else tri.push(a, b, c, a, c, e);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = val[at(i, j, k)], b = val[at(i + 1, j, k)];
    if ((a < 0) !== (b < 0)) quad(cell[cellAt(i, j - 1, k - 1)], cell[cellAt(i, j, k - 1)], cell[cellAt(i, j, k)], cell[cellAt(i, j - 1, k)], a < 0);
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = val[at(i, j, k)], b = val[at(i, j + 1, k)];
    if ((a < 0) !== (b < 0)) quad(cell[cellAt(i - 1, j, k - 1)], cell[cellAt(i - 1, j, k)], cell[cellAt(i, j, k)], cell[cellAt(i, j, k - 1)], a < 0);
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = val[at(i, j, k)], b = val[at(i, j, k + 1)];
    if ((a < 0) !== (b < 0)) quad(cell[cellAt(i - 1, j - 1, k)], cell[cellAt(i, j - 1, k)], cell[cellAt(i, j, k)], cell[cellAt(i - 1, j, k)], a < 0);
  }
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

/** Each vertex moved onto the field's zero by Newton steps along its gradient, and the field's unit normal there. */
export function snapToField(f: Sdf, pos: Float64Array): { pos: Float64Array; nrm: Float64Array } {
  const P = Float64Array.from(pos), N = new Float64Array(P.length);
  for (let v = 0; v < P.length; v += 3) {
    let x = P[v], y = P[v + 1], z = P[v + 2];
    for (let it = 0; it < 4; it++) {
      const dist = f(x, y, z);
      // On the surface already (to well under a nanometre at plotter scale): the remaining steps would not move it.
      if (Math.abs(dist) < 1e-13) break;
      const g = gradient(f, x, y, z), g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 < 1e-12) break;
      x -= dist * g[0] / g2; y -= dist * g[1] / g2; z -= dist * g[2] / g2;
    }
    P[v] = x; P[v + 1] = y; P[v + 2] = z;
    const g = gradient(f, x, y, z), l = Math.hypot(...g) || 1;
    N[v] = g[0] / l; N[v + 1] = g[1] / l; N[v + 2] = g[2] / l;
  }
  return { pos: P, nrm: N };
}

/** The mesh in world units, for the depth pass. */
export function sculptGeometry(m: SculptMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(m.pos), 3));
  g.setIndex(new THREE.BufferAttribute(m.tri, 1));
  g.applyMatrix4(m.transform);
  g.computeBoundingSphere();
  return g;
}

/** A point on a surface line: where it is (model units), the surface's unit normal there, and the level it is on. */
export interface SurfacePoint { p: V3; n: V3; /** The mesh edge it lies on (vertices `a`, `b`, `t` of the way from `a`). */ a?: number; b?: number; t?: number }

/** A per-vertex scalar at a surface point, interpolated along its edge (NaN for a point that carries no edge). */
export function atPoint(values: ArrayLike<number>, sp: SurfacePoint): number {
  return sp.a === undefined || sp.b === undefined || sp.t === undefined ? NaN : values[sp.a] + sp.t * (values[sp.b] - values[sp.a]);
}
export interface IsoLine { level: number; index: number; points: SurfacePoint[] }

/**
 * The level sets of a scalar on the surface (`value`, one per vertex) at `level0 + i * spacing` for every integer i
 * the surface spans (or only at the `only` levels), each chained into polylines along the triangles' crossed edges.
 * `index` is i, for thinning line by line. With `phase` an angle-like scalar that wraps every `period` is added to it,
 * unwrapped within each triangle: an angle round an axis added to a distance from it gives a spiral (the lines break
 * where the angle wraps, one piece per turn).
 */
export function isoLines(m: SculptMesh, value: Float64Array, spacing: number, level0 = 0, only?: number[], phase?: { values: Float64Array; period: number }): IsoLine[] {
  const { pos, nrm, tri } = m;
  const f = (v: number) => value[v];
  const byLevel = new Map<number, [number, number, number, number, number, number][]>();
  if (!only && !(spacing > 0)) throw new Error('isoLines: spacing must be positive');
  // Nudged off every vertex so no level runs through one; the levels a triangle spans are chosen by the nudged level too.
  const levelOf = (i: number) => (only ? only[i] : level0 + i * spacing) + 1e-9;
  const levelsOf = (lo: number, hi: number): number[] => {
    if (only) return only.map((_, i) => i).filter(i => levelOf(i) > lo && levelOf(i) < hi);
    const out: number[] = [];
    for (let i = Math.ceil((lo - 1e-9 - level0) / spacing); levelOf(i) < hi; i++) if (levelOf(i) > lo) out.push(i);
    return out;
  };
  const near = (x: number, to: number) => (phase ? x - phase.period * Math.round((x - to) / phase.period) : x);
  const ph = (v: number) => (phase ? phase.values[v] : 0);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const pa = ph(a), fa = f(a) + pa, fb = f(b) + near(ph(b), pa), fc = f(c) + near(ph(c), pa);
    for (const i of levelsOf(Math.min(fa, fb, fc), Math.max(fa, fb, fc))) {
      const L = levelOf(i), cross: [number, number][] = [];
      const ts: number[] = [];
      for (const [u, v, fu, fv] of [[a, b, fa, fb], [b, c, fb, fc], [c, a, fc, fa]] as const) {
        if ((fu - L) * (fv - L) >= 0) continue;
        const tt = (L - fu) / (fv - fu);
        if (u < v) { cross.push([u, v]); ts.push(tt); } else { cross.push([v, u]); ts.push(1 - tt); }
      }
      if (cross.length !== 2) continue;
      const list = byLevel.get(i) ?? [];
      list.push([cross[0][0], cross[0][1], cross[1][0], cross[1][1], ts[0], ts[1]]);
      byLevel.set(i, list);
    }
  }
  const out: IsoLine[] = [];
  const point = (u: number, v: number, t: number): SurfacePoint => {
    const p: V3 = [0, 0, 0], q: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) { p[k] = pos[3 * u + k] + t * (pos[3 * v + k] - pos[3 * u + k]); q[k] = nrm[3 * u + k] + t * (nrm[3 * v + k] - nrm[3 * u + k]); }
    const l = Math.hypot(...q) || 1;
    return { p, n: [q[0] / l, q[1] / l, q[2] / l], a: u, b: v, t };
  };
  for (const [i, segs] of byLevel) {
    const L = levelOf(i);
    // Where each crossed edge is crossed (the fraction from its lower vertex), from the segment that found it.
    const tOf = new Map<number, number>();
    const key = (u: number, v: number) => u * 4294967296 + v;
    const ends = new Map<number, number[]>();
    segs.forEach(([a, b, c, d, t1, t2], s) => {
      tOf.set(key(a, b), t1); tOf.set(key(c, d), t2);
      for (const k of [key(a, b), key(c, d)]) { const l = ends.get(k) ?? []; l.push(s); ends.set(k, l); }
    });
    const used = new Uint8Array(segs.length);
    const walk = (s: number, from: number): number[] => {
      const keys: number[] = [];
      let cur = s, k = from;
      while (cur >= 0 && !used[cur]) {
        used[cur] = 1;
        const [a, b, c, d] = segs[cur];
        const k1 = key(a, b), k2 = key(c, d), next = k === k1 ? k2 : k1;
        keys.push(next);
        k = next;
        cur = (ends.get(next) ?? []).find(o => !used[o]) ?? -1;
      }
      return keys;
    };
    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      const [a, b, c, d] = segs[s];
      const forward = walk(s, key(a, b));
      used[s] = 0;
      const back = walk(s, key(c, d));
      used[s] = 1;
      const keys = [...back.reverse(), ...forward];
      const pts = keys.map(k => point(Math.floor(k / 4294967296), k % 4294967296, tOf.get(k)!));
      if (pts.length >= 2) out.push({ level: L, index: i, points: pts });
    }
  }
  return out;
}

/** A scalar per vertex. */
export function perVertex(m: SculptMesh, fn: (p: V3, n: V3, vertex: number) => number): Float64Array {
  const out = new Float64Array(m.pos.length / 3);
  for (let v = 0; v < out.length; v++) out[v] = fn([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]], [m.nrm[3 * v], m.nrm[3 * v + 1], m.nrm[3 * v + 2]], v);
  return out;
}

/** The model-space eye for a world-space eye. */
export function modelPoint(m: SculptMesh, world: THREE.Vector3): V3 {
  const q = world.clone().applyMatrix4(m.transform.clone().invert());
  return [q.x, q.y, q.z];
}

/**
 * The smooth silhouette seen from `eye` (model units): the zero set of the normal's dot product with the direction
 * to the eye. It includes the contour's hidden stretches; test them against the depth pass.
 */
export function contourLines(m: SculptMesh, eye: V3): IsoLine[] {
  const g = perVertex(m, (p, n) => {
    const dx = eye[0] - p[0], dy = eye[1] - p[1], dz = eye[2] - p[2], l = Math.hypot(dx, dy, dz);
    return (n[0] * dx + n[1] * dy + n[2] * dz) / l;
  });
  return isoLines(m, g, 1, 0, [0]);
}

/** A surface line in world units. */
export function toWorld(m: SculptMesh, pts: SurfacePoint[]): THREE.Vector3[] {
  return pts.map(q => new THREE.Vector3(...q.p).applyMatrix4(m.transform));
}

// ── Plates ───────────────────────────────────────────────────────────

/**
 * Seeds scattered over the mesh, no two nearer than `minDist` (model units, measured in `frame`): the `fixed` first,
 * then vertices in a seeded order wherever `keep` allows and the spacing does. For plates (`platesOn`).
 */
export function scatterOn(m: SculptMesh, minDist: number, rng: () => number, keep: (p: V3, vertex: number) => boolean, fixed: V3[] = [], frame: (p: V3) => V3 = p => p): V3[] {
  const out = fixed.map(frame);
  const count = m.pos.length / 3, order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (const v of order) {
    const p: V3 = [m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]];
    if (!keep(p, v)) continue;
    const q = frame(p);
    if (out.every(s => Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]) >= minDist)) out.push(q);
  }
  return out;
}

/**
 * The surface cut into plates round `seeds` (in `frame`, as `scatterOn` gives them): which seed a point is nearest, and
 * its `gap`, how much nearer that seed is than the next. A seam runs where the gap is 0, so the level set of the gap
 * at a small value draws each seam as a groove of two lines, and lines kept where the gap is larger stop short of it.
 * Per vertex (`plate`, `second`, `gap`) for `isoLines`, and `at` for any point.
 */
export function platesOn(m: SculptMesh, seeds: V3[], frame: (p: V3) => V3 = p => p): { plate: Int32Array; second: Int32Array; gap: Float64Array; at: (p: V3) => { plate: number; gap: number } } {
  const at = (p: V3) => {
    const q = frame(p);
    let a = -1, b = -1, da = Infinity, db = Infinity;
    seeds.forEach((s, i) => {
      const d = Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]);
      if (d < da) { db = da; b = a; da = d; a = i; } else if (d < db) { db = d; b = i; }
    });
    return { plate: a, second: b, gap: db - da };
  };
  const count = m.pos.length / 3;
  const plate = new Int32Array(count), second = new Int32Array(count), gap = new Float64Array(count);
  for (let v = 0; v < count; v++) {
    const r = at([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]]);
    plate[v] = r.plate; second[v] = r.second; gap[v] = r.gap;
  }
  return { plate, second, gap, at };
}
