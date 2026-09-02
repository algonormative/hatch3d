# hatch3d CLIs

Headless Node CLIs (run via `tsx`). No browser required.

| Script | Command | Purpose |
| ------ | ------- | ------- |
| `render` | `npm run render -- -c <id> -o out.svg` | Render a composition to SVG/PNG |
| `render` (scene) | `npm run render -- --scene s.scene.json -o out.svg` | Render a Scene IR document (see `docs/scene-ir.md`) |
| `stats` | `npm run stats -- -i out.svg` | Deterministic SVG measurement (report below) |
| `stats:diff` | `npm run stats:diff -- a.svg b.svg …` | Variability across variants (below) |
| `feed` | `npm run feed` | Render curated/biased presets and push to the feed app |
| `pref:sync` | `npm run pref:sync` | Collect curation signals, recompute the preference model |

## `stats` — deterministic SVG measurement

Emits a structured JSON report for a hatch3d-emitted SVG: path/vertex counts,
physical arc length, per-layer breakdown, an ink-density grid, a pen-travel
estimate, and plottability warnings. No rendering, no model calls — this is the
measurement half of the agent loop (see the vault design pod
`active/plotter-art-workflow`).

The measurement core is no longer vendored here: it ships as the
[`@endonny/inksight`](https://www.npmjs.com/package/@endonny/inksight) package
(source: [algonormative/inksight](https://github.com/algonormative/inksight)), a regular
dependency of this repo. `cli/stats.ts` is a thin shim that parses flags and
calls the package's `analyzeSvg`, so `npm run stats` keeps working unchanged.

```bash
npm run stats -- --input render.svg
npm run stats -- --input render.svg --pen-width 0.3 --grid 12
npm run render -- -c flowField | npm run stats          # SVG from stdin
```

Outside a hatch3d checkout, the package has its own CLI with the same flags:

```bash
npx @endonny/inksight --input plot.svg
```

To use the core in code: `import { analyzeSvg } from "@endonny/inksight";` (the
report view-model the browser tool renders is at `@endonny/inksight/report`).

### Options

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `-i, --input FILE` | stdin | SVG file to analyze |
| `--pen-width MM` | recovered from SVG | Override pen width (mm) |
| `--grid N` | 8 | Density grid resolution (N×N) |
| `--saturation-threshold C` | 1.0 | Coverage at/above which a cell counts as saturated |
| `--compact` | off | Single-line JSON instead of pretty-printed |

### Scope

Targets SVG produced by hatch3d's exporter: absolute `M`/`L` polyline paths
inside a `translate(cx,cy) scale(S)` group, sized by a `viewBox` plus
`width`/`height` in `mm`, `cm`, `in` or `px` (unitless is read as px at 96dpi),
with a margin clip rect. Curves (`C`/`Q`/`A`/…), relative commands, and closepath are
**rejected with a clear error** rather than silently mis-measured. Both
single-group and layered (per-pen `<g>`) exports are supported.

### Report schema

All lengths and areas are in millimetres (recovered from the `viewBox` mm units
and the group `scale`). Ink density is a coverage proxy: `arcLength × penWidth /
area` — for a constant pen width this approximates the filled-pixel ratio, so a
cell at `1.0` is effectively solid ink (line spacing has dropped below the pen
width).

```jsonc
{
  "input": "render.svg",                 // file label, or null for stdin
  "page":     { "widthMm", "heightMm" }, // page size from viewBox
  "drawable": { "xMm", "yMm", "widthMm", "heightMm", "areaMm2" }, // inside margins
  "penWidthMm": 0.5,
  "penWidthSource": "flag" | "svg" | "default",
  "scale": 0.33375,                       // path-space → mm factor
  "totals": {
    "layers", "paths", "vertices", "segments",
    "arcLengthMm",                        // total drawn line length
    "penUpTravelMm",                      // travel between paths in file order (no reorder)
    "boundingBox": { "xMm", "yMm", "widthMm", "heightMm" },
    "bboxCoverageRatio",                  // bbox area / drawable area
    "inkDensity"                          // global coverage proxy
  },
  "layers": [
    { "id", "stroke", "paths", "vertices", "segments", "arcLengthMm", "inkDensity" }
  ],
  "densityGrid": {
    "cols", "rows",
    "cells",                              // rows×cols coverage matrix
    "max", "mean",
    "cv"                                  // coefficient of variation — spatial balance
  },
  "warnings": {
    "marginViolationPaths",               // paths with a vertex outside the margins
    "saturatedCells",                     // cells with coverage ≥ threshold
    "saturationThreshold"
  }
}
```

### Reading the numbers

- **`densityGrid.cv`** — spatial balance. Low (< ~0.5) means ink is spread
  evenly; high (> ~1.5) means it clumps (e.g. centered geometry with empty
  margins). This is the fast signal for "unbalanced composition."
- **`warnings.saturatedCells`** — regions that will plot as solid black with the
  declared pen; usually a sign to widen hatch pitch or drop a layer.
- **`warnings.marginViolationPaths`** — geometry that the margin clip will cut
  off; the composition is overflowing the page.
- **`penUpTravelMm`** — a rough plot-efficiency signal. High pen-up travel
  relative to `arcLengthMm` means `vpype linesort` will help a lot at prep time.

### InkSight — the same report, in a browser

InkSight is the drag-and-drop face of `stats`: drop an SVG and get the
page/drawable summary, totals, a per-layer table, the density grid as a
heatmap, the plottability warnings, the full `StatsReport` JSON (copyable — the
form an agent consumes), and a rendered thumbnail as a multimodal cross-check.
Everything runs client-side; nothing is uploaded.

It now lives at **<https://algonormative.github.io/inksight/>** and is built from the
[algonormative/inksight](https://github.com/algonormative/inksight) repo, not this one.
`inksight/index.html` here is a redirect stub that keeps the old
`/hatch3d/inksight/` URL working. Same `analyzeSvg`, so identical numbers to
`npm run stats`, same scope limits, same errors. Plot-time estimation and
pen-travel (vpype-grade) modelling stay deferred.

## `stats:diff` — variability across variants

Given N rendered SVG variants of a composition, computes two variability metrics
and classifies the set. The improve-mode routine uses this to decide whether a
composition's parameter space is too thin to be worth keeping as-is.

```bash
npm run stats:diff -- v0.svg v1.svg v2.svg v3.svg v4.svg
```

- **`pathCountCoV`** — coefficient of variation of the SVG path count across
  variants. Catches parameters with no structural effect.
- **`arcLengthCoV`** — CoV of (total arc length / drawable area). Catches density
  changes that path count misses (same stroke count, different tightness).
- **`band`** — `low` / `medium` / `high` off `max(pathCountCoV, arcLengthCoV)`.
  `low` → the routine proposes a new parameter; `high` → variants are already
  well-differentiated. Thresholds are named constants in `src/stats/variability.ts`
  (`VARIABILITY_THRESHOLDS`), pending empirical calibration.

Observed on a real phyllotaxisGarden sweep: varying the structural `count`
(8→40) gives `pathCountCoV ≈ 0.47` (**high**); varying the cosmetic
`sizeVariation` (±0.04) gives `pathCountCoV = 0`, `arcLengthCoV ≈ 0.01`
(**low** — "propose a new parameter"). The LOW=0.05 / HIGH=0.2 thresholds
cleanly separate the two.

## `patch` — signal-flow patches (L2 prototype)

A **patch** extends the Scene IR from a construction *tree* into a signal-flow
*graph* — the eurorack model. Nodes are modules; the "cables" carry three signal
types (the common interface): **Geometry** (polylines, the audio), **Field**
(scalar/vector functions over the canvas, the CV), and scalars/curves (knobs).
A parameter can be *modulated* by a field, and a `repeat` block gives **bounded
iteration** (a `for` loop, not a wall-clock clock) — so a patch still evaluates
deterministically to polylines and stays measurable by `stats`.

```bash
npm run patch -- --dsl examples/patches/flow-modulated.patch -o out.svg
npm run patch -- --dsl examples/patches/flow-modulated.patch --print-graph   # compiled JSON
npm run patch -- --graph patch.json -o out.png -f png
```

The DSL is the thin authoring surface; it compiles to a zod-validated JSON graph
(`src/patch/graph.ts`). Every node is named, so every intermediate signal is
inspectable. Fn names that aren't reserved operators are composition ids
(generator nodes).

```
ground = contourMap(contourLevels: 24)       # generator → Geometry
d      = density(ground, cell: 24)           # Geometry → ScalarField  (the cable)
grad   = gradient(d)                          # ScalarField → VectorField
warped = distort(ground, by: grad, amp: 10)   # modulate geometry by a field (CV)
repeat 3 {                                     # bounded iteration (deterministic)
  flow   = simplexVector(scale: 0.006, seed: 9)
  warped = distort(warped, by: flow, amp: 4)
}
out(warped @ "#1d4ed8")
```

Operators: `simplexScalar`, `simplexVector`, `density`, `gradient`, `sdf` (signed
distance to a node's hull), `luminance` (image brightness field, CLI-decoded PNG),
`directional` (scalar → displacement along an axis), `blend` (combine two scalar
fields: add/mul/max/min/mix), `resample` (subdivide polylines), `distort`,
`cull`, `thin`, `regionHatch` (fill a region — the hull of a node, or an explicit
polygon — with angled parallel lines; scanline even-odd, handles concave zones),
`transform` (translate/rotate/scale; `translate: [x,y]`), `clip` (to a node's
hull, `by:`), `pen`. This is the L2 tier (static, deterministic); L3 (a live
temporal runtime) is a separate research track.

### Scrubbing a `repeat` — `--emit-each-iteration`

`repeat N { … }` is bounded iteration, but you have to pick `N` up front — for an
open-ended generator (drift, reaction-diffusion) you re-render until it "looks
right." Instead, scrub it: write one file per iteration count and pick the frame.

```bash
npm run patch -- --dsl examples/patches/flow-modulated.patch -o out.svg --emit-each-iteration
# → out.iter1.svg, out.iter2.svg, out.iter3.svg   (repeat is `repeat 3`)
npm run patch -- --graph patch.json -o out.png -f png --emit-each-iteration --stride 4
```

Frame `i` is the document evaluated with the first top-level `repeat`'s count set
to `i` — **exactly** what `repeat i { … }` produces, so the frame you pick is the
count you set, not an approximation. `times` is capped at 64, so a full sweep is
at most 64 renders. `--stride N` keeps every Nth frame (the final full-count frame
is always kept) to trim output; nested/later repeats run at full count in every
frame. Each frame is an ordinary SVG the `stats` CLI measures, so you can pick by
number (arc length, ink density) as well as by eye. This is the smaller-than-L3
answer to "watch the process, pick the good frame" (the L2 gap the
`docs/research/l3-live-patch-runtime.md` study flagged).
