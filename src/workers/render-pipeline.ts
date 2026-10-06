/**
 * Pure render pipeline function extracted from App.tsx useMemo.
 *
 * Receives a RenderRequest, runs the full hatch → project → occlude → SVG pipeline,
 * and returns a RenderResult. Importable directly for testing (no worker needed).
 */

import * as THREE from "three";
import { SURFACES } from "../surfaces";
import { generateUVHatchLines, type HatchParams } from "../hatch";
import {
  projectPolylines,
  projectPolylinesClipped,
  polylinesToSVGPaths,
  buildSurfaceMesh,
} from "../projection";
import { renderDepthBufferOffscreen, splitPolylineByDepth } from "../occlusion";
import { clipProjectedPolyline, densifyProjectedPolyline, type DepthProvider } from "../sketch/depth-buffer";
import { extractSilhouettePolylines } from "../silhouette";
import { filterByProjectedDensity, filterByProjectedDensityIndices } from "../density";
import { compositionRegistry } from "../compositions/registry";
import {
  type Composition3DDefinition,
  type LayerConfig,
  type LayeredCompositionDefinition,
  is2DComposition,
  isLayeredComposition,
} from "../compositions/types";
import { resolveLayerInnerValues } from "../compositions/helpers";
import {
  isWasmReady,
  generateLayersWasm,
  isLayerWasmCompatible,
} from "../wasm-pipeline";
import { parseDString, convexHull, clipPolylineToConvexPolygon } from "../utils/clip";
import type {
  RenderRequest,
  RenderResult,
  CameraParams,
  LayerGroupResult,
} from "./render-worker.types";

/**
 * Reconstruct a Three.js camera from serialized params.
 */
// ── Depth-emphasis stroke width (Krbn's depthEmphasis cue) ──
// Strokes nearer than the camera target get bolder, farther ones finer:
//   scale = clamp((refDist / dist)^0.55, 0.55, 1.6)
// Per-polyline scales are quantized into bands so each band can be emitted
// as one pen layer (a plotter can't vary width along a stroke, but it can
// swap pens per band).
const DEPTH_WIDTH_EXP = 0.55;
const DEPTH_WIDTH_MIN = 0.55;
const DEPTH_WIDTH_MAX = 1.6;
const DEPTH_WIDTH_BANDS = 3;
const DEPTH_BAND_NAMES = ["width-far", "width-mid", "width-near"];

function depthWidthBand(pts: THREE.Vector3[], camPos: THREE.Vector3, refDist: number): number {
  let sum = 0;
  for (const p of pts) sum += p.distanceTo(camPos);
  const dist = Math.max(1e-6, sum / pts.length);
  const scale = Math.min(
    DEPTH_WIDTH_MAX,
    Math.max(DEPTH_WIDTH_MIN, Math.pow(refDist / dist, DEPTH_WIDTH_EXP))
  );
  return Math.min(
    DEPTH_WIDTH_BANDS - 1,
    Math.floor(((scale - DEPTH_WIDTH_MIN) / (DEPTH_WIDTH_MAX - DEPTH_WIDTH_MIN)) * DEPTH_WIDTH_BANDS)
  );
}

function depthBandScale(band: number): number {
  return DEPTH_WIDTH_MIN + ((band + 0.5) * (DEPTH_WIDTH_MAX - DEPTH_WIDTH_MIN)) / DEPTH_WIDTH_BANDS;
}

// Ghosted hidden lines (Krbn's hidden:"ghost"): faint, dashed, slightly
// thinner than visible strokes.
const GHOST_WIDTH_SCALE = 0.9;
const GHOST_OPACITY = 0.32;
const GHOST_DASH: [number, number] = [4, 3];

// Silhouette outline pen: bolder than the hatch strokes so the contour
// reads as the drawing's heavy outline. A silhouette point by definition
// grazes the surface (N·V = 0), so under occlusion it sits exactly at the
// depth-buffer value — clip it with a larger bias than hatch lines to
// avoid self-occlusion speckle.
const SILHOUETTE_WIDTH_SCALE = 1.4;
const SILHOUETTE_DEPTH_BIAS_MULT = 3;

