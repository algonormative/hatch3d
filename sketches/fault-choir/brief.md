# Fault Choir

An original A3 landscape plotter composition: five physical pens pass through an uneven assembly of curved fields, interrupted orthogonal weaves, small crosslinks, and a folded surface. A broad, wandering fault of bare warm paper divides the activity. Smaller elliptical rests keep the active regions from closing into a solid carpet. The folds sit above the fields; sampled field paths are cut where the fold surface occupies the page, then fold marks are placed last.

[Frank Force's *Chaosplot*](https://frankforce.com/chaosplot/) is the visual stimulus: plottable complexity, energetic variation, and the tension between order and disruption. This sketch uses its own construction. Its marks come from weighted warped domains, four bounded curve grammars, a separate broken crossweave, and folded 3D surface geometry. It does not reproduce Chaosplot's published algorithm or source.

Two Liner corpus briefs inform the compositional decision. [Compression and release in a ruled field](/Users/chronick-mbp/git/liner/output/briefs/compression-release-ruled-field-2026-07-08.md) argues that a disturbance reads only after the rule is visible. [Negative space across media](/Users/chronick-mbp/git/liner/output/briefs/negative-space-cross-media-2026-07-18.md) treats blankness as a budgeted structural event. Here the parallel contour packets state the rule; their short omissions, bent local fields, and the fault corridor create the release. Neither brief verifies the quality of this particular drawing.

## Construction and variation

The seed chooses seven to ten irregular weighted domains, including one larger lead region. Each domain gets an independent named random stream for center, anisotropy, rotation, curve grammar, phase, and rest rhythm. The grammars include gently bent sweeps, diverging fans, and rippled annular lines. Selected lanes carry three or four closely spaced echo contours, giving coherent dark passages against single-line regions. Warped nearest-domain boundaries make the fields meet as faulted regions. A second, mostly orthogonal weave appears in short packets; sparse rungs link neighboring contours. A separate named stream positions the quiet corridor and two or three small rest windows.

Carbon carries structural contour packets; cobalt and lagoon provide longer supporting voices; ember and brass make smaller high-color intervals. Domain assignments cycle through all five inks, while folds may add their own pen voices. The inks are separate SVG pen layers with physical widths of 0.23–0.25 mm. The A3 sheet is 420 × 297 mm with an 18 mm margin. No blend, transparency, or raster texture is required.

The `Composition` radar axes are neutral at 0.5. **Density** changes contour and weave sampling plus local links. **Turbulence** changes bend and links. **Fracture** changes interruptions and fault width. These affect marks through the fine controls; the seed's domain topology stays fixed. The `Field focus` XY control shifts where mark survival is favored. The fold XYZ control moves the fold cluster in the page and depth dimensions. Fold count, twist, scale, and hidden-line handling remain direct fine controls. All sampled paths have finite loops, clipping at no more than 0.6 mm against fold occupancy, and a minimum visible fragment length of 0.35 mm.

The first rendered candidates are saved under `.sketch-output/fault-choir/`. They are preview evidence for whole-sheet judgment, not proof of physical plot quality. Compare at the intended pen width before choosing a plot candidate.

## Working with this study

Run `npm run sketch -- open sketches/fault-choir/sketch.ts` to explore, or `npm run sketch -- render sketches/fault-choir/sketch.ts --seed 73 --out .sketch-output/fault-choir/seed-73` for a deterministic export. Start with the Composition radar, then move Field focus and Fold position. Fine controls expose the underlying spacing, rest rhythm, twist, and scale. Paper sizing, borders, registration, and export finishing remain the shared viewer controls.

The reviewed seed set is 0, 17, 41, 73, 109, 211, 503, and 997. Whole-sheet candidates: **73** for its clear suspended central fold and balanced color regions; **211** for the strong diagonal dark field and sweeping folded silhouette; **997** for its compact overlapping central mass. These remain independent complete compositions.

Final local audit: eight unique compositions, exact repeat of seed 41, five nonempty ink layers per seed, finite page-bounded paths. Default renders contain 2,252–2,591 paths, 87,603–120,541 points, and 47.6–63.1 meters of pen-down travel, taking 0.66–0.88 seconds locally including runner startup. Seven matched control probes (each radar axis, XY, XYZ, hidden-line switch, and combined maximum) all changed geometry without nonfinite output; the combined maximum rendered in under one second locally including PNG encoding. This is software and visual evidence; no physical plot has been made.
