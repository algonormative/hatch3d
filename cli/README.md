# hatch3d CLIs

Headless Node CLIs (run via `tsx`). No browser required.

| Script | Command | Purpose |
| ------ | ------- | ------- |
| `render` | `npm run render -- -c <id> -o out.svg` | Render a composition to SVG/PNG |
| `render` (scene) | `npm run render -- --scene s.scene.json -o out.svg` | Render a Scene IR document (see `docs/scene-ir.md`) |
| `sign` | `npm run sign -- <print-queue-dir>…` | Sign plot-ready SVGs bottom-right with `@algonormative  <edition>  <build>  <created>` on the lettering pen; keeps the recorded `prepared_sha256` in step (`--text "<line>" file.svg…` for loose files). `--pen <id>` signs into that existing layer in its ink and `--box x0,y0,x1,y1` right-aligns at the bottom of a box; `--height <mm>` sets the cap height, for a wide pen whose line would close the default's letters; a directory reads `sign_pen`/`sign_box` from `index.md`, skips `sign: false`, and never adds a layer to an entry with a `config.json` |
| `stats` | `npm run stats -- -i out.svg` | Deterministic SVG measurement (report below) |
| `stats:diff` | `npm run stats:diff -- a.svg b.svg …` | Variability across variants (below) |
| `feed` | `npm run feed` | Render curated/biased presets and push to the feed app |
| `pref:sync` | `npm run pref:sync` | Collect curation signals, recompute the preference model |
| `finalize` | `npm run finalize -- run <stack.json> --only a,b` | Palette, placement and vpype prep of sketch prints (below) |
| `plotter-check` | `npm run plotter-check -- <piece-dir> …` | plotter-server's own import checks, with a negative control |
| `ink-check` | `npm run ink-check -- [--out dir] [--cut-clearance mm] <piece-dir> …` | Where a pen's lines run closer than it holds apart, and where art sits near a cut guide (`ink-check.png`, `ink-check.json`) |
| `assembly` | `npm run assembly -- preview <stack.json> [--assembly name] [--shadow] [--out dir]` | Lay a panel's finalized plies up as the glued artwork (`assembled.svg`/`.png`, `exploded.png`) |
| `art-match` | `npm run art-match -- <plain.svg> <print.svg>` | Is the print the approved art, path for path, under the border fit? |
| `print-queue` | `npm run print-queue -- <stack.json> --into <dir> --prefix p --notes n.json` | Write checked vault print-queue entries |
| `baselines` | `npm run baselines -- check` | Byte-identity of every print seed (`sketches/baselines.json`) |
| `sheet` | `npm run sheet -- montage\|crop\|diff …` | Review sheets: side by side, close-ups, what changed |

## From sketch to print queue

The steps a sketch print goes through, each a command; none of them uploads or plots anything.

