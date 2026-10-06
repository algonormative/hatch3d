# Chamber Bloom: Plonk

**Format:** Tabloid portrait, 279.4 × 431.8 mm, warm `#f4f0e6` paper, authored on `TALL_ART` (abstract mode, the default, draws in page millimetres across x 18–261.4, y 18–413.8). The five 0.25 mm pens are the same as Chamber Bloom's.

One cell, one plank, one floor. A heavy plank has just landed on a single lobed cell, and the bottom of the inner frame is the floor. The cell is flattened under the slab and puffs up around both ends of it like dough, with its area conserved. Its lamellae crowd into dense bands against the slab and the floor, and open out where the cell bulges. The crater squashes into a wide, slightly grinning oval and stays open paper. The slab sits tilted, so one end bites deeper, and that pinch goes vermilion. Acid ticks mark the impact at both ends of the slab and where the base lifts off the floor. Violet fall lines above say it only just arrived. Optionally, one to three tiny cells have been squeezed out onto the floor. There is no text and there are no faces. The thumbnail should read: heavy thing landed on soft thing.

## Construction

The rest cell is an upright lobed oval with the original petal grammar. Squash sets the gap between the floor and the slab's underside at the cell's centre. A natural shape that overshoots both clamps is cut by the slab's underside and by the floor, using a smooth minimum along rays from the cell origin. The underside curls up past each end, behind the slab, so the dough wraps the corners. Muffin "ears" rise just outside the ends. The half-width is solved so the clamped outline keeps the rest area exactly. At high squash the pancake spills past the side margins, because a conserved area cannot also fit a 243 mm aperture.

The lamellae are level sets of the radial fraction `t = (r − crater) / (membrane − crater)`, so their count is fixed and they crowd wherever the cell is pressed thin. Seen from one centre, a flat slab would crease every ring down to the crater. The field is therefore diffused coarse to fine, by about 17 mm, with both boundaries held. Near the membrane it blends back to the raw fraction so the thin ears still fill with rings. The pressed rays then bunch further toward the membrane. A per-ray limit keeps the outermost gap at or above 0.68 mm, and a spatial-hash guard after Pressure Foam cuts any shell line closer than 0.54 mm to another. A line resumes only a clear 0.6 mm after its own cut. Paths shorter than 0.5 mm are dropped.

The slab is the stepped buttress turned into a single plank. It has square setbacks on one straight axis, a dense slanted carbon engraving on its lower face, and wavering wood grain that parts around one knot on the upper face. It masks every cell line, with a 0.62 mm clearance.

Seeded streams (`plonk-placement`, `-anatomy`, `-plank`, `-grain`, `-droplets`, `-rhythm`) keep the cell, slab and grain fixed while squash or the comic controls move.

## Controls

The **Composition** radar has three axes. Impact drives squash, tilt and impact marks. Ooze drives lobes, warp and droplets. Heft drives plank weight, plank width and finer lamellae. The direct controls are squash (0 is just touching, 1 is pancake), plank tilt, plank weight and width, cell lobes, warp, lamella spacing, impact marks and droplets.

At the defaults, seed 17 draws about 320 paths and 17 m of pen-down. Software checks cover determinism, the five inks, bounds, the budget, the slab mask, spacing, pressure contrast, squash monotonicity with area, and the open crater. Physical pen density in the pressed bands still needs a test plot.

Run `node --import tsx cli/sketch.ts render sketches/chamber-bloom-plonk/sketch.ts --seed 17 --out .sketch-output/heat/plonk/seed-17`.
