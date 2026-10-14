import * as THREE from 'three';
import type { Point } from '../../../src/sketch/types.ts';
import { meshCoverage } from '../../kit/page.ts';
import { pageOf } from '../../kit/perspective.ts';
import { PAGE } from '../../kit/format.ts';

/**
 * A lover's clear pocket of paper: where the figure's surfaces cover the sheet, grown by `margin`
 * millimetres, with the narrow gaps between limbs closed and the outline rounded, so what stands
 * behind it is cut away in one smooth shape and not in a ragged one. The shape is blurred and
 * thresholded on a grid over the figures' extent.
 */
export function roundedPocket(geometries: THREE.BufferGeometry[], view: THREE.Camera, margin: number, res = 4): (p: Point) => boolean {
  // Where the figures lie on the sheet.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i += 4) {
      const q = pageOf(view, v.fromBufferAttribute(pos, i));
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  if (!Number.isFinite(x0)) return () => false;
  const pad = 2 * margin + 2;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const covered = meshCoverage(geometries, view, PAGE, margin * 0.8, res);
  const gw = Math.ceil((x1 - x0) * res), gh = Math.ceil((y1 - y0) * res);
  let grid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) grid[j * gw + i] = covered({ x: x0 + (i + 0.5) / res, y: y0 + (j + 0.5) / res }) ? 1 : 0;
  // Two box blurs of a radius a fraction of the margin round and close the shape.
  const r = Math.max(1, Math.round(margin * 0.7 * res));
  for (let pass = 0; pass < 2; pass++) {
    const rows = new Float32Array(gw * gh), out = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += i >= 0 && i < gw ? grid[j * gw + i] : 0;
      for (let i = 0; i < gw; i++) {
        rows[j * gw + i] = sum / (2 * r + 1);
        sum += (i + r + 1 < gw ? grid[j * gw + i + r + 1] : 0) - (i - r >= 0 ? grid[j * gw + i - r] : 0);
      }
    }
    for (let i = 0; i < gw; i++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += j >= 0 && j < gh ? rows[j * gw + i] : 0;
      for (let j = 0; j < gh; j++) {
        out[j * gw + i] = sum / (2 * r + 1);
        sum += (j + r + 1 < gh ? rows[(j + r + 1) * gw + i] : 0) - (j - r >= 0 ? rows[(j - r) * gw + i] : 0);
      }
    }
    grid = out;
  }
  return p => {
    const i = Math.floor((p.x - x0) * res), j = Math.floor((p.y - y0) * res);
    return i >= 0 && j >= 0 && i < gw && j < gh && grid[j * gw + i] > 0.3;
  };
}
