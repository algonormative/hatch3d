import type { SdfNode, V3 } from './sculpt.ts';

/**
 * A field's node tree (`sculpt.ts`) written as a WGSL function `fn <name>(p: vec3f) -> f32`, the same arithmetic as
 * its closures in 32-bit floats: for a GPU preview (`sculpt-gpu.ts`), never for plotting, which keeps the closures.
 */
export function wgslField(node: SdfNode, name = 'field'): string {
  const lines: string[] = [];
  let n = 0;
  const v = () => `v${n++}`;
  const f = (x: number) => { const s = Number.isInteger(x) ? `${x}.0` : String(x); return x < 0 ? `(${s})` : s; };
  const v3 = (p: V3) => `vec3f(${f(p[0])}, ${f(p[1])}, ${f(p[2])})`;
  /** Emit `node` at point variable `p`; the name of the variable holding its value. */
  const emit = (nd: SdfNode, p: string): string => {
    const out = v();
    switch (nd.kind) {
      case 'constant': lines.push(`let ${out} = ${f(nd.value)};`); break;
      case 'sphere': lines.push(`let ${out} = length(${p} - ${v3(nd.c)}) - ${f(nd.r)};`); break;
      case 'ellipsoid': {
        const q = v(), k0 = v(), k1 = v(), r = v3(nd.r);
        lines.push(`let ${q} = (${p} - ${v3(nd.c)}) / ${r};`, `let ${k0} = length(${q});`, `let ${k1} = length(${q} / ${r});`,
          `let ${out} = select(${k0} * (${k0} - 1.0) / ${k1}, ${f(-Math.min(...nd.r))}, ${k1} == 0.0);`);
        break;
      }
      case 'capsule': {
        const b = [nd.b[0] - nd.a[0], nd.b[1] - nd.a[1], nd.b[2] - nd.a[2]] as V3;
        const l2 = b[0] * b[0] + b[1] * b[1] + b[2] * b[2] || 1;
        const q = v(), t = v();
        lines.push(`let ${q} = ${p} - ${v3(nd.a)};`, `let ${t} = clamp(dot(${q}, ${v3(b)}) / ${f(l2)}, 0.0, 1.0);`,
          `let ${out} = length(${q} - ${t} * ${v3(b)}) - (${f(nd.ra)} + ${f(nd.rb - nd.ra)} * ${t});`);
        break;
      }
      case 'hull': {
        lines.push(`var ${out} = -3.0e38;`);
        for (const [a, b, c, d] of nd.planes) lines.push(`${out} = max(${out}, dot(${p}, ${v3([a, b, c])}) - ${f(d)});`);
        break;
      }
      case 'min': { const a = emit(nd.a, p), b = emit(nd.b, p); lines.push(`let ${out} = min(${a}, ${b});`); break; }
      case 'smin': { const a = emit(nd.a, p), b = emit(nd.b, p); lines.push(`let ${out} = smin(${a}, ${b}, ${f(nd.k)});`); break; }
      case 'blend': {
        const base = emit(nd.base, p);
        lines.push(`var ${out} = ${base};`);
        for (const [part, k] of nd.parts) {
          const e = emit(part, p);
          lines.push(k >= 0 ? `${out} = smin(${out}, ${e}, ${f(k)});` : `${out} = -smin(-${out}, ${e}, ${f(-k)});`);
        }
        break;
      }
      case 'turned': {
        const x = v(), x1 = v(), z1 = v(), q = v();
        lines.push(`let ${x} = ${p} - ${v3(nd.pivot)};`, `let ${x1} = ${x}.x * ${f(nd.cu)} - ${x}.z * ${f(nd.su)};`, `let ${z1} = ${x}.x * ${f(nd.su)} + ${x}.z * ${f(nd.cu)};`,
          `let ${q} = vec3f(${f(nd.pivot[0])} + ${x1}, ${f(nd.pivot[1])} + ${x}.y * ${f(nd.ct)} - ${z1} * ${f(nd.st)}, ${f(nd.pivot[2])} + ${x}.y * ${f(nd.st)} + ${z1} * ${f(nd.ct)});`);
        const c = emit(nd.child, q);
        lines.push(`let ${out} = ${c};`);
        break;
      }
    }
    return out;
  };
  const result = emit(node, 'p');
  return `fn ${name}(p: vec3f) -> f32 {\n  ${lines.join('\n  ')}\n  return ${result};\n}\n`;
}

/** The smooth minimum the fields' shaders share (as `smin` in `sculpt.ts`). */
export const WGSL_SMIN = `fn smin(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.0) { return min(a, b); }
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
`;
