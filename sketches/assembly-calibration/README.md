# Assembly calibration

A three-sheet test for the Breach triptych's paper stack: black paper at the bottom, gold-yellow over it, white on top. Each sheet is plotted on its own paper, knife-cut, trimmed at the crop marks, stacked flat and glued. It measures what the triptych needs before it is drawn:

- real line widths, and which inks read on which paper (swatches);
- how legible the cut guides are (four guide variants);
- how close art can sit to a knife cut (the margin ladder);
- how far lower art must run under an upper edge (the bleed ladders);
- how far apart the sheets register, read to 0.1 mm (four verniers);
- whether art ghosts through the paper above it (two sealed hatch boxes).

## Layout

One tabloid page (279.4 x 431.8 mm, margin 11 mm, so the finished trim is about 257 x 410 mm), the same world on every sheet:

| Where | What |
| --- | --- |
| W1, W2 (upper half, white sheet) | windows through to the gold sheet, 115 x 180 and 105 x 180 mm |
| G1 (gold sheet, 12 mm inside W2) | a window through to the black sheet, 81 x 156 mm |
| Swatches | each ply's inks on its own paper: black inside G1, gold inside W1, white in the lower half; trial inks marked "(trial)" |
| Guide variants A to D (white, lower half) | 44 x 24 mm windows with per-cut guide options (pitch 12 size 4, pitch 8 size 3, pitch 16 size 6, no label) |
| Margin ladders | four lines at 0.5, 1.0, 1.5, 2.0 mm from a cut: beside window E (white) and above G1 (gold) |
| Bleed ladders | seven lines ending -1 to 3 mm past an edge: gold toward W1's bottom edge, black toward G1's |
| Verniers | white over gold at W1, gold over black at G1, each an x vernier (bottom edge) and a y vernier (right edge) |
| Ghost boxes | silver hatch (black sheet) under gold and white; black hatch (gold sheet) under white; white captions above |

The `black`, `gold` and `white` plies are separate pieces of `stack.json` (`assembly: "calibration"`, the same seed). The stack allows trial inks (`defaults.trialInks`): gold on the gold-yellow paper and silver, fluoro pink and fluoro orange on the white. The page is fixed (the layout is in page millimetres); `date` is the only control besides the ply.

## Verniers

Each vernier stands across a window edge. The main scale is on the lower ply: 21 ticks at 1.00 mm (10 mm either side of its 0 tick, every fifth longer), sealed art that runs 4 mm under the upper paper. The vernier is on the upper ply's paper, starting 0.31 mm from the edge (inside the 0.3 mm art margin): 11 ticks at 0.90 mm, the 0 tick, then 5 and 10 longer. The 0 ticks line up when registration is perfect. The vernier tick that lines up with a main tick gives the tenths: if the upper sheet sits d mm in the + direction (right for x, down for y), the vernier's tick k stands at 0.9 k + d and meets the main tick j = 0.9 k + d, so d = j - 0.9 k, that is n + 0.1 k with n the main tick at or before the vernier's 0 tick. The lined-up main tick has to be on the 21-tick scale, so the tenths read for shifts from about -10 mm to +2 mm.

An x vernier reads left-right registration and so lies along a horizontal edge (its ticks stand across the edge and are spread along x); a y vernier lies along a vertical edge.

## Use

```bash
npm run finalize -- run sketches/assembly-calibration/stack.json
npm run plotter-check -- .sketch-output/finalize/assembly-calibration/*
npm run assembly -- preview sketches/assembly-calibration/stack.json
npm run print-queue -- sketches/assembly-calibration/stack.json --into <print-queue-dir> --prefix assembly-calibration --notes sketches/assembly-calibration/notes.json
```

`notes.json` holds each sheet's entry text: how to plot, cut, read each test and what to report back. No baseline is recorded: this is a test sheet, not a print.
