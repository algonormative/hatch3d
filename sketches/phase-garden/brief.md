# Phase Garden

Three original concert-poster compositions for an imagined live electronic event. The identity is a working title; no artist billing, date, or venue is implied. Each 11 × 17 inch (279.4 × 431.8 mm) portrait sheet uses five physical pen layers. Art and lettering are entirely plotted paths.

The private [Liner influence brief](/Users/chronick-mbp/git/liner/output/briefs/phase-garden-concert-triptych-2026-10-03.md) grounds the series in Autechre's system-based composition, Roel Funcken's reconstructed intervals and harmonic mass, and the shared concepts of negative space, material constraints, and beauty/brutality collision. These are original cross-media applications of musical mechanisms, not analyses of an unheard track or reproductions of either artist's visual work. Source interviews: [Autechre / FACT](https://www.factmag.com/2009/01/01/interview-autechre/) and [Roel Funcken / Headphone Commute](https://headphonecommute.com/2016/05/24/in-the-studio-with-roel-funcken/).

- **Breach Cathedral:** a vertical broken structure intersected by a dense, living membrane. Real shared depth removal makes the hard and soft forms occupy the same space.
- **Chamber Bloom:** an organic chamber under radial pressure, interrupted by engraved angular terraces. A 2D masking construction preserves the void and terrace faces.
- **Load Bearing Silence:** irregular architectural remnants arranged across a missing diagonal span. Thin branching sheets grow from one surviving side, leaving the central structural silence open.

The paper, type, and palette establish the family; each sketch owns its geometry. The Lettering group can edit title, header line, subtitle, footer, and face, or remove all text and rules for a fully abstract sheet. Architectural wire preserves the original outlined heading; diamond matrix is a second plotted face. Both modes fit the same fixed authored-art envelope with uniform scale, so seed variants are not resized according to their own bounds. Abstract mode centers that envelope in the full sheet interior, without a frame, crop, or stretch. Its scale remains limited by the artwork's width, leaving generous vertical paper where the composition is wide. The reusable `src/sketch/stroke-text.ts` API also lays text along an arbitrary polyline. Shared radar, macro, XY, and XYZ components remain declared over scalar parameters. XYZ is used for actual world-space placement in the two 3D studies. Fine controls and paper/export finishing are inherited from the sketch viewer.

Carbon carries structural weight, ultramarine sustains the body, vermilion marks interruptions, acid supplies sparse events, and violet joins delicate passages. A visually quieter layer is intentional; the inks are not meant to have equal path counts. Seed variation is evaluated as complete compositions, without silently combining favorite regions.

Open each entry with `npm run sketch -- open sketches/<name>/sketch.ts`. Export with `npm run sketch -- render sketches/<name>/sketch.ts --seed 17 --out .sketch-output/phase-garden/<name>/seed-17`. The names are `breach-cathedral`, `chamber-bloom`, and `load-bearing-silence`. Local seed galleries and control audits live under `.sketch-output/phase-garden/`.

## Original edition review

Nine complete sheets were visually reviewed at seeds 17, 73, and 211 for each sketch. The selected triptych is Breach Cathedral **211**, Chamber Bloom **17**, and Load Bearing Silence **211**. The first has the strongest asymmetric membrane silhouette; the second preserves a calm irregular chamber; the third balances broken architectural weight with branching growth. These are whole-sheet selections, not composites.

At that stage, all nine had five nonempty pen layers, no render diagnostics, finite page-bounded geometry, and exact repeated seed-17 identities. Default path counts ranged from 886 to 2,872 and pen-down length from 14.8 to 54.7 m. Thirteen matched control probes (including combined maxima and 3D hidden-line switches) changed geometry successfully. Source-code review and a 79-file / 1,349-test suite passed; corrected matched gap tests were rechecked afterward.

## Feedback edition

Breach Cathedral retains its depth-tested slab and membrane geometry. Chamber Bloom now gives a rigid, stepped buttress visual priority against the organic chamber. Load Bearing Silence contrasts smooth ribbon sheets with fractured structural solids. The three posters share an editable lettered mode and a fully abstract mode with no title, captions, or rules; the reusable `strokeTextOnPath` API also bends plotted glyphs along a polyline. A separate finishing border is configured at 12 mm from the sheet edge with a 6 mm gap to content.

The feedback gallery contains 18 complete renders: seeds 0, 17, and 211 in both modes for each sketch. All have five nonempty inks, no diagnostics, stroke-aware border clearance, and deterministic replay. The 82-file / 1,364-test suite passed, as did an independent review. These are local review artifacts; no remote upload or physical plot has been performed.
