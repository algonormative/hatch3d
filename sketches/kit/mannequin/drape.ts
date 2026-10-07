import * as THREE from 'three';
import { LOOK, TIER, perpendicular, runs, stride, tierOf, type Look, type ToneEnv } from './hatch.ts';
import type { Body } from './body.ts';
import type { ClothStroke, ViewEnv } from './tube.ts';

/**
 * Drapery: cloth hung from the shoulders (a robe) or the waist (a skirt, a tunic), falling under gravity
 * in world −y, kept clear of the body, flaring and folding toward the hem. A cloak is a robe open at the
 * front, the opening widening as it falls. The cloth is a grid of rows (top to hem) by columns (round the
 * hanging axis); folds are a seeded ripple of its radius, deepening toward the hem.
 */
export interface DrapeOptions {
  /** Where the cloth hangs from. */
  attach?: 'shoulders' | 'waist';
  /** How far it falls, as a fraction of the drop from the attach line to the lowest point of the body. */
  length?: number;
  /** Fold count round the cloth. */
  folds?: number;
  /** Fold depth at the hem, as a fraction of the radius. */
  depth?: number;
  /** Outward flare per unit fallen. */
  flare?: number;
  /** Clearance kept from the body, world units. */
  gap?: number;
  /** A cloak's front opening at the hem, in radians (0 = a closed robe). */
  open?: number;
  /** Seeded random stream, for the fold phases. */
  rng: () => number;
}

export interface Drape {
  /** rows × (cols + 1) world points; the last column repeats the first. */
  grid: THREE.Vector3[][];
  /** Whether each cell is cloth (false inside a cloak's opening). */
  cloth: boolean[][];
  /** Fold-valley columns, where crease lines run, with the row each fold appears at. */
  valleys: { col: number; from: number }[];
}

const TAU = Math.PI * 2;

/** Hang a cloth on a body. */
export function drape(b: Body, o: DrapeOptions): Drape {
  const s = b.skeleton, H = s.height;
  const attach = o.attach ?? 'shoulders';
  const axis = s.at('pelvis');
  // The body's envelope in cylindrical coordinates round the vertical through the pelvis.
  const samples: THREE.Vector3[] = [];
  // Trunk and legs only: arms pass in front of the cloth or out through it, rather than tenting it.
  const legs = b.limbs.filter(t => /^(thigh|shin|leg)_/.test(t.id));
  for (const t of [b.trunk, ...legs]) for (let i = 0; i <= 24; i++) for (let j = 0; j < 16; j++) samples.push(t.point(i / 24, j / 16));
  for (const slab of b.blocks.filter((_, i) => i % 2 === 1)) samples.push(new THREE.Vector3(slab.x, slab.y, slab.z));
  const low = Math.min(...samples.map(p => p.y));
  const top = attach === 'shoulders' ? s.at('neck').y - 0.015 * H : s.at('pelvis').y + 0.02 * H;
  const length = o.length ?? 1;
  const hem = top - (top - low) * length + 0.004 * H;
  const COLS = 120;
  const rowStep = 0.006 * H;
  const rows = Math.max(4, Math.round((top - hem) / rowStep));
  const thetaOf = (p: THREE.Vector3) => (Math.atan2(p.z - axis.z, p.x - axis.x) + TAU) % TAU;
  const env: number[][] = Array.from({ length: rows + 1 }, () => new Array(COLS).fill(0));
  const band = 0.02 * H;
  for (const p of samples) {
    const r = Math.hypot(p.x - axis.x, p.z - axis.z);
    const c = Math.floor(thetaOf(p) / TAU * COLS) % COLS;
    for (let row = 0; row <= rows; row++) {
      const y = top - (top - hem) * row / rows;
      if (Math.abs(p.y - y) > band) continue;
      for (let dc = -2; dc <= 2; dc++) {
        const cc = (c + dc + COLS) % COLS;
        env[row][cc] = Math.max(env[row][cc], r * Math.cos(dc * TAU / COLS));
      }
    }
  }
  // Fold ripple: a few seeded waves, valleys sharpened.
  const folds = o.folds ?? 11;
  const phases = Array.from({ length: 3 }, () => o.rng() * TAU);
  const ripple = (th: number) => {
    const w = Math.sin(folds * th + phases[0]) + 0.45 * Math.sin((folds * 2 - 3) * th + phases[1]) + 0.3 * Math.sin((Math.round(folds / 2) + 1) * th + phases[2]);
    return -Math.abs(w) / 1.75 + 0.5;
  };
  const gap = o.gap ?? 0.012 * H, flare = o.flare ?? 0.06, depth = o.depth ?? 0.12, open = o.open ?? 0;
  const frontTheta = thetaOf(axis.clone().add(s.axes('pelvis').z));
  const grid: THREE.Vector3[][] = [], cloth: boolean[][] = [];
  let prev: number[] | null = null;
  for (let row = 0; row <= rows; row++) {
    const f = row / rows, y = top - (top - hem) * f;
    // Clear the body; never step back in as the cloth falls; flare a little; then smooth round the hem.
    let r = env[row].map((e, c) => Math.max(e + gap, prev ? prev[c] + flare * rowStep * (0.4 + f) : e + gap, 0.08 * H));
    for (let pass = 0; pass < 3; pass++) r = r.map((v, c) => Math.max(v, (r[(c + COLS - 1) % COLS] + 2 * v + r[(c + 1) % COLS]) / 4));
    prev = r;
    const amp = depth * f ** 1.2;
    const line: THREE.Vector3[] = [], mask: boolean[] = [];
    for (let c = 0; c <= COLS; c++) {
      const th = (c % COLS) / COLS * TAU;
      const rr = r[c % COLS] * (1 + amp * ripple(th));
      line.push(new THREE.Vector3(axis.x + rr * Math.cos(th), y, axis.z + rr * Math.sin(th)));
      const d = Math.abs(((th - frontTheta + Math.PI) % TAU + TAU) % TAU - Math.PI);
      mask.push(!(open > 0 && d < 0.04 + open * f ** 0.8 / 2));
    }
    grid.push(line); cloth.push(mask);
  }
  // Valleys of the ripple: where folds crease, each starting a seeded way down.
  const valleys: { col: number; from: number }[] = [];
  for (let c = 0; c < COLS; c++) {
    const a = ripple(((c - 1 + COLS) % COLS) / COLS * TAU), m = ripple(c / COLS * TAU), z = ripple(((c + 1) % COLS) / COLS * TAU);
    if (m < a && m <= z && m < 0.2) valleys.push({ col: c, from: Math.round(rows * (0.15 + 0.45 * o.rng())) });
  }
  return { grid, cloth, valleys };
}

