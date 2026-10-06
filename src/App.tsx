import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useHistory } from "./hooks/useHistory";
import { useRenderWorker } from "./hooks/useRenderWorker";
import type { CameraParams, LayerGroupResult } from "./workers/render-worker.types";
import { SURFACES } from "./surfaces";
import {
  compositionRegistry,
  type Composition3DDefinition,
  getControlDefaults,
  getMacroDefaults,
  resolveValues,
  is2DComposition,
  isLayeredComposition,
} from "./compositions";
import type { LayeredLayer } from "./compositions/types";
import { LayerPanel } from "./components/LayerPanel";
import { btnStyle, tagStyle } from "./components/styles";
import { Section } from "./components/Section";
import { Slider } from "./components/Slider";
import { Toggle } from "./components/Toggle";
import { CompositionControls } from "./components/CompositionControls";
import { ThreeDControls } from "./components/ThreeDControls";
import { CompositionBrowser } from "./components/CompositionBrowser";
import { ExportModal } from "./components/ExportModal";
import { PresetMenu } from "./components/PresetMenu";
import { RenderButton } from "./components/RenderButton";
import type { HatchGroupConfig } from "./components/HatchGroupControls.types";
import { configHash } from "./utils/config-hash";
import { exportPng, PNG_THEMES } from "./utils/export-png";
import { clipSVGPath, type Rect } from "./utils/clip";
import { PAPER_SIZES as PAGE_SIZES, BORDER_STYLES, DOUBLE_BORDER_INSET, generateBorderPaths } from "./utils/page-finishing";
import { buildLayeredSVGContent, type ExportLayout } from "./scene/svg-output";
import { useHashRoute } from "./hooks/useHashRoute";
import {
  getPresetsForComposition,
  saveUserPreset,
  deleteUserPreset,
  buildLayeredPresetValues,
} from "./compositions/presets";
import type { CompositionPreset } from "./compositions/types";

const THEME_KEY = "hatch3d-theme";
const STORAGE_KEY = "hatch3d-state";
const COMP_VALUES_KEY = "hatch3d-comp-values";
const MACRO_VALUES_KEY = "hatch3d-macro-values";
const HATCH_GROUPS_KEY = "hatch3d-hatch-groups";
const LAYERED_LAYERS_KEY = "hatch3d-layered-layers";

type HatchFamily = "u" | "v" | "diagonal" | "rings" | "hex" | "crosshatch" | "spiral";

const DEFAULTS = {
  surfaceKey: "hyperboloid",
  compositionKey: "single",
  controlsPanel: "inline" as "inline" | "side",
  paramA: 0.5,
  paramB: 0.5,
  paramC: 0.5,
  paramD: 0.5,
  hatchFamily: "u" as HatchFamily,
  hatchCount: 30,
  hatchSamples: 50,
  hatchAngle: 0.7,
  useOcclusion: false,
  depthRes: 512,
  depthBias: 0.001,
  camTheta: 0.6,
  camPhi: 0.35,
  camDist: 8,
  camOrtho: false,
  panX: 0,
  panY: 0,
  strokeWidth: 0.5,
  showMesh: false,
  pageSize: "tabloid",
  orientation: "landscape" as "landscape" | "portrait",
  margin: 15,
  borderEnabled: false,
  borderStyle: "simple" as "simple" | "double" | "ticked" | "cropmarks",
  densityFilterEnabled: true,
  densityMax: 20,
  densityCellSize: 40,
  seed: 0,
  depthWidthEnabled: false,
  hiddenGhost: false,
  silhouetteEnabled: false,
};

/** Load saved state, keeping only keys that exist in DEFAULTS with matching type. */
function loadState(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null) throw 0;
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) {
        (out as Record<string, unknown>)[k] = saved[k];
      }
    }
    return out;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return DEFAULTS;
  }
}

const INITIAL = loadState();

/** Everything the browser download path needs to serialize an export. */
export interface BrowserExportInput {
  /** Flat (non-layered) render output, in viewport px. */
  svgPaths: string[];
  /** Layered render output, in viewport px. Non-empty wins over `svgPaths`. */
  layerGroups?: LayerGroupResult[];
  layout: ExportLayout;
  margin: number;
  /** Extra inset applied inside the margin (double-border style). */
  clipInset: number;
  strokeWidth: number;
  /** Decorative border paths, already in page-mm. */
  borderPaths: string[];
}

/** Convert a viewport-px dash length to page-mm, at the export's 2dp precision. */
function toDashMm(px: number, scale: number): number {
  return Number((px * scale).toFixed(2));
}

/**
 * The border as a pen layer for layered exports.
 *
 * It must be a real, labelled layer group — an anonymous top-level <g> is
 * imported by vpype as a phantom unlabelled layer N+1 and ignored entirely by
 * Inkscape's layer UI. Paths are already page-mm and the layered browser export
 * serializes under an identity layout, so they need no transform or width
 * scaling; the shared serializer leaves it unclipped so ticks/cropmarks that
 * reach past the margin survive.
 */
function borderLayerGroup(borderPaths: string[]): LayerGroupResult[] {
  if (borderPaths.length === 0) return [];
  return [{ id: "border", name: "border", svgPaths: borderPaths }];
}

/**
 * The preview border for the NON-layered export, emitted as its own top-level
 * group in page-mm space (that output has no layer convention at all).
 */
function borderGroupSVG(borderPaths: string[], strokeWidth: number): string {
  if (borderPaths.length === 0) return "";
  return `\n  <g fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">\n    ${borderPaths
    .map((d) => `<path d="${d}"/>`)
    .join("\n    ")}\n  </g>`;
}

/**
 * Build the SVG string the browser downloads (also the source for PNG export
 * and the print queue).
 *
 * Unlike the CLI, the browser bakes the page transform into the path data
 * (`clipSVGPath` applies translate+scale and clips to the margin rect) so that
 * off-paper geometry never reaches the plotter. Layered exports then hand the
 * baked paths to the *shared* serializer in `scene/svg-output.ts` under an
 * identity layout, so browser downloads carry the same Inkscape layer
 * convention (`xmlns:inkscape`, top-level `inkscape:groupmode="layer"` groups,
 * sequential `N-name` labels, `data-passes`) that `render --scene` emits and
 * vpype's `read_multilayer_svg` needs.
 */