function buildCamera(cam: CameraParams): THREE.Camera {
  const pos = new THREE.Vector3(
    cam.dist * Math.sin(cam.theta) * Math.cos(cam.phi),
    cam.dist * Math.sin(cam.phi),
    cam.dist * Math.cos(cam.theta) * Math.cos(cam.phi)
  );

  let camera: THREE.Camera;
  if (cam.ortho) {
    const aspect = cam.width / cam.height;
    const halfH = cam.dist * 0.35;
    const halfW = halfH * aspect;
    const oc = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 100);
    oc.position.copy(pos);
    camera = oc;
  } else {
    const pc = new THREE.PerspectiveCamera(45, cam.width / cam.height, 0.1, 100);
    pc.position.copy(pos);
    camera = pc;
  }
  camera.lookAt(cam.panX, cam.panY, 0);
  camera.updateMatrixWorld();
  (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).updateProjectionMatrix();
  return camera;
}

/**
 * Project a mesh's triangles into SVG path strings for the `showMesh` debug
 * overlay, near-plane clipped like every other projection pass (vault-1y2l2,
 * vault-21qrg) — unclipped, an edge straddling the eye plane flips sign under
 * the perspective divide and draws a multi-million-pixel diagonal.
 *
 * Each triangle goes in as a closed 4-point loop. Clipping splits a loop into
 * 0..N open runs, so the output is not 1:1 with the triangle list. A triangle
 * wholly in front of the near plane survives as a 4-point run whose first and
 * last points re-project the shared vertex identically, and is emitted as the
 * same closed `M…L…L…Z` path as before — output for meshes fully in front of
 * the camera (and for orthographic cameras, which are never clipped) is
 * unchanged. Exported for the regression tests.
 */
export function meshOverlayPaths(
  geo: THREE.BufferGeometry,
  camera: THREE.Camera,
  width: number,
  height: number,
): string[] {
  const idx = geo.getIndex();
  if (!idx) return [];
  const pos = geo.getAttribute("position");

  const loops: THREE.Vector3[][] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const tri = [0, 1, 2].map((j) => {
      const vi = idx.getX(i + j);
      return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
    });
    loops.push([tri[0], tri[1], tri[2], tri[0]]);
  }

  const { polylines } = projectPolylinesClipped(loops, camera, width, height);
  const xy = (p: { x: number; y: number }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

  const paths: string[] = [];
  for (const pts of polylines) {
    if (pts.length < 2) continue;
    // An uncut loop re-projects its shared first/last vertex to identical
    // points; a clipped 4-point run ends on a *different* near-plane crossing
    // than it starts on (first-vertex-behind case), so shape alone can't tell
    // them apart — point identity can.
    const whole =
      pts.length === 4 &&
      pts[0].x === pts[3].x &&
      pts[0].y === pts[3].y &&
      pts[0].depth === pts[3].depth;
    paths.push(
      whole
        ? `M${xy(pts[0])}L${xy(pts[1])}L${xy(pts[2])}Z`
        : "M" + pts.map(xy).join("L"),
    );
  }
  return paths;
}

/**
 * Apply a layer's 2D transform (pan/zoom/rotate around canvas center)
 * to a list of polylines. No-op when the transform is identity.
 */
function applyLayerTransform(
  polylines: { x: number; y: number }[][],
  transform: import("../compositions/types").LayerTransform | undefined,
  canvasW: number,
  canvasH: number,
): { x: number; y: number }[][] {
  if (!transform) return polylines;
  const tx = transform.tx ?? 0;
  const ty = transform.ty ?? 0;
  const scale = transform.scale ?? 1;
  const rotate = transform.rotate ?? 0;
  if (tx === 0 && ty === 0 && scale === 1 && rotate === 0) return polylines;
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);
  return polylines.map((pl) =>
    pl.map((p) => {
      // Translate so canvas center is the origin
      const ox = p.x - cx;
      const oy = p.y - cy;
      // Rotate
      const rx = cos * ox - sin * oy;
      const ry = sin * ox + cos * oy;
      // Scale
      const sx = rx * scale;
      const sy = ry * scale;
      // Translate back + apply pan
      return { x: sx + cx + tx, y: sy + cy + ty };
    }),
  );
}

