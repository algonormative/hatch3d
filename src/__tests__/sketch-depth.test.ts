import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import "../compositions";
import { SURFACES } from "../surfaces";
import { splitPolylineByDepth } from "../occlusion";
import { compositionRegistry } from "../compositions/registry";
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from "../sketch/depth-buffer";
import { runPipeline } from "../workers/render-pipeline";
import type { RenderRequest } from "../workers/render-worker.types";

function torusRequest(): RenderRequest {
  return {
    type: "render", id: 1, compositionKey: "single", is2d: false, width: 160, height: 160,
    resolvedValues: {}, surfaceKey: "torus", surfaceParams: SURFACES.torus.defaults,
    hatchParams: { family: "u", count: 24, samples: 40, angle: 0.7 }, currentHatchGroups: {},
    camera: { theta: 0.6, phi: 0.35, dist: 8, ortho: false, panX: 0, panY: 0, width: 160, height: 160 },
    useOcclusion: false, depthRes: 160, depthBias: 0.00001,
    exportLayout: { contentW: 0, contentH: 0, scale: 1 },
    showMesh: false, densityFilterEnabled: false, densityMax: 8, densityCellSize: 10,
  };
}

function orthographicCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function packedDepth(buffer: ReturnType<typeof renderDepthBufferCPU>, x: number, y: number): number {
  const i = (y * buffer.width + x) * 4;
  return buffer.depthData[i] / 255 + buffer.depthData[i + 1] / (255 * 255);
}

function plane(z: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(2, 2).translate(0, 0, z);
}