// Exported for src/__tests__/app-export-layers.test.ts — a pure serializer that
// lives next to the component that owns the export UI. Fast refresh only
// complains about the extra export; the function holds no component state.
// eslint-disable-next-line react-refresh/only-export-components
export function buildBrowserExportSVG(input: BrowserExportInput): string {
  const { svgPaths, layerGroups, layout, margin, clipInset, strokeWidth, borderPaths } = input;
  const { pageW, pageH, contentW, contentH, scale, cx, cy } = layout;

  // Clip paths to the margin boundary so plotters don't draw off-paper
  const clipRect: Rect = {
    xMin: margin + clipInset,
    yMin: margin + clipInset,
    xMax: margin + contentW - clipInset,
    yMax: margin + contentH - clipInset,
  };
  const transform = { cx, cy, scale };

  if (layerGroups && layerGroups.length > 0) {
    // Bake the page transform into the path data, then serialize with the
    // shared builder under an identity transform (paths are already page-mm).
    const bakedGroups: LayerGroupResult[] = layerGroups
      .map((lg) => ({
        ...lg,
        svgPaths: lg.svgPaths.flatMap((d) => clipSVGPath(d, transform, clipRect)),
        // Dash lengths are viewport px; baked paths are page-mm.
        dash: lg.dash
          ? ([toDashMm(lg.dash[0], scale), toDashMm(lg.dash[1], scale)] as [number, number])
          : undefined,
      }))
      .filter((lg) => lg.svgPaths.length > 0);

    const bakedLayout: ExportLayout = {
      pageW,
      pageH,
      contentW: contentW - clipInset * 2,
      contentH: contentH - clipInset * 2,
      scale: 1,
      cx: 0,
      cy: 0,
    };
    return buildLayeredSVGContent(
      bakedGroups,
      bakedLayout,
      margin + clipInset,
      strokeWidth,
      borderLayerGroup(borderPaths),
    );
  }

  const clippedPaths = svgPaths.flatMap((d) => clipSVGPath(d, transform, clipRect));
  const body = `    ${clippedPaths.map((d) => `<path d="${d}"/>`).join("\n    ")}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}mm" height="${pageH}mm" viewBox="0 0 ${pageW} ${pageH}">
  <g fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
${body}
  </g>${borderGroupSVG(borderPaths, strokeWidth)}
</svg>`;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width] = useState(800);
  const [height] = useState(800);

  // Shape
  const [surfaceKey, setSurfaceKey] = useState(INITIAL.surfaceKey);
  const [compositionKey, setCompositionKey] = useState(
    compositionRegistry.has(INITIAL.compositionKey) ? INITIAL.compositionKey : DEFAULTS.compositionKey,
  );

  // Hash-based routing: sync compositionKey with URL hash
  useHashRoute(
    compositionKey,
    setCompositionKey,
    (key: string) => compositionRegistry.has(key),
    DEFAULTS.compositionKey,
  );

  // Surface params (generic sliders mapped to surface)
  const [paramA, setParamA] = useState(INITIAL.paramA);
  const [paramB, setParamB] = useState(INITIAL.paramB);
  const [paramC, setParamC] = useState(INITIAL.paramC);
  const [paramD, setParamD] = useState(INITIAL.paramD);

  // Hatch
  const [hatchFamily, setHatchFamily] = useState(INITIAL.hatchFamily);
  const [hatchCount, setHatchCount] = useState(INITIAL.hatchCount);
  const [hatchSamples, setHatchSamples] = useState(INITIAL.hatchSamples);
  const [hatchAngle, setHatchAngle] = useState(INITIAL.hatchAngle);

  // Occlusion
  const [useOcclusion, setUseOcclusion] = useState(INITIAL.useOcclusion);
  const [depthRes, setDepthRes] = useState(INITIAL.depthRes);
  const [depthBias, setDepthBias] = useState(INITIAL.depthBias);

  // Camera
  const [camTheta, setCamTheta] = useState(INITIAL.camTheta);
  const [camPhi, setCamPhi] = useState(INITIAL.camPhi);
  const [camDist, setCamDist] = useState(INITIAL.camDist);
  const [camOrtho, setCamOrtho] = useState(INITIAL.camOrtho);
  const [panX, setPanX] = useState(INITIAL.panX);
  const [panY, setPanY] = useState(INITIAL.panY);

  // Display
  const [strokeWidth, setStrokeWidth] = useState(INITIAL.strokeWidth);
  const [showMesh, setShowMesh] = useState(INITIAL.showMesh);

  // Stroke style (Krbn-inspired): seed, depth-emphasis width, ghost hidden
  const [seed, setSeed] = useState(INITIAL.seed);
  const [depthWidthEnabled, setDepthWidthEnabled] = useState(INITIAL.depthWidthEnabled);
  const [hiddenGhost, setHiddenGhost] = useState(INITIAL.hiddenGhost);
  const [silhouetteEnabled, setSilhouetteEnabled] = useState(INITIAL.silhouetteEnabled);

  // Export settings
  const [pageSize, setPageSize] = useState(INITIAL.pageSize);
  const [orientation, setOrientation] = useState(INITIAL.orientation);
  const [margin, setMargin] = useState(INITIAL.margin);
  const [borderEnabled, setBorderEnabled] = useState(INITIAL.borderEnabled);
  const [borderStyle, setBorderStyle] = useState(INITIAL.borderStyle);

  // Density filter
  const [densityFilterEnabled, setDensityFilterEnabled] = useState(INITIAL.densityFilterEnabled);
  const [densityMax, setDensityMax] = useState(INITIAL.densityMax);
  const [densityCellSize, setDensityCellSize] = useState(INITIAL.densityCellSize);

  // Layout: controls panel mode
  const [controlsPanel, setControlsPanel] = useState(INITIAL.controlsPanel);

  // Per-composition control values
  const [compValues, setCompValues] = useState<Record<string, Record<string, unknown>>>(() => {
    try {
      const raw = localStorage.getItem(COMP_VALUES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [macroValues, setMacroValues] = useState<Record<string, Record<string, number>>>(() => {
    try {
      const raw = localStorage.getItem(MACRO_VALUES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  // Per-composition hatch group overrides: { compositionKey: { groupName: HatchGroupConfig } }
  const [hatchGroupValues, setHatchGroupValues] = useState<Record<string, Record<string, HatchGroupConfig>>>(() => {
    try {
      const raw = localStorage.getItem(HATCH_GROUPS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  // Per-composition edited layer stack for layered compositions:
  // { compositionKey: LayeredLayer[] }. Replaces the static `layers`
  // baked into the composition definition when present.
  const [layeredLayersByKey, setLayeredLayersByKey] = useState<Record<string, LayeredLayer[]>>(() => {
    try {
      const raw = localStorage.getItem(LAYERED_LAYERS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, LayeredLayer[]>;
      // Lazy migration: legacy saved state has no __id; assign one on
      // first read so reorder + key-stability work.
      for (const key of Object.keys(parsed)) {
        const arr = parsed[key];
        if (!Array.isArray(arr)) continue;
        for (const layer of arr) {
          if (layer && layer.__id === undefined) layer.__id = crypto.randomUUID();
        }
      }
      return parsed;
    } catch { return {}; }
  });

  // Responsive: detect narrow viewport (debounced)
  const [isNarrow, setIsNarrow] = useState(typeof window !== "undefined" && window.innerWidth < 1200);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIsNarrow(window.innerWidth < 1200), 150);
    };
    window.addEventListener("resize", handler);
    return () => { window.removeEventListener("resize", handler); clearTimeout(timer); };
  }, []);

  // WASM is now initialized inside the render worker

  // Theme toggle (auto / light / dark)
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  });
  useEffect(() => {
    if (theme === "auto") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme(prev => prev === "auto" ? "light" : prev === "light" ? "dark" : "auto");
  }, []);

  // Current composition helpers — use registry (fall back if stale localStorage/hash)
  const comp = compositionRegistry.get(compositionKey)
    ?? compositionRegistry.get(DEFAULTS.compositionKey)!;
  const is2d = is2DComposition(comp);
  const isLayered = isLayeredComposition(comp);

  // For layered compositions: user-edited layer stack, falling back to the
  // composition's static definition when no overrides exist yet.
  // Deps memoize on `compositionKey`, NOT `comp` — comp's reference flips
  // on every parent re-render but compositionKey is stable, keeping the
  // generated __ids stable across renders.
  const currentLayers: LayeredLayer[] = useMemo(() => {
    if (!isLayered) return [];
    const override = layeredLayersByKey[compositionKey];
    const source = override ?? (comp as { layers?: LayeredLayer[] }).layers ?? [];
    return source.map((l) => (l.__id ? l : { ...l, __id: crypto.randomUUID() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLayered, compositionKey, layeredLayersByKey]);

  // Effective render mode: a layered composition that pulls in any
  // manual-mode inner (e.g. differentialGrowth, reactionDiffusion) is
  // promoted to manual itself — auto-rendering on every slider tick
  // would re-run the slow inner pipeline and hang the worker.
  const effectiveRenderMode: "immediate" | "debounced" | "manual" = useMemo(() => {
    if (!isLayered) return comp.renderMode ?? "immediate";
    for (const layer of currentLayers) {
      const inner = compositionRegistry.get(layer.composition);
      if (inner?.renderMode === "manual") return "manual";
    }
    return comp.renderMode ?? "immediate";
  }, [isLayered, comp, currentLayers]);

  const setLayers = useCallback(
    (layers: LayeredLayer[]) => {
      setLayeredLayersByKey((prev) => ({ ...prev, [compositionKey]: layers }));
    },
    [compositionKey],
  );

  const resetLayers = useCallback(() => {
    setLayeredLayersByKey((prev) => {
      const next = { ...prev };
      delete next[compositionKey];
      return next;
    });
  }, [compositionKey]);
  const controlDefaults = useMemo(() => getControlDefaults(comp.controls), [comp.controls]);
  const macroDefaults = useMemo(() => getMacroDefaults(comp.macros), [comp.macros]);

  const compSlice = compValues[compositionKey];
  const macroSlice = macroValues[compositionKey];
  const currentValues = useMemo(
    () => ({ ...controlDefaults, ...compSlice }),
    [controlDefaults, compSlice],
  );
  const currentMacros = useMemo(
    () => ({ ...macroDefaults, ...macroSlice }),
    [macroDefaults, macroSlice],
  );

  const setCompValue = useCallback((key: string, val: unknown) => {
    setCompValues(prev => {
      const existing = prev[compositionKey];
      if (existing && existing[key] === val) return prev;
      return { ...prev, [compositionKey]: { ...existing, [key]: val } };
    });
  }, [compositionKey]);

  const setMacroValue = useCallback((key: string, val: number) => {
    setMacroValues(prev => {
      const existing = prev[compositionKey];
      if (existing && existing[key] === val) return prev;
      return { ...prev, [compositionKey]: { ...existing, [key]: val } };
    });
  }, [compositionKey]);

  const setHatchGroupValue = useCallback((groupName: string, config: HatchGroupConfig) => {
    setHatchGroupValues(prev => {
      const existing = prev[compositionKey] ?? {};
      return { ...prev, [compositionKey]: { ...existing, [groupName]: config } };
    });
  }, [compositionKey]);

  const currentHatchGroups = useMemo(
    () => hatchGroupValues[compositionKey] ?? {},
    [hatchGroupValues, compositionKey],
  );

  // Reset all macros to their defaults (0.5 center)
  const resetMacros = useCallback(() => {
    setMacroValues(prev => {
      const { [compositionKey]: _, ...rest } = prev;
      return rest;
    });
  }, [compositionKey]);

  // Reset a specific control group to defaults
  const resetControlGroup = useCallback((group: string) => {
    if (!comp.controls) return;
    setCompValues(prev => {
      const existing = { ...prev[compositionKey] };
      for (const [key, ctrl] of Object.entries(comp.controls!)) {
        if (ctrl.group === group) delete existing[key];
      }
      return { ...prev, [compositionKey]: existing };
    });
  }, [compositionKey, comp.controls]);

  // Reset all controls + macros + hatch groups for current composition
  const resetAllControls = useCallback(() => {
    setCompValues(prev => {
      const { [compositionKey]: _, ...rest } = prev;
      return rest;
    });
    setMacroValues(prev => {
      const { [compositionKey]: _, ...rest } = prev;
      return rest;
    });
    setHatchGroupValues(prev => {
      const { [compositionKey]: _, ...rest } = prev;
      return rest;
    });
  }, [compositionKey]);

  // Macro resolver
  const resolvedValues = useMemo(
    () => resolveValues(comp.controls, comp.macros, currentValues, currentMacros),
    [comp.controls, comp.macros, currentValues, currentMacros],
  );

  // Persist all controls to localStorage (debounced to avoid thrashing during slider drags)
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stateSnapshot = useMemo(() => ({
    surfaceKey, compositionKey, controlsPanel,
    paramA, paramB, paramC, paramD,
    hatchFamily, hatchCount, hatchSamples, hatchAngle,
    useOcclusion, depthRes, depthBias,
    camTheta, camPhi, camDist, camOrtho, panX, panY,
    strokeWidth, showMesh,
    pageSize, orientation, margin, borderEnabled, borderStyle,
    densityFilterEnabled, densityMax, densityCellSize,
    seed, depthWidthEnabled, hiddenGhost, silhouetteEnabled,
  }), [
    surfaceKey, compositionKey, controlsPanel,
    paramA, paramB, paramC, paramD,
    hatchFamily, hatchCount, hatchSamples, hatchAngle,
    useOcclusion, depthRes, depthBias,
    camTheta, camPhi, camDist, camOrtho, panX, panY,
    strokeWidth, showMesh,
    pageSize, orientation, margin, borderEnabled, borderStyle,
    densityFilterEnabled, densityMax, densityCellSize,
    seed, depthWidthEnabled, hiddenGhost, silhouetteEnabled,
  ]);
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot));
      // Strip ImageControl values (Float32Array brightness grids) — they
      // don't round-trip through JSON and would bloat localStorage anyway.
      const persisted: typeof compValues = {};
      for (const [compKey, slice] of Object.entries(compValues)) {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(slice)) {
          if (
            v !== null &&
            typeof v === "object" &&
            "brightness" in (v as object) &&
            (v as { brightness: unknown }).brightness instanceof Float32Array
          ) continue;
          cleaned[k] = v;
        }
        persisted[compKey] = cleaned;
      }
      localStorage.setItem(COMP_VALUES_KEY, JSON.stringify(persisted));
      localStorage.setItem(MACRO_VALUES_KEY, JSON.stringify(macroValues));
      localStorage.setItem(HATCH_GROUPS_KEY, JSON.stringify(hatchGroupValues));
      localStorage.setItem(LAYERED_LAYERS_KEY, JSON.stringify(layeredLayersByKey));
    }, 300);
    return () => clearTimeout(persistTimer.current);
  }, [stateSnapshot, compValues, macroValues, hatchGroupValues, layeredLayersByKey]);

  // ── Undo / Redo ──
  const undoableSnapshot = useMemo(() => ({
    surfaceKey, compositionKey,
    paramA, paramB, paramC, paramD,
    hatchFamily, hatchCount, hatchSamples, hatchAngle,
    useOcclusion, depthRes, depthBias,
    camTheta, camPhi, camDist, camOrtho, panX, panY,
    strokeWidth, showMesh,
    pageSize, orientation, margin, borderEnabled, borderStyle,
    densityFilterEnabled, densityMax, densityCellSize,
    seed, depthWidthEnabled, hiddenGhost, silhouetteEnabled,
    compValues, macroValues, hatchGroupValues, layeredLayersByKey,
  }), [
    surfaceKey, compositionKey,
    paramA, paramB, paramC, paramD,
    hatchFamily, hatchCount, hatchSamples, hatchAngle,
    useOcclusion, depthRes, depthBias,
    camTheta, camPhi, camDist, camOrtho, panX, panY,
    strokeWidth, showMesh,
    pageSize, orientation, margin, borderEnabled, borderStyle,
    densityFilterEnabled, densityMax, densityCellSize,
    seed, depthWidthEnabled, hiddenGhost, silhouetteEnabled,
    compValues, macroValues, hatchGroupValues, layeredLayersByKey,
  ]);

  const restoreSnapshot = useCallback((snap: typeof undoableSnapshot) => {
    setSurfaceKey(snap.surfaceKey);
    setCompositionKey(snap.compositionKey);
    setParamA(snap.paramA);
    setParamB(snap.paramB);
    setParamC(snap.paramC);
    setParamD(snap.paramD);
    setHatchFamily(snap.hatchFamily);
    setHatchCount(snap.hatchCount);
    setHatchSamples(snap.hatchSamples);
    setHatchAngle(snap.hatchAngle);
    setUseOcclusion(snap.useOcclusion);
    setDepthRes(snap.depthRes);
    setDepthBias(snap.depthBias);
    setCamTheta(snap.camTheta);
    setCamPhi(snap.camPhi);
    setCamDist(snap.camDist);
    setCamOrtho(snap.camOrtho);
    setPanX(snap.panX);
    setPanY(snap.panY);
    setStrokeWidth(snap.strokeWidth);
    setShowMesh(snap.showMesh);
    setPageSize(snap.pageSize);
    setOrientation(snap.orientation);
    setMargin(snap.margin);
    setBorderEnabled(snap.borderEnabled);
    setBorderStyle(snap.borderStyle);
    setDensityFilterEnabled(snap.densityFilterEnabled);
    setDensityMax(snap.densityMax);
    setDensityCellSize(snap.densityCellSize);
    setSeed(snap.seed);
    setDepthWidthEnabled(snap.depthWidthEnabled);
    setHiddenGhost(snap.hiddenGhost);
    setSilhouetteEnabled(snap.silhouetteEnabled);
    setCompValues(snap.compValues);
    setMacroValues(snap.macroValues);
    setHatchGroupValues(snap.hatchGroupValues);
    setLayeredLayersByKey(snap.layeredLayersByKey);
  }, []);

  const { undo, redo, canUndo, canRedo } = useHistory(undoableSnapshot, restoreSnapshot);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  // Preview pan/zoom (ephemeral, not persisted)
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPanX, setViewPanX] = useState(0);
  const [viewPanY, setViewPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const viewDragRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Serializable camera params (camera is reconstructed inside the worker)
  const cameraParams: CameraParams = useMemo(
    () => ({
      theta: camTheta,
      phi: camPhi,
      dist: camDist,
      ortho: camOrtho,
      panX,
      panY,
      width,
      height,
    }),
    [camTheta, camPhi, camDist, camOrtho, panX, panY, width, height]
  );

  // Export layout geometry (shared by preview and export)
  const exportLayout = useMemo(() => {
    const page = PAGE_SIZES[pageSize];
    const pageW = orientation === "portrait" ? page.h : page.w;
    const pageH = orientation === "portrait" ? page.w : page.h;
    const contentW = pageW - margin * 2;
    const contentH = pageH - margin * 2;
    const scale = Math.min(contentW / width, contentH / height);
    const cx = margin + (contentW - width * scale) / 2;
    const cy = margin + (contentH - height * scale) / 2;
    return { pageW, pageH, contentW, contentH, scale, cx, cy };
  }, [pageSize, orientation, margin, width, height]);

  // Live border preview paths
  const previewBorderPaths = useMemo(() => {
    if (!borderEnabled) return [];
    return generateBorderPaths(borderStyle, exportLayout.pageW, exportLayout.pageH, margin, strokeWidth);
  }, [borderEnabled, borderStyle, exportLayout, margin, strokeWidth]);

  // Inset clip rect for double border so hatch lines clip at the inner edge
  const clipInset = borderEnabled && borderStyle === "double" ? DOUBLE_BORDER_INSET : 0;

  // Map generic sliders to surface-specific params
  const surfaceParams = useMemo(() => {
    const s = SURFACES[surfaceKey];
    const d = s.defaults;
    const keys = Object.keys(d);
    const sliders = [paramA, paramB, paramC, paramD];
    const result = { ...d };
    keys.forEach((k, i) => {
      if (i < 4) {
        const base = d[k];
        result[k] = base * (0.2 + sliders[i] * 1.6);
      }
    });
    return result;
  }, [surfaceKey, paramA, paramB, paramC, paramD]);

  // Hatch params memo (serializable for worker)
  const hatchParams = useMemo(
    () => ({
      family: hatchFamily,
      count: hatchCount,
      samples: hatchSamples,
      angle: hatchAngle,
    }),
    [hatchFamily, hatchCount, hatchSamples, hatchAngle]
  );

  // Stable reference for the subset of exportLayout the worker needs
  const workerExportLayout = useMemo(
    () => ({ contentW: exportLayout.contentW, contentH: exportLayout.contentH, scale: exportLayout.scale }),
    [exportLayout]
  );

  // Generate everything via Web Worker
  const { svgPaths, meshPaths, layerGroups, stats, isRendering, isStale, renderTimeMs, triggerRender } =
    useRenderWorker({
      compositionKey,
      is2d,
      width,
      height,
      resolvedValues,
      surfaceKey,
      surfaceParams,
      hatchParams,
      currentHatchGroups,
      camera: cameraParams,
      useOcclusion,
      depthRes,
      depthBias,
      exportLayout: workerExportLayout,
      showMesh,
      densityFilterEnabled,
      densityMax,
      densityCellSize,
      seed,
      depthWidthEnabled,
      hiddenGhost,
      silhouetteEnabled,
      renderMode: effectiveRenderMode,
      layeredLayersOverride: isLayered ? currentLayers : undefined,
    });

  // Preview viewport controls (pan/zoom the SVG view, not the 3D scene)
  const handleViewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      viewDragRef.current = { x: e.clientX, y: e.clientY, panX: viewPanX, panY: viewPanY };
    },
    [viewPanX, viewPanY]
  );

  const handleViewMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const s = viewDragRef.current;
      setViewPanX(s.panX + (e.clientX - s.x));
      setViewPanY(s.panY + (e.clientY - s.y));
    },
    [isDragging]
  );

  const handleViewMouseUp = useCallback(() => setIsDragging(false), []);

  // Pinch-to-zoom via touch events
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { dist: Math.hypot(dx, dy), zoom: viewZoom };
    }
  }, [viewZoom]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / pinchRef.current.dist;
      setViewZoom(Math.max(0.25, Math.min(10, pinchRef.current.zoom * scale)));
    }
  }, []);
  const handleTouchEnd = useCallback(() => { pinchRef.current = null; }, []);

  const handleViewDoubleClick = useCallback(() => {
    setViewZoom(1);
    setViewPanX(0);
    setViewPanY(0);
  }, []);

  // Deterministic config hash for filenames
  const fileHash = useMemo(() => configHash({
    compositionKey,
    resolvedValues,
    currentMacros,
    hatchGroupValues: currentHatchGroups,
    ...(is2d ? {} : { surfaceKey, camTheta, camPhi, camDist, hatchFamily, hatchCount, hatchSamples }),
  }), [compositionKey, resolvedValues, currentMacros, currentHatchGroups, is2d, surfaceKey, camTheta, camPhi, camDist, hatchFamily, hatchCount, hatchSamples]);

  const fileBasename = useMemo(() => {
    const prefix = is2d ? "hatch2d" : "hatch3d";
    return `${prefix}_${compositionKey}_${fileHash}`;
  }, [is2d, compositionKey, fileHash]);

  // Build SVG content string (shared between SVG and PNG export)
  const buildSVGContent = useCallback(
    () =>
      buildBrowserExportSVG({
        svgPaths,
        layerGroups,
        layout: exportLayout,
        margin,
        clipInset,
        strokeWidth,
        borderPaths: previewBorderPaths,
      }),
    [svgPaths, layerGroups, exportLayout, margin, clipInset, strokeWidth, previewBorderPaths],
  );

  // Export SVG
  const handleExportSVG = useCallback(() => {
    const content = buildSVGContent();
    const blob = new Blob([content], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileBasename}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildSVGContent, fileBasename]);

  // Export PNG
  const handleExportPNG = useCallback(async (pngTheme: "light" | "dark", scale: number) => {
    const content = buildSVGContent();
    try {
      const blob = await exportPng(content, PNG_THEMES[pngTheme], scale);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileBasename}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn("PNG export failed:", (e as Error).message);
    }
  }, [buildSVGContent, fileBasename]);

  // Export modal state
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Preset management
  const [presetVersion, setPresetVersion] = useState(0);

  const presets = useMemo(
    () => getPresetsForComposition(compositionKey, comp.suggestedPresets),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compositionKey, comp.suggestedPresets, presetVersion],
  );

  const handleSavePreset = useCallback((name: string) => {
    const key = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const preset: CompositionPreset = {
      name,
      values: {
        controls: compValues[compositionKey],
        macros: macroValues[compositionKey],
        hatchGroups: hatchGroupValues[compositionKey],
        ...(isLayered ? { layers: buildLayeredPresetValues(currentLayers) } : {}),
      },
    };
    saveUserPreset(compositionKey, key, preset);
    setPresetVersion((v) => v + 1);
  }, [compositionKey, compValues, macroValues, hatchGroupValues, isLayered, currentLayers]);

  const handleLoadPreset = useCallback((preset: CompositionPreset) => {
    if (preset.values.controls) {
      setCompValues((prev) => ({ ...prev, [compositionKey]: preset.values.controls as Record<string, unknown> }));
    }
    if (preset.values.macros) {
      setMacroValues((prev) => ({ ...prev, [compositionKey]: preset.values.macros as Record<string, number> }));
    }
    if (preset.values.hatchGroups) {
      setHatchGroupValues((prev) => ({ ...prev, [compositionKey]: preset.values.hatchGroups as Record<string, HatchGroupConfig> }));
    }
    if (preset.values.layers !== undefined) {
      setLayeredLayersByKey((prev) => ({ ...prev, [compositionKey]: preset.values.layers as LayeredLayer[] }));
    }
  }, [compositionKey]);

  const handleDeletePreset = useCallback((key: string) => {
    deleteUserPreset(compositionKey, key);
    setPresetVersion((v) => v + 1);
  }, [compositionKey]);

  const surfaceInfo = SURFACES[surfaceKey];
  const paramKeys = Object.keys(surfaceInfo.defaults);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        fontFamily: "'IBM Plex Mono', 'SF Mono', monospace",
        color: "var(--fg)",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 22px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.06em" }}>
            HATCH3D
          </span>
          <span style={{ fontSize: 10, color: "var(--fg-hint)", letterSpacing: "0.08em" }}>
            UV-SPACE PARAMETRIC HATCHING → SVG
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
            <button
              onClick={() => { setViewZoom(1); setViewPanX(0); setViewPanY(0); }}
              style={{ ...tagStyle, fontSize: 9, padding: "2px 6px" }}
            >
              Fit
            </button>
            <button
              onClick={() => setViewZoom((z) => Math.min(10, z * 1.5))}
              style={{ ...tagStyle, fontSize: 9, padding: "2px 6px", width: 22, textAlign: "center" }}
            >
              +
            </button>
            <span style={{ color: "var(--fg-dim)", width: 36, textAlign: "center" }}>
              {Math.round(viewZoom * 100)}%
            </span>
            <button
              onClick={() => setViewZoom((z) => Math.max(0.25, z / 1.5))}
              style={{ ...tagStyle, fontSize: 9, padding: "2px 6px", width: 22, textAlign: "center" }}
            >
              &minus;
            </button>
          </div>
          <button
            onClick={cycleTheme}
            title={`Theme: ${theme}`}
            style={{ ...tagStyle, fontSize: 12, padding: "2px 8px", lineHeight: 1 }}
          >
            {theme === "auto" ? "\u25D1" : theme === "light" ? "\u2600" : "\u263E"}
          </button>
          <button
            onClick={() => setExportModalOpen(true)}
            style={{ ...btnStyle, background: "var(--fg)", color: "var(--bg-canvas)" }}
          >
            EXPORT
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Main controls sidebar */}
        <div
          style={{
            width: 280,
            minWidth: 280,
            padding: "14px 18px",
            overflowY: "auto",
            overflowX: "hidden",
            borderRight: "1px solid var(--border)",
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 18,
            flexShrink: 0,
          }}
        >
          {/* Undo / Redo */}
          <div style={{ display: "flex", gap: 4 }}>
            <button
              onClick={undo}
              disabled={!canUndo}
              style={{
                ...btnStyle,
                flex: 1,
                opacity: canUndo ? 1 : 0.3,
                cursor: canUndo ? "pointer" : "default",
              }}
              title="Undo (Cmd+Z)"
            >
              Undo
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              style={{
                ...btnStyle,
                flex: 1,
                opacity: canRedo ? 1 : 0.3,
                cursor: canRedo ? "pointer" : "default",
              }}
              title="Redo (Cmd+Shift+Z)"
            >
              Redo
            </button>
          </div>

          <Section title="COMPOSITION" preview={comp.name}>
            <CompositionBrowser
              currentKey={compositionKey}
              onSelect={setCompositionKey}
            />
            {!isNarrow && controlsPanel === "inline" && (comp.controls || !is2d) && (
              <button
                onClick={() => setControlsPanel("side")}
                title="Undock controls to side panel"
                style={{ ...tagStyle, fontSize: 9, padding: "2px 6px", alignSelf: "flex-start" }}
              >
                Undock controls &rarr;
              </button>
            )}
          </Section>

          {compositionKey === "single" && (
            <Section title="SURFACE" preview={surfaceInfo.name}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {Object.entries(SURFACES).map(([key, val]) => (
                  <button
                    key={key}
                    onClick={() => setSurfaceKey(key)}
                    style={{
                      ...tagStyle,
                      background: surfaceKey === key ? "var(--fg)" : "transparent",
                      color: surfaceKey === key ? "var(--bg-canvas)" : "var(--fg)",
                    }}
                  >
                    {val.name}
                  </button>
                ))}
              </div>
              <Slider label={paramKeys[0] || "A"} value={paramA} onChange={setParamA} min={0} max={1} step={0.01} />
              <Slider label={paramKeys[1] || "B"} value={paramB} onChange={setParamB} min={0} max={1} step={0.01} />
              {paramKeys.length > 2 && (
                <Slider label={paramKeys[2] || "C"} value={paramC} onChange={setParamC} min={0} max={1} step={0.01} />
              )}
              {paramKeys.length > 3 && (
                <Slider label={paramKeys[3] || "D"} value={paramD} onChange={setParamD} min={0} max={1} step={0.01} />
              )}
            </Section>
          )}

          {/* Inline composition controls + 3D controls (when not using side panel) */}
          {(isNarrow || controlsPanel === "inline") && (
            <>
              {isLayered && (
                <LayerPanel
                  layers={currentLayers}
                  onChange={setLayers}
                  availableCompositions={Array.from(compositionRegistry.getAll().values())}
                  onReset={resetLayers}
                />
              )}
              {compositionKey !== "single" && comp.controls && (
                <CompositionControls
                  controls={comp.controls}
                  macros={comp.macros}
                  hatchGroups={"hatchGroups" in comp ? (comp as Composition3DDefinition).hatchGroups : undefined}
                  currentValues={currentValues}
                  currentMacros={currentMacros}
                  resolvedValues={resolvedValues}
                  currentHatchGroups={currentHatchGroups}
                  onControlChange={setCompValue}
                  onMacroChange={setMacroValue}
                  onHatchGroupChange={setHatchGroupValue}
                  onResetMacros={resetMacros}
                  onResetGroup={resetControlGroup}
                  onResetAll={resetAllControls}
                />
              )}
              {!is2d && !isLayered && (
                <ThreeDControls
                  hatchFamily={hatchFamily}
                  setHatchFamily={(f) => setHatchFamily(f as HatchFamily)}
                  hatchCount={hatchCount}
                  setHatchCount={setHatchCount}
                  hatchSamples={hatchSamples}
                  setHatchSamples={setHatchSamples}
                  hatchAngle={hatchAngle}
                  setHatchAngle={setHatchAngle}
                  useOcclusion={useOcclusion}
                  setUseOcclusion={setUseOcclusion}
                  depthRes={depthRes}
                  setDepthRes={setDepthRes}
                  depthBias={depthBias}
                  setDepthBias={setDepthBias}
                  showMesh={showMesh}
                  setShowMesh={setShowMesh}
                  camOrtho={camOrtho}
                  setCamOrtho={setCamOrtho}
                  camDist={camDist}
                  setCamDist={setCamDist}
                  camTheta={camTheta}
                  setCamTheta={setCamTheta}
                  camPhi={camPhi}
                  setCamPhi={setCamPhi}
                  panX={panX}
                  setPanX={setPanX}
                  panY={panY}
                  setPanY={setPanY}
                />
              )}
            </>
          )}

          {effectiveRenderMode === "manual" && (
            <RenderButton
              isStale={isStale}
              isRendering={isRendering}
              onRender={triggerRender}
            />
          )}

          {compositionKey !== "single" && (
            <PresetMenu
              compositionKey={compositionKey}
              suggested={presets.suggested}
              user={presets.user}
              onSave={handleSavePreset}
              onLoad={handleLoadPreset}
              onDelete={handleDeletePreset}
            />
          )}

          <Section title="DISPLAY" preview={`sw ${strokeWidth.toFixed(1)}`}>
            <Slider label="Stroke W" value={strokeWidth} onChange={setStrokeWidth} min={0.1} max={2} step={0.05} />
            <Slider label="Seed" value={seed} onChange={(v) => setSeed(Math.round(v))} min={0} max={999} step={1} />
            {!is2d && (
              <>
                <Toggle label="Depth width" value={depthWidthEnabled} onChange={setDepthWidthEnabled} />
                <Toggle label="Silhouette" value={silhouetteEnabled} onChange={setSilhouetteEnabled} />
                {useOcclusion && (
                  <Toggle label="Ghost hidden" value={hiddenGhost} onChange={setHiddenGhost} />
                )}
              </>
            )}
          </Section>

          <Section title="DENSITY" preview={densityFilterEnabled ? `max ${densityMax}` : "off"}>
            <Toggle label="Density filter" value={densityFilterEnabled} onChange={setDensityFilterEnabled} />
            {densityFilterEnabled && (
              <>
                <Slider label="Max" value={densityMax} onChange={(v) => setDensityMax(Math.round(v))} min={1} max={60} step={1} />
                <Slider label="Cell size" value={densityCellSize} onChange={(v) => setDensityCellSize(Math.round(v))} min={10} max={100} step={5} />
              </>
            )}
          </Section>

          <Section title="EXPORT" preview={`${PAGE_SIZES[pageSize].label} ${orientation}`}>
            <div style={{ display: "flex", gap: 3 }}>
              {(["landscape", "portrait"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOrientation(o)}
                  style={{
                    ...tagStyle,
                    background: orientation === o ? "var(--fg)" : "transparent",
                    color: orientation === o ? "var(--bg-canvas)" : "var(--fg)",
                  }}
                >
                  {o === "landscape" ? "Landscape" : "Portrait"}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {Object.entries(PAGE_SIZES).map(([key, val]) => (
                <button
                  key={key}
                  onClick={() => setPageSize(key)}
                  style={{
                    ...tagStyle,
                    background: pageSize === key ? "var(--fg)" : "transparent",
                    color: pageSize === key ? "var(--bg-canvas)" : "var(--fg)",
                  }}
                >
                  {val.label}
                </button>
              ))}
            </div>
            <Slider label="Margin" value={margin} onChange={(v) => setMargin(Math.round(v))} min={5} max={40} step={1} />
            <Toggle label="Border" value={borderEnabled} onChange={setBorderEnabled} />
            {borderEnabled && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {Object.entries(BORDER_STYLES).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setBorderStyle(key as typeof borderStyle)}
                    style={{
                      ...tagStyle,
                      background: borderStyle === key ? "var(--fg)" : "transparent",
                      color: borderStyle === key ? "var(--bg-canvas)" : "var(--fg)",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <div
            style={{
              color: "var(--fg-faint)",
              fontSize: 10,
              marginTop: "auto",
              paddingTop: 12,
              lineHeight: 1.6,
            }}
          >
            {stats.paths} SVG paths · {stats.lines} {is2d ? "polylines" : "hatch lines"} · {stats.verts} vertices
            {renderTimeMs > 0 && <> · {renderTimeMs < 1000 ? `${Math.round(renderTimeMs)}ms` : `${(renderTimeMs / 1000).toFixed(1)}s`}</>}
            {isRendering && <> · <span style={{ color: "var(--fg-dim)" }}>rendering...</span></>}
            <br />
            Pipeline: {is2d
              ? "generate 2D \u2192 SVG"
              : <>UV hatch &rarr; 3D surface &rarr; project{useOcclusion ? " \u2192 depth clip" : ""}{densityFilterEnabled ? " \u2192 density" : ""} &rarr; SVG</>
            }
          </div>
        </div>

        {/* Side panel for composition + 3D controls (wide viewports, opt-in) */}
        {!isNarrow && controlsPanel === "side" && (comp.controls || !is2d || isLayered) && (
          <div
            style={{
              width: 280,
              minWidth: 280,
              padding: "14px 18px",
              overflowY: "auto",
              overflowX: "hidden",
              borderRight: "1px solid var(--border)",
              fontSize: 11,
              display: "flex",
              flexDirection: "column",
              gap: 18,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--fg-dim)" }}>
                {comp.name.toUpperCase()}
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={resetAllControls}
                  title="Reset all controls and macros to defaults"
                  style={{ ...tagStyle, fontSize: 9, padding: "2px 6px" }}
                >
                  Reset all
                </button>
                <button
                  onClick={() => setControlsPanel("inline")}
                  title="Dock controls back to main sidebar"
                  style={{ ...tagStyle, fontSize: 9, padding: "2px 6px" }}
                >
                  &larr; Dock
                </button>
              </div>
            </div>
            {isLayered && (
              <LayerPanel
                layers={currentLayers}
                onChange={setLayers}
                availableCompositions={Array.from(compositionRegistry.getAll().values())}
                onReset={resetLayers}
              />
            )}
            {comp.controls && (
              <CompositionControls
                controls={comp.controls}
                macros={comp.macros}
                hatchGroups={"hatchGroups" in comp ? (comp as Composition3DDefinition).hatchGroups : undefined}
                currentValues={currentValues}
                currentMacros={currentMacros}
                resolvedValues={resolvedValues}
                currentHatchGroups={currentHatchGroups}
                onControlChange={setCompValue}
                onMacroChange={setMacroValue}
                onHatchGroupChange={setHatchGroupValue}
                onResetMacros={resetMacros}
                onResetGroup={resetControlGroup}
                onResetAll={resetAllControls}
              />
            )}
            {!is2d && !isLayered && (
              <ThreeDControls
                hatchFamily={hatchFamily}
                setHatchFamily={(f) => setHatchFamily(f as HatchFamily)}
                hatchCount={hatchCount}
                setHatchCount={setHatchCount}
                hatchSamples={hatchSamples}
                setHatchSamples={setHatchSamples}
                hatchAngle={hatchAngle}
                setHatchAngle={setHatchAngle}
                useOcclusion={useOcclusion}
                setUseOcclusion={setUseOcclusion}
                depthRes={depthRes}
                setDepthRes={setDepthRes}
                depthBias={depthBias}
                setDepthBias={setDepthBias}
                showMesh={showMesh}
                setShowMesh={setShowMesh}
                camOrtho={camOrtho}
                setCamOrtho={setCamOrtho}
                camDist={camDist}
                setCamDist={setCamDist}
                camTheta={camTheta}
                setCamTheta={setCamTheta}
                camPhi={camPhi}
                setCamPhi={setCamPhi}
                panX={panX}
                setPanX={setPanX}
                panY={panY}
                setPanY={setPanY}
              />
            )}
          </div>
        )}

        {/* SVG viewport */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg)",
            cursor: isDragging ? "grabbing" : "grab",
            overflow: "hidden",
            position: "relative",
          }}
          onMouseDown={handleViewMouseDown}
          onMouseMove={handleViewMouseMove}
          onMouseUp={handleViewMouseUp}
          onMouseLeave={handleViewMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onDoubleClick={handleViewDoubleClick}
        >
          {isRendering && (
            <div
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                zIndex: 10,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: "var(--fg-dim)",
              }}
            >
              Rendering...
            </div>
          )}
          <svg
            viewBox={`0 0 ${exportLayout.pageW} ${exportLayout.pageH}`}
            style={{
              maxWidth: "calc(100% - 24px)",
              maxHeight: "calc(100vh - 60px)",
              background: "var(--bg-canvas)",
              boxShadow: "0 1px 16px var(--shadow)",
              transform: `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`,
              transformOrigin: "center center",
              opacity: isStale ? 0.6 : 1,
              transition: "opacity 0.15s ease",
            }}
          >
            <defs>
              <clipPath id="preview-margin-clip">
                <rect x={margin + clipInset} y={margin + clipInset} width={exportLayout.contentW - clipInset * 2} height={exportLayout.contentH - clipInset * 2} />
              </clipPath>
            </defs>
            {/* Margin guide (preview only) */}
            <rect
              x={margin}
              y={margin}
              width={exportLayout.contentW}
              height={exportLayout.contentH}
              fill="none"
              stroke="var(--border-light)"
              strokeWidth={0.5}
              strokeDasharray="2 2"
            />
            <g clipPath="url(#preview-margin-clip)">
              <g transform={`translate(${exportLayout.cx},${exportLayout.cy}) scale(${exportLayout.scale})`}>
                {showMesh && (
                  <g fill="none" stroke="var(--mesh-stroke)" strokeWidth={0.3 / exportLayout.scale}>
                    {meshPaths.map((d, i) => (
                      <path key={`m${i}`} d={d} />
                    ))}
                  </g>
                )}
                <g
                  fill="none"
                  stroke="var(--fg)"
                  strokeWidth={strokeWidth / exportLayout.scale}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {layerGroups && layerGroups.length > 0
                    ? layerGroups.map((lg, gi) => (
                        <g
                          key={`lg${gi}`}
                          id={lg.name ?? `layer-${gi}`}
                          stroke={lg.color ?? undefined}
                          strokeWidth={
                            lg.widthScale !== undefined
                              ? (strokeWidth * lg.widthScale) / exportLayout.scale
                              : undefined
                          }
                          strokeDasharray={lg.dash ? lg.dash.join(" ") : undefined}
                          opacity={lg.opacity}
                        >
                          {lg.svgPaths.map((d, i) => (
                            <path key={`${gi}-${i}`} d={d} />
                          ))}
                        </g>
                      ))
                    : svgPaths.map((d, i) => <path key={i} d={d} />)}
                </g>
              </g>
            </g>
            {previewBorderPaths.length > 0 && (
              <g fill="none" stroke="var(--fg)" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
                {previewBorderPaths.map((d, i) => (
                  <path key={`b${i}`} d={d} />
                ))}
              </g>
            )}
          </svg>
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }} />

      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onExportSVG={handleExportSVG}
        onExportPNG={handleExportPNG}
        currentTheme={theme}
      />
    </div>
  );
}