/**
 * Bounding box over a list of polylines. Returns null when empty.
 */
/**
 * Resolve default values for an inner composition's controls,
 * then apply per-layer overrides on top.
 */
/**
 * Layered pipeline: render each inner composition independently,
 * then composite their SVG paths into per-layer groups.
 *
 * Blend modes:
 *   - "over"   — additive stacking (paths emitted as-is)
 *   - "masked" — paths clipped to the convex hull of the `maskBy` layer
 *
 * Cross-layer occlusion is intentionally out of scope for v1.
 */
function runLayeredPipeline(
  req: RenderRequest,
  comp: LayeredCompositionDefinition,
  depthProvider?: DepthProvider,
): RenderResult {
  const t0 = performance.now();

  // Honor user-edited override (visibility, order, colors, etc) when present.
  // `visible: false` layers are filtered before rendering.
  const layers = (req.layeredLayersOverride ?? comp.layers).filter(
    (l) => l.visible !== false,
  );

  const layerPolylines: { x: number; y: number }[][][] = [];

  // Pass 1: render each inner composition into raw polylines.
  for (const layer of layers) {
    const inner = compositionRegistry.get(layer.composition);
    if (!inner || isLayeredComposition(inner)) {
      // Unknown id, or nested layered (not supported in v1).
      layerPolylines.push([]);
      continue;
    }

    const innerReq: RenderRequest = {
      ...req,
      compositionKey: layer.composition,
      is2d: is2DComposition(inner),
      resolvedValues: resolveLayerInnerValues(inner, layer),
      currentHatchGroups: layer.hatchGroupOverrides ?? {},
      // Per-layer 3D camera override (no-op for 2D inners — projection
      // pipeline ignores the camera fields for them).
      camera: layer.camera ? { ...req.camera, ...layer.camera } : req.camera,
      densityFilterEnabled: false,
      showMesh: false,
      // Style-group features would be flattened away by the parse below —
      // keep inner renders plain.
      depthWidthEnabled: false,
      hiddenMode: "drop",
      silhouetteEnabled: false,
    };

    const innerResult = runPipeline(innerReq, depthProvider);
    const polys = innerResult.svgPaths
      .map(parseDString)
      .filter((p) => p.length >= 2);
    // Apply per-layer 2D transform (pan/zoom/rotate). Common across 2D and
    // 3D inners — independent of any 3D camera the inner uses.
    const transformed = applyLayerTransform(
      polys,
      layer.transform,
      req.width,
      req.height,
    );
    layerPolylines.push(transformed);
  }

  // Pass 2: apply blend modes and emit per-layer SVG paths.
  const layerGroups: LayerGroupResult[] = [];
  let totalLines = 0;
  let totalVerts = 0;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    let polys = layerPolylines[i];

    if (layer.blendMode === "masked") {
      const maskIdx = layer.maskBy ?? Math.max(0, i - 1);
      if (maskIdx !== i && layerPolylines[maskIdx]?.length) {
        const hull = convexHull(layerPolylines[maskIdx].flat());
        if (hull.length >= 3) {
          const clipped: { x: number; y: number }[][] = [];
          for (const pl of polys) clipped.push(...clipPolylineToConvexPolygon(pl, hull));
          polys = clipped;
        }
        // hull.length < 3 → fail-open: leave polys unmodified
      }
    }

    const paths = polylinesToSVGPaths(polys);
    totalLines += polys.length;
    totalVerts += polys.reduce((s, p) => s + p.length, 0);
    layerGroups.push({
      id: layer.composition,
      name: layer.name,
      color: layer.color,
      passes: layer.passes,
      svgPaths: paths,
    });
  }

  const allPaths = layerGroups.flatMap((g) => g.svgPaths);

  return {
    type: "render-result",
    id: req.id,
    svgPaths: allPaths,
    meshPaths: [],
    layerGroups,
    stats: { lines: totalLines, verts: totalVerts, paths: allPaths.length },
    durationMs: performance.now() - t0,
  };
}

