import type * as THREE from 'three';
import { netsFromGrid, type Sdf, type SculptMesh, type V3 } from './sculpt.ts';
import { WGSL_SMIN, wgslField } from './sculpt-wgsl.ts';

/**
 * `meshSdf` on the GPU, for a live preview (the sketch lab's worker): the field's node tree written as WGSL
 * (`sculpt-wgsl.ts`), evaluated over the whole grid in one compute pass, surface nets on the CPU from those values
 * (`netsFromGrid`), then every vertex snapped onto the field in a second pass. 32-bit floats throughout, so the mesh is
 * a close likeness of the CPU's, not the same: plotting keeps `meshSdf`.
 *
 * `gpuMesher()` resolves undefined where WebGPU is not available (Node, an old browser, a field without a node tree).
 */

// The few WebGPU calls used here (the DOM library this repo builds against has no WebGPU types).
interface Buffer { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void }
interface Device {
  createShaderModule(d: { code: string }): { getCompilationInfo?(): Promise<{ messages: { type: string; message: string; lineNum: number }[] }> };
  createComputePipeline(d: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): { getBindGroupLayout(i: number): unknown };
  createBuffer(d: { size: number; usage: number; mappedAtCreation?: boolean }): Buffer;
  createBindGroup(d: { layout: unknown; entries: { binding: number; resource: { buffer: Buffer } }[] }): unknown;
  createCommandEncoder(): {
    beginComputePass(): { setPipeline(p: unknown): void; setBindGroup(i: number, g: unknown): void; dispatchWorkgroups(x: number, y?: number): void; end(): void };
    copyBufferToBuffer(a: Buffer, ao: number, b: Buffer, bo: number, size: number): void;
    finish(): unknown;
  };
  queue: { writeBuffer(b: Buffer, offset: number, data: ArrayBufferView): void; submit(c: unknown[]): void };
}
const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const MAP_READ = 0x0001;

export interface GpuMesher {
  mesh(sdf: Sdf, lo: V3, hi: V3, step: number, transform: THREE.Matrix4): Promise<SculptMesh>;
  /** Milliseconds of the last mesh's stages, for tuning. */
  last: Record<string, number>;
}

let pending: Promise<GpuMesher | undefined> | undefined;
export function gpuMesher(): Promise<GpuMesher | undefined> {
  pending ??= (async () => {
    const gpu = (globalThis as { navigator?: { gpu?: { requestAdapter(): Promise<{ requestDevice(d?: unknown): Promise<Device> } | null> } } }).navigator?.gpu;
    if (!gpu) return undefined;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return undefined;
      return makeMesher(await adapter.requestDevice({ requiredLimits: {} }));
    } catch { return undefined; }
  })();
  return pending;
}

const SHADER = (field: string) => `${WGSL_SMIN}${field}
struct Grid { lo: vec3f, step: f32, nx: u32, ny: u32, nz: u32, count: u32 }
@group(0) @binding(0) var<uniform> g: Grid;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(256) fn grid_main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = id.x + id.y * nw.x * 256u;
  if (i >= g.count) { return; }
  let x = i % g.nx; let y = (i / g.nx) % g.ny; let z = i / (g.nx * g.ny);
  values[i] = field(g.lo + vec3f(f32(x), f32(y), f32(z)) * g.step);
}
fn grad(p: vec3f) -> vec3f {
  let h = 0.0005;
  return vec3f(field(p + vec3f(h, 0.0, 0.0)) - field(p - vec3f(h, 0.0, 0.0)),
               field(p + vec3f(0.0, h, 0.0)) - field(p - vec3f(0.0, h, 0.0)),
               field(p + vec3f(0.0, 0.0, h)) - field(p - vec3f(0.0, 0.0, h))) / (2.0 * h);
}
@group(0) @binding(2) var<storage, read_write> verts: array<vec4f>;
@compute @workgroup_size(64) fn snap_main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = id.x + id.y * nw.x * 64u;
  if (i >= g.count) { return; }
  var p = verts[2u * i].xyz;
  for (var it = 0; it < 4; it++) {
    let d = field(p);
    if (abs(d) < 1e-7) { break; }
    let n = grad(p);
    let n2 = dot(n, n);
    if (n2 < 1e-12) { break; }
    p = p - d * n / n2;
  }
  verts[2u * i] = vec4f(p, 0.0);
  verts[2u * i + 1u] = vec4f(normalize(grad(p)), 0.0);
}
`;

