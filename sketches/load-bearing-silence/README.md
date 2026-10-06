# Load Bearing Silence

An eight-pen Tabloid study of a broken bridge, light sheet, and quiet singularity. The [brief](brief.md) explains the composition and controls. The default sketch retains the original bridge and light geometry; the saved [atmospheric span](configs/atmospheric-span.json) adds outer decks and portals that dissolve into cyan contour hatches. [Cloudbank](configs/cloudbank.json) keeps the same structural reach with denser, stronger clouds and no competing branch growth.

From the Hatch3D repository root:

```bash
npm run sketch -- render sketches/load-bearing-silence/sketch.ts --config sketches/load-bearing-silence/configs/atmospheric-span.json --out .sketch-output/load-bearing-silence/atmospheric-span
npm run sketch -- open sketches/load-bearing-silence/sketch.ts
```

The bridge continues past its authored art window toward the final usable frame. Depth occlusion includes the outer members, and the atmosphere cuts their visible lines before adding cloud marks. The poster finishing pass still clips every mark to the physical content area and keeps lettered layouts clear of the header and footer. These previews are design studies; pen density and registration need a test plot before printing.