describe("sketch CPU depth", () => {
  it("hides torus hatch runs in Node instead of retaining all 24 paths", () => {
    const req = torusRequest();
    const plain = runPipeline(req);
    const occluded = runPipeline({ ...req, useOcclusion: true, hiddenMode: "ghost" }, renderDepthBufferCPU);
    expect(plain.svgPaths).toHaveLength(24);
    expect(occluded.layerGroups?.find(g => g.id === "hidden")?.svgPaths.length).toBeGreaterThan(0);
    expect(occluded.svgPaths).not.toEqual(plain.svgPaths);
  });

  it("retains bottom-up RGBA packing and nearest depth for indexed planes", () => {
    const camera = orthographicCamera();
    const buffer = renderDepthBufferCPU([plane(-2), plane(0)], camera, 32, 32);
    const expected = new THREE.Vector3(0, 0, 0).project(camera).z * 0.5 + 0.5;
    expect(buffer.depthData[(16 * 32 + 16) * 4 + 3]).toBe(255);
    expect(packedDepth(buffer, 16, 16)).toBeCloseTo(expected, 4);
    expect(buffer.depthData[3]).toBe(0);
    // Plane translated upward: bottom-up storage means upper image rows have higher array y.
    const top = new THREE.PlaneGeometry(1, 1).translate(0, 1, 0);
    const shifted = renderDepthBufferCPU([top], camera, 32, 32);
    expect(shifted.depthData[(22 * 32 + 16) * 4 + 3]).toBe(255);
    expect(shifted.depthData[(9 * 32 + 16) * 4 + 3]).toBe(0);
  });

  it("orders perspective faces by NDC depth and rasterizes both windings", () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 20);
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const near = plane(1);
    const far = plane(-2);
    const buffer = renderDepthBufferCPU([far, near], camera, 48, 48);
    const expected = new THREE.Vector3(0, 0, 1).project(camera).z * 0.5 + 0.5;
    expect(packedDepth(buffer, 24, 24)).toBeCloseTo(expected, 4);
    const nonindexed = near.toNonIndexed();
    const positions = nonindexed.getAttribute("position");
    for (let i = 0; i < positions.count; i += 3) {
      const x = positions.getX(i + 1), y = positions.getY(i + 1), z = positions.getZ(i + 1);
      positions.setXYZ(i + 1, positions.getX(i + 2), positions.getY(i + 2), positions.getZ(i + 2));
      positions.setXYZ(i + 2, x, y, z);
    }
    const reversed = renderDepthBufferCPU([nonindexed], camera, 48, 48);
    expect(packedDepth(reversed, 24, 24)).toBeCloseTo(expected, 4);
  });

  it("interpolates varying perspective depth in screen space", () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 20);
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const ndc = [
      new THREE.Vector3(-0.8, -0.8, new THREE.Vector3(0, 0, 2).project(camera).z),
      new THREE.Vector3(0.8, -0.8, new THREE.Vector3(0, 0, -4).project(camera).z),
      new THREE.Vector3(0, 0.8, new THREE.Vector3(0, 0, 0).project(camera).z),
    ];
    const world = ndc.map(v => v.clone().unproject(camera));
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute("position", new THREE.Float32BufferAttribute(world.flatMap(v => [v.x, v.y, v.z]), 3));
    const buffer = renderDepthBufferCPU([triangle], camera, 64, 64);
    const x = (32.5 / 64) * 2 - 1;
    const y = (32.5 / 64) * 2 - 1;
    const w2 = (y + 0.8) / 1.6;
    const w1 = ((x / 0.8) + 1 - w2) / 2;
    const w0 = 1 - w1 - w2;
    const expected = (w0 * ndc[0].z + w1 * ndc[1].z + w2 * ndc[2].z) * 0.5 + 0.5;
    expect(buffer.depthData[(32 * 64 + 32) * 4 + 3]).toBe(255);
    expect(packedDepth(buffer, 32, 32)).toBeCloseTo(expected, 4);
  });

  it("clips a triangle crossing the near plane before perspective divide", () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 20);
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute("position", new THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 0, 1, 4.5,
    ], 3));
    const buffer = renderDepthBufferCPU([triangle], camera, 48, 48);
    const covered = buffer.depthData.filter((_, i) => i % 4 === 3 && buffer.depthData[i] === 255).length;
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(48 * 48);
  });

  it("samples a sparse line crossing an occluder", () => {
    const buffer = renderDepthBufferCPU([plane(0)], orthographicCamera(), 32, 32);
    const line = densifyProjectedPolyline([
      { x: 3, y: 16, depth: 0.8 }, { x: 29, y: 16, depth: 0.8 },
    ]);
    const split = splitPolylineByDepth(line, buffer, 0.005);
    expect(split.hidden.length).toBeGreaterThan(0);
    expect(split.visible.length).toBe(2);
  });

  it("clips huge offscreen spans before bounded depth sampling", () => {
    const runs = clipProjectedPolyline([
      { x: -100_000_000, y: 16, depth: 0.8 },
      { x: 100_000_000, y: 16, depth: 0.8 },
    ], 32, 32);
    expect(runs).toHaveLength(1);
    const samples = densifyProjectedPolyline(runs[0]);
    expect(samples.length).toBeLessThanOrEqual(33);
    expect(samples[0].x).toBeCloseTo(0);
    expect(samples[samples.length - 1].x).toBeCloseTo(31);
  });

  it("drops orthographic lines behind the camera before visibility checks", () => {
    const camera = orthographicCamera();
    const behind = plane(6);
    const buffer = renderDepthBufferCPU([behind], camera, 32, 32);
    expect(buffer.depthData.every(v => v === 0)).toBe(true);
    const line = [new THREE.Vector3(-1, 0, 6), new THREE.Vector3(1, 0, 6)].map(point => {
      const ndc = point.project(camera);
      return { x: (ndc.x * 0.5 + 0.5) * 32, y: (-ndc.y * 0.5 + 0.5) * 32, depth: ndc.z * 0.5 + 0.5 };
    });
    expect(line[0].depth).toBeLessThan(0);
    expect(splitPolylineByDepth(line, buffer).visible).toHaveLength(1);
    expect(clipProjectedPolyline(line, 32, 32)).toEqual([]);
  });

  it("disposes a unified depth mesh once on success and provider failure", () => {
    const meshes: THREE.BufferGeometry[] = [];
    compositionRegistry.register({
      id: "cpu-depth-disposal-test", name: "CPU depth disposal test", category: "3d",
      layers: input => [{ surface: input.surface, params: input.surfaceParams, hatch: input.hatchParams }],
      buildDepthMesh: () => {
        const mesh = plane(0);
        meshes.push(mesh);
        vi.spyOn(mesh, "dispose");
        return mesh;
      },
    });
    const req = { ...torusRequest(), compositionKey: "cpu-depth-disposal-test", useOcclusion: true };
    runPipeline(req, renderDepthBufferCPU);
    expect(meshes[0].dispose).toHaveBeenCalledTimes(1);
    expect(() => runPipeline(req, () => { throw new Error("provider failure"); })).toThrow("provider failure");
    expect(meshes[1].dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid work and propagates explicit provider failure", () => {
    expect(() => renderDepthBufferCPU([], orthographicCamera(), 10_000, 10_000)).toThrow(RangeError);
    const bad = new THREE.BufferGeometry();
    bad.setAttribute("position", new THREE.Float32BufferAttribute([NaN, 0, 0, 0, 1, 0, 1, 0, 0], 3));
    expect(() => renderDepthBufferCPU([bad], orthographicCamera(), 32, 32)).toThrow(/not finite/);
    expect(() => runPipeline({ ...torusRequest(), useOcclusion: true }, () => {
      throw new Error("provider failure");
    })).toThrow("provider failure");
  });
});
