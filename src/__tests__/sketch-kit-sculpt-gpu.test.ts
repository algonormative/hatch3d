import { describe, expect, it } from 'vitest';
import { smin, type SdfNode, type V3 } from '../../sketches/kit/sculpt.ts';
import { sculptHead } from '../../sketches/kit/sculpt-head.ts';
import { wgslField } from '../../sketches/kit/sculpt-wgsl.ts';

/** The node tree evaluated directly, as `sculpt-wgsl.ts` writes it for the GPU (in doubles here). */
function evalNode(n: SdfNode, p: V3): number {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
  switch (n.kind) {
    case 'constant': return n.value;
    case 'sphere': return len(sub(p, n.c)) - n.r;
    case 'ellipsoid': { const q: V3 = [(p[0] - n.c[0]) / n.r[0], (p[1] - n.c[1]) / n.r[1], (p[2] - n.c[2]) / n.r[2]]; const k0 = len(q), k1 = len([q[0] / n.r[0], q[1] / n.r[1], q[2] / n.r[2]]); return k1 === 0 ? -Math.min(...n.r) : k0 * (k0 - 1) / k1; }
    case 'capsule': { const b = sub(n.b, n.a), q = sub(p, n.a), l2 = b[0] * b[0] + b[1] * b[1] + b[2] * b[2] || 1; const t = Math.max(0, Math.min(1, (q[0] * b[0] + q[1] * b[1] + q[2] * b[2]) / l2)); return len([q[0] - t * b[0], q[1] - t * b[1], q[2] - t * b[2]]) - (n.ra + (n.rb - n.ra) * t); }
    case 'hull': return Math.max(...n.planes.map(([a, b, c, d]) => a * p[0] + b * p[1] + c * p[2] - d));
    case 'min': return Math.min(evalNode(n.a, p), evalNode(n.b, p));
    case 'smin': return smin(evalNode(n.a, p), evalNode(n.b, p), n.k);
    case 'blend': { let d = evalNode(n.base, p); for (const [part, k] of n.parts) { const e = evalNode(part, p); d = k >= 0 ? smin(d, e, k) : -smin(-d, e, -k); } return d; }
    case 'turned': { const x = sub(p, n.pivot), x1 = x[0] * n.cu - x[2] * n.su, z1 = x[0] * n.su + x[2] * n.cu; return evalNode(n.child, [n.pivot[0] + x1, n.pivot[1] + x[1] * n.ct - z1 * n.st, n.pivot[2] + x[1] * n.st + z1 * n.ct]); }
  }
}

describe('sketch kit: the head\'s field described for the GPU', () => {
  const heads = [sculptHead({ noseShape: 'planar', nose: 1.4, tilt: 0.5, turn: -0.3, chin: 1.8, ears: 1.3 }), sculptHead({ tilt: 0.2, bulb: 0.7 })];

  it('records a node tree that agrees with the field\'s closures everywhere', () => {
    let s = 3;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (const h of heads) {
      for (const f of [h.sdf, h.parts.turned, h.parts.neck]) expect(f.node).toBeDefined();
      for (let i = 0; i < 2000; i++) {
        const p: V3 = [h.lo[0] + (h.hi[0] - h.lo[0]) * rng(), h.lo[1] + (h.hi[1] - h.lo[1]) * rng(), h.lo[2] + (h.hi[2] - h.lo[2]) * rng()];
        expect(evalNode(h.sdf.node!, p)).toBeCloseTo(h.sdf(...p), 9);
      }
    }
  });

  it('writes the tree as one WGSL function with every primitive in it', () => {
    const code = wgslField(heads[0].sdf.node!);
    expect(code.startsWith('fn field(p: vec3f) -> f32 {')).toBe(true);
    expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length);
    for (const piece of ['length(', 'smin(', 'clamp(', 'max(', 'min(']) expect(code).toContain(piece);
    expect(code).not.toMatch(/NaN|Infinity|undefined/);
  });
});
