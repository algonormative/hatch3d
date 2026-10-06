import * as THREE from 'three';
import type { Point } from '../../src/sketch/types.ts';

/** Page-space path helpers shared by the Breach Tarot cards. */

/** Split a page path into short steps and keep the ones a test allows, carrying arclength. */
export function keepAlong(path: Point[], keep: (p: Point, at: number) => boolean, step = 0.15): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  let s = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (keep({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, s + len * (t0 + t1) / 2)) {
        if (!run.length) run.push(p0);
        run.push(p1);
      } else flush();
    }
    s += len;
  }
  flush();
  return out;
}

/** Resample so the lens can bend straight segments. */
export function densify(path: Point[], step = 0.8): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}


/**
 * A page bitmap of where some meshes cover the sheet, dilated by `halo` millimetres: the shared
 * test for marks that must stand in front of, or leave room round, 3D geometry.
 */
export function meshCoverage(geometries: THREE.BufferGeometry[], view: THREE.Camera, page: { width: number; height: number },
  halo = 0, res = 3): (p: Point) => boolean {
  const gw = Math.ceil(page.width * res), gh = Math.ceil(page.height * res);
  let grid = new Uint8Array(gw * gh);
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position'), index = g.getIndex();
    const tri = index ? index.count / 3 : pos.count / 3;
    const at = (k: number) => { v.fromBufferAttribute(pos, k).project(view); return { x: (v.x * 0.5 + 0.5) * gw, y: (-v.y * 0.5 + 0.5) * gh, z: v.z }; };
    for (let t = 0; t < tri; t++) {
      const [a, b, c] = [0, 1, 2].map(j => at(index ? index.getX(t * 3 + j) : t * 3 + j));
      if (a.z > 1 || b.z > 1 || c.z > 1) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(gw - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(gh - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) grid[y * gw + x] = 1;
      }
    }
  }
  const r = Math.round(halo * res);
  if (r > 0) {
    // Separable square dilation: rows, then columns.
    const rows = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      let last = -1e9;
      for (let x = 0; x < gw; x++) { if (grid[y * gw + x]) last = x; if (x - last <= r) rows[y * gw + x] = 1; }
      last = 1e9;
      for (let x = gw - 1; x >= 0; x--) { if (grid[y * gw + x]) last = x; if (last - x <= r) rows[y * gw + x] = 1; }
    }
    const out = new Uint8Array(gw * gh);
    for (let x = 0; x < gw; x++) {
      let last = -1e9;
      for (let y = 0; y < gh; y++) { if (rows[y * gw + x]) last = y; if (y - last <= r) out[y * gw + x] = 1; }
      last = 1e9;
      for (let y = gh - 1; y >= 0; y--) { if (rows[y * gw + x]) last = y; if (last - y <= r) out[y * gw + x] = 1; }
    }
    grid = out;
  }
  return p => {
    const x = Math.floor(p.x * res), y = Math.floor(p.y * res);
    return x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x] === 1;
  };
}
