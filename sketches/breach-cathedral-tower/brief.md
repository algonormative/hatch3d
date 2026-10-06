# Breach Cathedral: Tower

A full-height fork of [Breach Cathedral](../breach-cathedral/brief.md). The original sits in a short, wide envelope; this edition is authored directly in page millimetres on the tall `TALL_ART` envelope (x 18–261.4, y 18–413.8), so abstract mode is the identity mapping.

- **Tower.** 15–21 cantilevered slab levels (default 17) span the sheet height in the original's slab grammar: front, side and top courses, transverse load lines, blades and counter-slabs, behind a long left pier and a broken right one. Slab inner edges stop short of the centre, so an empty shaft runs top to bottom. Hatch loudness follows a hierarchy: heavy at the bearing base and around the breach, open at the crown.
- **Twin helix.** Two ribbed, contour-laminated strands share seeded turns and handedness, with a seeded phase offset and staggered ends. Strand A has an ultramarine body with violet lamellae, an acid spine and the 64 pulses. Strand B has a violet body with ultramarine and vermilion ribs. Both are in the same CPU depth pass as every solid, so they genuinely pass in front of, behind and through the slabs. The strands swell outward at the breach.
- **Collapse.** In a seeded band (`collapseHeight`, `collapse`) the core empties entirely. Slabs shear, rotate and fall outward and downward, cantilevers snap into stubs at the band edges, both piers break, and smaller fragments (`debris`) scatter below.

Line spacing: the front hatch is clamped to a perpendicular gap of at least 0.5 mm. Membrane laminations are thinned per sub-segment in screen space to at least 0.55 mm across tapers and edge-on folds, and ribs to at least 1.1 mm along the strand.

At defaults the art uses roughly 3.6–3.9k paths and 40–43 m of pen-down travel, plus a 2.6 m border. The composition radar is mass, rupture, growth and braid; organic focus XY moves only the strands; world XYZ moves the whole scene.

Seed 211 is the proof, with 17 and 73 as alternates. Render:

```bash
node --import tsx cli/sketch.ts render sketches/breach-cathedral-tower/sketch.ts --seed 211 \
  --finishing '{"border":{"style":"double","pen":"carbon","inset":12,"contentGap":6}}' --out .sketch-output/heat/tower/final/s211
```
