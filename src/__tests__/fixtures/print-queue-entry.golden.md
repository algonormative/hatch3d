---
title: "Breach Tarot: XXI The World"
created: 2026-10-07
status: prepped
tags: [print-queue, hatch3d, breach-tarot, phase-garden, multi-pen]
composition: breach-tarot/xxi-world
seed: 3
edition: "v1"
build: abc1234
palette: phase-garden
paper: "#f4f0e6"
pens: 2
estimated_minutes: 24
source_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
prepared_sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
art_identity: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
references:
  - type: repo
    url: "https://github.com/algonormative/hatch3d"
    local: "<ROOT>"
---

# Breach Tarot: XXI The World

![preview](render.png)

A card.

## Files

- `render.svg` is the canonical render and the source of truth. Never modify it. Its art is the sketch's own render (identity `cccccccccccc`), matched path for path (12,772 paths, worst 0.001 mm) under the border's fit, scale 0.98151.
- `plot-ready.svg` is the vpype-prepared derivative, with the same pen plan. It passed plotter-server's `validatePreparedPenPlan` and `buildPenPlan` against `render.svg` and `config.json` (`cli/plotter-check.ts`, with a negative control rejected).
- `config.json` is the plotter-server queue config (`hatch3d-sketch-v1`).
- `request.json` is the exact render request.
- `finalize-report.json` holds the options, the vpype arguments and the build.

To regenerate, run this at hatch3d `abc1234` (branch `main`):

`node --import tsx cli/finalize.ts run sketches/phase-garden/stacks/tarot.json --only xxi-world`

## Pen plan

Plot in layer order and do not move the paper between layers.

| Layer | Ink | Paths | Ink (m) | Travel (m) | Minutes |
| --- | --- | ---: | ---: | ---: | ---: |
| 1-carbon | #22282c | 4,592 | 41.2 | 9.9 | 13.5 |
| 2-lettering | #22282c | 17 | 0.0 | 0.2 | 0.0 |

- Layer 2 (lettering) is drawn at 0.13 mm, so use a fine pen.
- The estimate is rough: 60 mm/s drawing, 200 mm/s travel, and one minute per pen change.

## Status

Not uploaded to the plotter-server queue and not plotted. Queue upload, server import and physical start each need explicit approval.