function makeMesher(device: Device): GpuMesher {
  const pipelines = new Map<string, { grid: ReturnType<Device['createComputePipeline']>; snap: ReturnType<Device['createComputePipeline']> }>();
  const last: Record<string, number> = {};
  const pipelinesFor = async (code: string) => {
    let p = pipelines.get(code);
    if (!p) {
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo?.();
      const errors = info?.messages.filter(m => m.type === 'error') ?? [];
      if (errors.length) throw new Error(`field shader: ${errors.map(e => `${e.lineNum}: ${e.message}`).join('; ')}`);
      p = { grid: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'grid_main' } }), snap: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'snap_main' } }) };
      pipelines.clear();
      pipelines.set(code, p);
    }
    return p;
  };
  /** Workgroups for `count` invocations of `size`, as x (≤ 65535) by y. */
  const groups = (count: number, size: number): [number, number] => { const n = Math.ceil(count / size); return n <= 65535 ? [n, 1] : [65535, Math.ceil(n / 65535)]; };
  const uniform = (lo: V3, step: number, nx: number, ny: number, nz: number, count: number) => {
    const b = new ArrayBuffer(32), f = new Float32Array(b), u = new Uint32Array(b);
    f[0] = lo[0]; f[1] = lo[1]; f[2] = lo[2]; f[3] = step; u[4] = nx; u[5] = ny; u[6] = nz; u[7] = count;
    const buf = device.createBuffer({ size: 32, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    device.queue.writeBuffer(buf, 0, f);
    return buf;
  };
  const readBack = async (src: Buffer, size: number): Promise<Float32Array> => {
    const read = device.createBuffer({ size, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, read, 0, size);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(MAP_READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap(); read.destroy();
    return out;
  };
  const run = (pipeline: ReturnType<Device['createComputePipeline']>, entries: { binding: number; resource: { buffer: Buffer } }[], wg: [number, number]) => {
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(wg[0], wg[1]); pass.end();
    device.queue.submit([enc.finish()]);
  };
  return {
    last,
    async mesh(sdf, lo, hi, step, transform) {
      if (!sdf.node) throw new Error('gpuMesher: the field carries no node tree');
      let t = performance.now();
      const mark = (name: string) => { const now = performance.now(); last[name] = Math.round(now - t); t = now; };
      const { grid, snap } = await pipelinesFor(SHADER(wgslField(sdf.node)));
      mark('compile');
      const nx = Math.ceil((hi[0] - lo[0]) / step) + 1, ny = Math.ceil((hi[1] - lo[1]) / step) + 1, nz = Math.ceil((hi[2] - lo[2]) / step) + 1;
      const count = nx * ny * nz;
      const values = device.createBuffer({ size: count * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
      const gridU = uniform(lo, step, nx, ny, nz, count);
      run(grid, [{ binding: 0, resource: { buffer: gridU } }, { binding: 1, resource: { buffer: values } }], groups(count, 256));
      const val = await readBack(values, count * 4);
      values.destroy(); gridU.destroy();
      mark('grid');
      const nets = netsFromGrid(val, nx, ny, nz, lo, step);
      mark('nets');
      const nv = nets.pos.length / 3;
      const vs = new Float32Array(nv * 8);
      for (let v = 0; v < nv; v++) { vs[8 * v] = nets.pos[3 * v]; vs[8 * v + 1] = nets.pos[3 * v + 1]; vs[8 * v + 2] = nets.pos[3 * v + 2]; }
      const verts = device.createBuffer({ size: vs.byteLength, usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
      device.queue.writeBuffer(verts, 0, vs);
      const snapU = uniform(lo, step, nx, ny, nz, nv);
      run(snap, [{ binding: 0, resource: { buffer: snapU } }, { binding: 2, resource: { buffer: verts } }], groups(nv, 64));
      const out = await readBack(verts, vs.byteLength);
      verts.destroy(); snapU.destroy();
      const pos = new Float64Array(nv * 3), nrm = new Float64Array(nv * 3);
      for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) { pos[3 * v + c] = out[8 * v + c]; nrm[3 * v + c] = out[8 * v + 4 + c]; }
      mark('snap');
      return { pos, nrm, tri: nets.tri, transform };
    },
  };
}