1. **Steer.** `npm run sketch -- render <entry> --seed N --out dir` per pass; `npm run sketch -- experiment <matrix.json> --out dir` renders a seed (or params) matrix with a labelled contact sheet for picking by eye. `npm run sheet -- montage out.png a=…/render.png b=…` puts any renders side by side, `sheet crop` zooms (fractions of the image, `--scale`), and `sheet diff before.png after.png out.png` finds and shows what changed between two renders.
2. **Guard what is printed.** After any kit or engine change, `npm run baselines -- check` re-renders every print seed and compares identities (a few seconds). A deliberate change is re-recorded with `baselines -- update <entry>`, a dry run until `--yes`, and its print-queue entries need re-prepping.
3. **Finalize.** Add the piece to its stack (`sketches/phase-garden/stacks/*.json`), commit, then `npm run finalize -- run <stack.json> --only name`.
4. **Check.** `npm run plotter-check -- .sketch-output/finalize/<stack>/<name>` runs plotter-server's `validatePreparedPenPlan` and `buildPenPlan` (from a checkout at `PLOTTER_SERVER_DIR`, default `~/git/plotter-server`), and requires a recoloured copy to be rejected so a pass means the check was live. `finalize` also runs the ink check (`ink-check`, below) on the pieces it prepares, and reports what it finds as warnings.
5. **Assemble (panels of paper plies only).** A sketch with `assembly` is one panel made of plies; each ply is its own piece in the stack (`"assembly": "<panel>"`, the ply as a param) and is finalized on its own paper, never recentred or merged, so every ply gets a `config.json`. `finalize` stages a run of plies (every ply is rendered and prepared into `<out>/.staging-<pid>/`, checked, and only then moved into place together; a run that fails leaves the live directories as they were) and checks the panel: one sketch, seed and params per panel, one page and border, an identical world (every ply's cuts) on every ply, inks that read on their paper (an ink the catalog lists as on trial for that paper is refused unless the stack sets `defaults.trialInks: true`, which records those pens in `report.assembly.trialPens`), and, for an onlay glued on from another panel's part, that its footprint is the part's ring transformed (same vertex count, order and start vertex; RMS under 0.05 mm, no vertex 0.1 mm off). A ply of the panel that is not in the run is read from disk only while its `request.json` (seed, params, page, finishing, border) and sketch are what the stack now asks for; otherwise the run stops with `<piece> is stale on disk: finalize it in this run`. The stack border must be crop marks on the sketch's cut pen. Then `npm run assembly -- preview <stack.json>` writes `<out>/_assembly/<panel>/assembled.svg` and `.png` (every ply on its paper, waste and parts cut out, onlays placed, trimmed at the crop marks; `--shadow` lifts plies that declare a `lift`) and `exploded.png` (each ply on its own paper, guides visible), with `assembled.json` recording the plot-ready.svg hashes and the world it was composed from; it refuses a panel whose plies were not finalized from one world on one page and border. An onlay is never plotted: it is the part of its source panel's ply.
6. **Queue.** `npm run print-queue -- <stack.json> --into ~/git/vault/print-queue --prefix <family> --notes notes.json --only name` writes the vault entry: it re-runs the plotter check and an art match against the sketch's own render, refuses to write a piece that fails either, and records the art identity, hashes, pen plan and regenerate command. `notes.json` maps piece names to the entry's markdown description. A ply of an assembly also gets `assembly`, `ply`, `ply_order`, `paper_stock` and `sign_pen`/`sign_box` (or `sign: false`) in its frontmatter, an `## Assembly` section (its sibling plies bottom to top, its cuts, how to cut and glue, and where its parts and onlays go) and, when `npm run assembly -- preview` has run on the plies as they are now, `assembled.png` (a preview composed from other files is left out and the entry says it is stale).

## Gel pens — `defaults.gelSpeed` and `defaults.prime`

A gel pen (every gel ink of `src/sketch/materials.ts`: the Signo and the Moonlights) can starve after a dense fill and skip until it recovers. Two options in a stack's `defaults` ask for gentler plotting. Each is off unless the stack sets it to `true`, and a stack that sets neither finalizes exactly as before.

- **`"gelSpeed": true`** plots gel layers more slowly. `config.json` gives each layer drawn with an ink that has a `speedPendown` (the catalog sets 15 percent on every gel; provisional, chosen rather than measured) a `speed_pendown` of that many percent, which plotter-server runs as that layer's pen-down speed in place of the job's (the AxiDraw default is 25). The cut and `finishing-border` layers of a panel ply take the speed of the ply's cut ink; the border of any other piece takes its border pen's. A layer drawn with any other ink has no `speed_pendown`. The time estimate (`minutes`, and `speedPendown` on each layer of `report.json`) draws such a layer at its speed: 36 mm/s at 15 percent where the estimate's 60 mm/s is the default 25.
- **`"prime": true`** starts each gel art layer with a priming stroke: a zigzag of 6 legs, 20 mm along the left edge and 2 mm across, in the page margin outside the crop line (or the border's inset), where it is trimmed away with the margin. Each gel layer's zigzag is at its own height, from the top down (a layer after another gel is 24 mm lower), clear of the crop marks at the corners by 3 mm and of the middle 24 mm of the edge, so no ink is laid twice on one spot. It is the first path of its layer in `plot-ready.svg`: finalize adds it after vpype, which would otherwise sort it. The cut and border layers, and layers drawn with any other ink, get none. `report.json` lists them as `priming` (layer, pen and the stroke's box in page millimetres; an empty list when no layer is a gel). It is refused when the margin leaves less than 9 mm to the crop line, or the edge has no room for as many strokes as there are gel layers (16 on tabloid).

The prepared SVG still passes `plotter-check`; only the paths and `speed_pendown` change, never the layers, their order, colours, widths or passes.

## `ink-check` — pen spacing and cut clearance

`finalize` runs `cli/ink-check.ts` on every piece it prepares whose paper is one the materials catalog has measurements for (in practice the plies of an assembly), writes `ink-check.png` and `ink-check.json` beside `plot-ready.svg`, and records the numbers and warnings in the piece's report (`inkCheck`). It takes under a second a piece and never fails a finalize. `npm run ink-check -- <piece-dir> …` runs the same on any finalized or queued piece; `--out <dir>` writes the files to `<dir>/<piece>/` instead of the piece dir, and `--cut-clearance <mm>` sets the cut distance below (default 1.0).

For each ink layer (the cut pen and the border are skipped) it resamples every stroke every 0.2 mm and finds each sample's nearest near-parallel neighbour: a sample on another stroke, or on the same stroke more than three clean pitches away along it, whose direction is within about 20 degrees (lines that cross are not parallel). A sample is *tight* when that neighbour is closer than the pen's clean pitch (less 0.02 mm) and *fused* when it is at or under the fuse pitch. Those pitches, the shortest clean dash and the smallest clean circle (open strokes and closed loops under them are counted, for information) are the measurements of that ink on that paper in `src/sketch/materials.ts` (`limitsOn`; a pair that was never plotted gets conservative defaults, and the report marks it). The overlay draws every stroke faint on the paper colour, tight samples orange and fused ones red; the printed line per layer gives its length, the tight and fused lengths and the three 10 mm cells with the most fused line.

It also reports the length of ink within the cut clearance of the cut layer's outlines. That test is coarse: only the cut layer's long strokes count (a segment of 5 mm or more, or a closed stroke of 25 mm or more, so the X marks and labels are left out), the distance is to the drawn guide, which sits half a pen width inside the cut, and art that bleeds under another ply's window is not told apart from art too near this ply's own cuts. The check reports and never blocks: the exit code is 0 unless the command line is wrong.

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