/** The cloth as triangles, for the depth pass. */
export function drapeMesh(d: Drape): THREE.BufferGeometry {
  const verts: number[] = [];
  for (let r = 0; r + 1 < d.grid.length; r++) for (let c = 0; c + 1 < d.grid[r].length; c++) {
    if (!d.cloth[r][c] || !d.cloth[r + 1][c] || !d.cloth[r][c + 1]) continue;
    const a = d.grid[r][c], b = d.grid[r][c + 1], e = d.grid[r + 1][c], f = d.grid[r + 1][c + 1];
    verts.push(a.x, a.y, a.z, e.x, e.y, e.z, b.x, b.y, b.z, b.x, b.y, b.z, e.x, e.y, e.z, f.x, f.y, f.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

function normalAt(d: Drape, r: number, c: number): THREE.Vector3 {
  const rows = d.grid.length, cols = d.grid[0].length - 1;
  const up = d.grid[Math.max(0, r - 1)][c], down = d.grid[Math.min(rows - 1, r + 1)][c];
  const left = d.grid[r][(c - 1 + cols) % cols], right = d.grid[r][(c + 1) % cols];
  const n = new THREE.Vector3().crossVectors(right.clone().sub(left), down.clone().sub(up)).normalize();
  // Outward: away from the hanging axis.
  const centre = d.grid[r].slice(0, cols).reduce((t, p) => t.add(p), new THREE.Vector3()).multiplyScalar(1 / cols);
  if (n.dot(d.grid[r][c].clone().sub(centre)) < 0) n.negate();
  return n;
}

/**
 * Draw a drape: hatch along the fall of the cloth, as dense as its tone; crease lines down each fold
 * valley; the neckline and hem; a cloak's opening edges; and the silhouette where the cloth turns away.
 */
export function drapeStrokes(d: Drape, env: ToneEnv & ViewEnv, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  const rows = d.grid.length, cols = d.grid[0].length - 1;
  const fam = look.family;
  // Fall hatch: column lines, tiered by tone like the pinstripes.
  for (let c = 0; c < cols; c++) {
    const tier = tierOf(c);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let r = 0; r < rows; r++) {
      const p = d.grid[r][c];
      pts.push(p);
      if (!d.cloth[r][c]) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, d.grid[Math.min(rows - 1, r + 1)][c], d.grid[r][(c + 1) % cols]));
      keep.push(c % s === 0 && env.dark(p, normalAt(d, r, c)) > TIER[tier]);
    }
    runs(pts, keep, c % 8 === 0 ? look.accent : look.cloth, look.figure, out, fam);
  }
  // Creases down the fold valleys.
  for (const v of d.valleys) {
    const pts = d.grid.slice(v.from).map(row => row[v.col]);
    const keep = pts.map((_, i) => d.cloth[v.from + i][v.col]);
    runs(pts, keep, look.crease, look.figure, out, fam);
  }
  // Neckline and hem.
  for (const r of [0, rows - 1]) runs(d.grid[r], d.cloth[r].map((m, c) => m && d.cloth[r][(c + 1) % cols]), look.edge, look.contour, out, fam);
  // A cloak's opening: the first and last cloth cells of each row, joined down the fall.
  const edgeL: THREE.Vector3[] = [], edgeR: THREE.Vector3[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (d.cloth[r][c] && !d.cloth[r][(c + 1) % cols]) edgeL.push(d.grid[r][c]);
      if (!d.cloth[r][c] && d.cloth[r][(c + 1) % cols]) edgeR.push(d.grid[r][(c + 1) % cols]);
    }
  }
  if (edgeL.length > 1) out.push({ ink: look.edge, group: look.contour, family: fam, points: edgeL });
  if (edgeR.length > 1) out.push({ ink: look.edge, group: look.contour, family: fam, points: edgeR });
  // Silhouette: where the cloth's normal turns edge-on, tracked row to row.
  for (let c0 = 0; c0 < cols; c0++) {
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let r = 0; r < rows; r++) {
      const a = normalAt(d, r, c0).dot(env.forward), b = normalAt(d, r, (c0 + 1) % cols).dot(env.forward);
      const hit = Math.sign(a) !== Math.sign(b) && d.cloth[r][c0];
      pts.push(d.grid[r][c0].clone().lerp(d.grid[r][(c0 + 1) % cols], hit ? a / (a - b) : 0));
      keep.push(hit);
    }
    runs(pts, keep, look.edge, look.contour, out, fam);
  }
  return out;
}
