# Chamber Bloom

**Format:** A3 portrait, 297 × 420 mm, 18 mm page margin. The image aperture is x 18–279 mm and y 76–357 mm on warm `#f4f0e6` paper. Five physical 0.25 mm pens draw carbon, ultramarine, vermilion, acid, and violet.

Chamber Bloom is one asymmetrical architectural organism. A quiet, off-center crater occupies its core. Densely nested cellular lamellae seem to grow around it, then disappear behind four angular terrace buttresses. Each buttress has stacked slabs, a carbon-engraved side face, narrow slit openings, and small vermilion registration ticks. Close paired lines engrave the inner and outer lips; short echo passages mark selected lamellae. Colored passages and a 64-step lattice of radial ribs make smaller events inside the large mass. At thumbnail scale, the intended read is a single damaged, flowering structure rather than a carpet of texture.

The musical references shape the construction, not its iconography. Autechre's system design and deliberate silence become a deterministic polar grammar interrupted by large, measured voids. Roel Funcken's 64-part reconstruction and harmonic mass become the rib lattice, grouped rests, and the tension between dense paired engraving and fine colored filaments. There are no depictions of synthesizers, modules, or sound waves. The result is an original plotter composition; the references do not claim to verify its visual quality.

## Construction

The seed independently sets crater displacement, lobe count, shell chirality and phase, terrace azimuths and widths, rhythmic phase, and accent sectors. Named streams keep these decisions stable when a fine control changes. Each shell lamella samples a slowly evolving lobed polar form. A secondary harmonic sharpens some cells; warp bends the shell without changing its underlying ring count. The terrace polygons are generated first and act as blank masks for every lamella and accent. Their edges and transverse slab lines are plotted in carbon. One face of each slab carries 1.2–1.4 mm spaced engraving, while the other retains open paper and slit apertures. Paths shorter than 0.5 mm are omitted.

The **Composition** radar controls pressure (shell spacing and rib count), cellularity (lobe count and warp), and rupture (terrace width and grouped rests). **Crater position** is a native XY control. Eight direct controls expose the underlying geometry and rhythm. The page remains two-dimensional; there is no synthetic depth axis. All loops are finite and seeded, and no raster blending is required.

Run `node --import tsx cli/sketch.ts render sketches/chamber-bloom/sketch.ts --seed 17 --out .sketch-output/phase-garden/chamber-bloom/seed-17` for a deterministic SVG, PNG, and JSON export. The preview establishes screen composition and physical line intent; it is not a test plot.
