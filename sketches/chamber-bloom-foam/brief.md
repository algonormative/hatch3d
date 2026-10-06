# Chamber Bloom: Pressure Foam

**Format:** Tabloid portrait, 279.4 × 431.8 mm, warm `#f4f0e6` paper. Authored on `TALL_ART`, so abstract mode (the default) draws in page millimetres across the full x 18–261.4, y 18–413.8 aperture. The five 0.25 mm pens are the same as in Chamber Bloom.

This is a hotter, full-height fork of Chamber Bloom. A sweep of the original found the same single ring with radial buttresses at every setting, filling about 60% of the sheet. Here, two to four seeded chambers press against one another. One is dominant and the others subordinate. Each keeps the original shell grammar: a quiet open crater, nested lobed lamellae, grouped 64-step rests, a hot vermilion inner lip, and acid ribs.

Where chambers meet, the lamellae flatten into a shared carbon wall, and their spacing tightens toward that wall. This compression is the tonal drawing: dark pressure seams and Y-junctions against open interiors. One huge stepped buttress cuts straight through the cluster and masks every lamella it crosses. It has square setbacks, a diagonal carbon-engraved face, slits, and vermilion registration offsets. Optional minor terraces radiate from the dominant crater and pass behind it.

## Construction

Ownership is a multiplicatively weighted Voronoi of smooth elliptic depths, so walls are calm membranes. The lobed depth (a fixed-point inversion of the original polar shell) draws the rings. Lamellae are marching-squares contours of `smin(R, W)`. Here `R` is the ring depth in millimetres, and `W` compresses the first-order distance to the nearest wall by `D + P·λ·(1 − e^(−D/λ))`. `P` is clamped so the design pitch at a wall never drops below 0.64 mm. The aperture presses only halfway, so frame-bound rings soften rather than nest as boxes. A spatial-hash guard then cuts any shell line closer than 0.54 mm to another, or to a distant stretch of itself, so the 0.5 mm floor holds. Accent colours and rests are debounced so no crumbs or sub-0.6 mm gaps remain.

## Controls

The **Composition** radar has three axes:

- Compression: pressure up, lamella spacing down, dominant size up.
- Cellularity: lobes, warp and chamber count.
- Rupture: buttress width and minor terraces.

**Dominant crater** is an XY control. Direct controls cover the chamber count, wall pressure, dominant size, lamella spacing, lobes, warp, buttress angle, width and offset, and minor terraces. A seed may mirror the buttress angle and offset side.

Default seed 307 draws 769 paths and about 31.3 m of art (33.9 m with the double border). Seeds 29 and 3 are the strongest alternates. The seams have not been test-plotted, so their density still needs a physical plot on paper.