export function runPipeline(req: RenderRequest, depthProvider?: DepthProvider): RenderResult {
  const t0 = performance.now();
  const comp = compositionRegistry.get(req.compositionKey)!;
  const wasmReady = isWasmReady();

  // ── Layered pipeline (multi-composition umbrella) ──
  if (isLayeredComposition(comp)) {
    return runLayeredPipeline(req, comp, depthProvider);
  }

  // ── 2D pipeline ──
  if (req.is2d && is2DComposition(comp)) {
    const input2D = { width: req.width, height: req.height, values: req.resolvedValues };
    let polylines2D =
      (comp.wasmGenerate && wasmReady ? comp.wasmGenerate(input2D) : null) ??
      comp.generate(input2D);

    if (req.densityFilterEnabled) {
      polylines2D = filterByProjectedDensity(polylines2D, {
        maxDensity: req.densityMax,
        cellSize: req.densityCellSize,
        width: req.width,
        height: req.height,
        seed: req.seed ?? 0,
      });
    }
    const paths = polylinesToSVGPaths(polylines2D);
    return {
      type: "render-result",
      id: req.id,
      svgPaths: paths,
      meshPaths: [],
      stats: {
        lines: polylines2D.length,
        verts: polylines2D.reduce((s, p) => s + p.length, 0),
        paths: paths.length,
      },
      durationMs: performance.now() - t0,
    };
  }

  // ── 3D pipeline ──
  const threeCamera = buildCamera(req.camera);

  const hatchParams: HatchParams = {
    family: req.hatchParams.family as HatchParams["family"],
    count: req.hatchParams.count,
    samples: req.hatchParams.samples,
    angle: req.hatchParams.angle,
  };

  let layers: LayerConfig[];
  let unifiedDepthMesh: THREE.BufferGeometry | null = null;
  if (req.compositionKey !== "single") {
    const comp3d = comp as Composition3DDefinition;
    const compInput = {
      surface: req.surfaceKey,
      surfaceParams: req.surfaceParams,
      hatchParams,
      values: req.resolvedValues,
    };
    layers = comp3d.layers(compInput);
    if (comp3d.buildDepthMesh) {
      unifiedDepthMesh = comp3d.buildDepthMesh(compInput);
    }
  } else {
    layers = [
      {
        surface: req.surfaceKey,
        params: req.surfaceParams,
        hatch: hatchParams,
      },
    ];
  }

  // Apply per-group hatch overrides
  for (const layer of layers) {
    if (layer.group) {
      const groupConfig = req.currentHatchGroups[layer.group];
      if (groupConfig && groupConfig.family !== "inherit") {
        layer.hatch = {
          family: groupConfig.family as HatchParams["family"],
          count: groupConfig.count,
          samples: groupConfig.samples,
          angle: groupConfig.angle,
        };
      }
    }
  }

  // Inject the request seed into layers that don't set their own, so all
  // stochastic post-processing (noise, dashes, density) is reproducible.
  const reqSeed = req.seed ?? 0;
  for (const layer of layers) {
    if (layer.hatch.seed === undefined) {
      layer.hatch = { ...layer.hatch, seed: reqSeed };
    }
  }

  const depthWidthEnabled = req.depthWidthEnabled === true;
  const hiddenGhost = req.hiddenMode === "ghost";
  const silhouetteEnabled = req.silhouetteEnabled === true;
  const camPos = threeCamera.position;
  const refDist = Math.max(
    1e-6,
    camPos.distanceTo(new THREE.Vector3(req.camera.panX, req.camera.panY, 0))
  );

  const allMeshPaths: string[] = [];
  let allPolylines2D: { x: number; y: number }[][] = [];
  // Depth-emphasis width band per polyline, aligned with allPolylines2D.
  let polyBands: number[] = [];
  // Occluded runs kept for ghosting (hiddenMode: "ghost").
  const hiddenPolylines2D: { x: number; y: number }[][] = [];
  const meshGeometries: THREE.BufferGeometry[] = [];

  // ── WASM fast path ──
  const allLayersWasmCompatible = wasmReady && layers.every(isLayerWasmCompatible);
  const surfaceDefaults: Record<string, Record<string, number>> = {};
  if (allLayersWasmCompatible) {
    for (const layer of layers) {
      if (!surfaceDefaults[layer.surface]) {
        surfaceDefaults[layer.surface] = SURFACES[layer.surface].defaults;
      }
    }
  }

  const wasmPolylines3D = allLayersWasmCompatible
    ? generateLayersWasm(layers, req.surfaceParams, surfaceDefaults)
    : null;

  // Build mesh geometries + project hatch lines
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const sf = SURFACES[layer.surface];
    const lParams = layer.params || req.surfaceParams;
    const fn = sf.fn;

    const [uSegs, vSegs] = sf.meshSegs ?? [24, 24];
    const meshGeo = buildSurfaceMesh(fn, lParams, uSegs, vSegs);
    if (layer.transform) {
      meshGeo.translate(
        layer.transform.x || 0,
        layer.transform.y || 0,
        layer.transform.z || 0
      );
    }
    meshGeometries.push(meshGeo);

    const polylines3D = wasmPolylines3D
      ? wasmPolylines3D[li]
      : generateUVHatchLines(
          (u, v, p) => {
            const pt = fn(u, v, p);
            if (layer.transform) {
              pt.x += layer.transform.x || 0;
              pt.y += layer.transform.y || 0;
              pt.z += layer.transform.z || 0;
            }
            return pt;
          },
          lParams,
          layer.hatch
        );

    // Near-plane clipping means one 3D polyline can yield 0..N projected ones,
    // so bands come off the source index, not the loop position.
    const { polylines: projected, sourceIndices } = projectPolylinesClipped(
      polylines3D,
      threeCamera,
      req.width,
      req.height
    );
    allPolylines2D.push(...projected);
    if (depthWidthEnabled) {
      for (const si of sourceIndices) {
        polyBands.push(depthWidthBand(polylines3D[si], camPos, refDist));
      }
    }

    if (req.showMesh) {
      allMeshPaths.push(...meshOverlayPaths(meshGeo, threeCamera, req.width, req.height));
    }
  }

  // ── Silhouette extraction (analytic N·V zero-set per layer) ──
  const silhouette3D: THREE.Vector3[][] = [];
  if (silhouetteEnabled) {
    for (const layer of layers) {
      const sf = SURFACES[layer.surface];
      const lParams = layer.params || req.surfaceParams;
      silhouette3D.push(
        ...extractSilhouettePolylines(sf.fn, lParams, layer.transform, camPos, {
          uRange: layer.hatch.uRange,
          vRange: layer.hatch.vRange,
        })
      );
    }
  }
  let silhouettePolylines2D: { x: number; y: number }[][] = silhouetteEnabled
    ? projectPolylines(silhouette3D, threeCamera, req.width, req.height)
    : [];

  // ── Occlusion ──
  // Prefer the composition's unified depth mesh (if provided) over the
  // per-layer meshes. Eliminates inter-face cracks that leak back hatches
  // through HLR on many-layer compositions like sentinelTerrain3D.
  const depthMeshes: THREE.BufferGeometry[] = unifiedDepthMesh
    ? [unifiedDepthMesh]
    : meshGeometries;
  const disposeDepthGeometries = () => {
    for (const geometry of new Set([...meshGeometries, ...(unifiedDepthMesh ? [unifiedDepthMesh] : [])])) {
      geometry.dispose();
    }
  };
  if (req.useOcclusion && depthMeshes.length > 0) {
    try {
      const { contentW, contentH, scale: fitScale } = req.exportLayout;
      const extRatioW = Math.max(1, contentW / (fitScale * req.width));
      const extRatioH = Math.max(1, contentH / (fitScale * req.height));
      const depthW = Math.ceil(req.depthRes * extRatioW);
      const depthH = Math.ceil(req.depthRes * extRatioH);

      // Build extended camera
      let extCamera: THREE.Camera;
      const cpos = threeCamera.position.clone();
      if (req.camera.ortho) {
        const oc = threeCamera as THREE.OrthographicCamera;
        const extOc = new THREE.OrthographicCamera(
          oc.left * extRatioW,
          oc.right * extRatioW,
          oc.top * extRatioH,
          oc.bottom * extRatioH,
          oc.near,
          oc.far
        );
        extOc.position.copy(cpos);
        extCamera = extOc;
      } else {
        const pc = threeCamera as THREE.PerspectiveCamera;
        const origHalfVFOV = ((pc.fov / 2) * Math.PI) / 180;
        const extVFOV =
          ((2 * Math.atan(Math.tan(origHalfVFOV) * extRatioH)) * 180) / Math.PI;
        const extAspect = (req.width * extRatioW) / (req.height * extRatioH);
        const extPc = new THREE.PerspectiveCamera(extVFOV, extAspect, pc.near, pc.far);
        extPc.position.copy(cpos);
        extCamera = extPc;
      }
      extCamera.lookAt(req.camera.panX, req.camera.panY, 0);
      extCamera.updateMatrixWorld();
      (extCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera).updateProjectionMatrix();

      const depthBuffer = (depthProvider ?? renderDepthBufferOffscreen)(
        depthMeshes,
        extCamera,
        depthW,
        depthH
      );

      const offsetX = (depthW - req.depthRes) / 2;
      const offsetY = (depthH - req.depthRes) / 2;

      const occludedPolylines: { x: number; y: number }[][] = [];
      const occludedBands: number[] = [];
      const toContent = (seg: { x: number; y: number }[]) =>
        seg.map((p) => ({
          x: (p.x - offsetX) * (req.width / req.depthRes),
          y: (p.y - offsetY) * (req.height / req.depthRes),
        }));

      let sampledPoints = 0;
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        const sf = SURFACES[layer.surface];
        const lParams = layer.params || req.surfaceParams;

        const polylines3D = wasmPolylines3D
          ? wasmPolylines3D[li]
          : generateUVHatchLines(
              (u, v, p) => {
                const pt = sf.fn(u, v, p);
                if (layer.transform) {
                  pt.x += layer.transform.x || 0;
                  pt.y += layer.transform.y || 0;
                  pt.z += layer.transform.z || 0;
                }
                return pt;
              },
              lParams,
              layer.hatch
            );

        const { polylines: projected, sourceIndices } = projectPolylinesClipped(
          polylines3D,
          extCamera,
          depthW,
          depthH
        );

        for (let pi = 0; pi < projected.length; pi++) {
          const band = depthWidthEnabled
            ? depthWidthBand(polylines3D[sourceIndices[pi]], camPos, refDist)
            : 0;
          const runs = depthProvider
            ? clipProjectedPolyline(projected[pi], depthW, depthH)
            : [projected[pi]];
          for (const run of runs) {
            const samples = depthProvider ? densifyProjectedPolyline(run) : run;
            if (depthProvider) {
              sampledPoints += samples.length;
              if (sampledPoints > 2_000_000) throw new RangeError("Depth sampling budget exceeded");
            }
            const { visible, hidden } = splitPolylineByDepth(
              samples,
              depthBuffer,
              req.depthBias
            );
            for (const seg of visible) {
              occludedPolylines.push(toContent(seg));
              occludedBands.push(band);
            }
            if (hiddenGhost) {
              for (const seg of hidden) hiddenPolylines2D.push(toContent(seg));
            }
          }
        }
      }

      if (silhouetteEnabled && silhouette3D.length > 0) {
        // Silhouette points graze the surface by definition (N·V = 0), so
        // they sit exactly at the depth-buffer value — clip with a larger
        // bias than hatch lines to avoid self-occlusion speckle. Hidden
        // silhouette runs are dropped (not ghosted) in v1.
        const projectedSil = projectPolylines(silhouette3D, extCamera, depthW, depthH);
        const occludedSil: { x: number; y: number }[][] = [];
        for (const pl of projectedSil) {
          const runs = depthProvider ? clipProjectedPolyline(pl, depthW, depthH) : [pl];
          for (const run of runs) {
            const samples = depthProvider ? densifyProjectedPolyline(run) : run;
            if (depthProvider) {
              sampledPoints += samples.length;
              if (sampledPoints > 2_000_000) throw new RangeError("Depth sampling budget exceeded");
            }
            const { visible } = splitPolylineByDepth(
              samples,
              depthBuffer,
              req.depthBias * SILHOUETTE_DEPTH_BIAS_MULT
            );
            for (const seg of visible) occludedSil.push(toContent(seg));
          }
        }
        silhouettePolylines2D = occludedSil;
      }

      allPolylines2D = occludedPolylines;
      polyBands = occludedBands;
    } catch (e) {
      if (depthProvider) {
        disposeDepthGeometries();
        throw e;
      }
      console.warn("Depth buffer occlusion failed:", (e as Error).message);
    }
  }

  // ── Density filter ──
  if (req.densityFilterEnabled) {
    const kept = filterByProjectedDensityIndices(allPolylines2D, {
      maxDensity: req.densityMax,
      cellSize: req.densityCellSize,
      width: req.width,
      height: req.height,
      seed: reqSeed,
    });
    allPolylines2D = kept.map((i) => allPolylines2D[i]);
    if (depthWidthEnabled) polyBands = kept.map((i) => polyBands[i]);
  }

  disposeDepthGeometries();

  const totalLines = allPolylines2D.length;
  const totalVerts = allPolylines2D.reduce((s, p) => s + p.length, 0);
  const allPaths = polylinesToSVGPaths(allPolylines2D);

  // ── Style groups: ghosted hidden runs + depth-emphasis width bands ──
  // Emitted as layerGroups (pen layers); flat svgPaths stays the visible
  // union for back-compat. Absent both features, no groups are emitted and
  // the output is identical to the pre-feature pipeline.
  let layerGroups: LayerGroupResult[] | undefined;
  if (hiddenGhost && hiddenPolylines2D.length > 0) {
    layerGroups = [
      {
        id: "hidden",
        name: "hidden",
        widthScale: GHOST_WIDTH_SCALE,
        dash: GHOST_DASH,
        opacity: GHOST_OPACITY,
        svgPaths: polylinesToSVGPaths(hiddenPolylines2D),
      },
    ];
  }
  if (depthWidthEnabled) {
    layerGroups = layerGroups ?? [];
    for (let band = 0; band < DEPTH_WIDTH_BANDS; band++) {
      const bandPolys = allPolylines2D.filter((_, i) => polyBands[i] === band);
      if (bandPolys.length === 0) continue;
      layerGroups.push({
        id: DEPTH_BAND_NAMES[band],
        name: DEPTH_BAND_NAMES[band],
        widthScale: depthBandScale(band),
        svgPaths: polylinesToSVGPaths(bandPolys),
      });
    }
  } else if (layerGroups) {
    // Ghost group alone — visible strokes still need a group of their own,
    // since consumers render either groups or the flat list, never both.
    layerGroups.push({ id: "visible", name: "visible", svgPaths: allPaths });
  }
  if (silhouetteEnabled) {
    const silhouettePaths = polylinesToSVGPaths(silhouettePolylines2D);
    if (silhouettePaths.length > 0) {
      if (!layerGroups) {
        // Silhouette group alone — visible strokes still need a group of
        // their own (same rule as the ghost-only case above).
        layerGroups = [{ id: "visible", name: "visible", svgPaths: allPaths }];
      }
      // Ordered last so it reads as the heavy outline pen on top.
      layerGroups.push({
        id: "silhouette",
        name: "silhouette",
        widthScale: SILHOUETTE_WIDTH_SCALE,
        svgPaths: silhouettePaths,
      });
    }
  }

  return {
    type: "render-result",
    id: req.id,
    svgPaths: allPaths,
    meshPaths: allMeshPaths,
    layerGroups,
    stats: { lines: totalLines, verts: totalVerts, paths: allPaths.length },
    durationMs: performance.now() - t0,
  };
}
