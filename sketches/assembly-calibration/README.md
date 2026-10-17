# Assembly calibration

A three-sheet test for the Breach triptych's paper stack: white paper at the back (the bottom), gold-yellow over it, black in front (the top). Each sheet is plotted on its own paper, knife-cut, trimmed at the crop marks, stacked flat and glued. It measures what the triptych needs before it is drawn:

- real line widths, and which inks read on which paper (swatches);
- how legible the cut guides are (four guide variants);
- how close art can sit to a knife cut (the margin ladder);
- how far lower art must run under an upper edge (the bleed ladders);
- how far apart the sheets register, read to 0.1 mm (four verniers);
- whether ink on the white sheet ghosts through the gold-yellow paper over it (one sealed hatch box; nothing ghosts through the black in front).
- the smallest legible stroke-text size per ink per paper, in sans and script (the font test).
- the tightest hatch and outline spacing that stays separate, the shortest clean dash and smallest clean circle, smear at ink crossings, what the knife can cut (wedges, slots, bridges, a notch) and where the plot lands on the paper (edge rulers).

The blocks a lower sheet hides once glued (the white's tests, the gold's lower half) are drawn as sealed art: they are read on the loose sheets before gluing. The front black sheet has nothing over it, so nothing on it is sealed.

## Layout

One tabloid page (279.4 x 431.8 mm, margin 11 mm, so the finished trim is about 257 x 410 mm), the same world on every sheet:

| Where | What |
| --- | --- |
| W1, W2 (upper half, black sheet) | windows through to the gold sheet, 115 x 180 and 105 x 180 mm |
| G1 (gold sheet, 12 mm inside W2) | a window through to the white sheet, 81 x 156 mm |
| Swatches | each ply's inks on its own paper: the white's seven inside G1 (one column), gold's inside W1, all thirteen of the black's in four columns in the lower half; every test labelled with its pen (see below) |
| Guide variants A to D (black sheet) | 44 x 24 mm windows with per-cut guide options (pitch 12 size 4, pitch 8 size 3, pitch 16 size 6, no label) |
| Margin ladders | four lines at 0.5, 1.0, 1.5, 2.0 mm from a cut: beside window E (black) and above G1 (gold) |
| Bleed ladders | seven lines ending -1 to 3 mm past an edge: gold toward W1's bottom edge (runs under the black), white toward G1's (runs under the gold) |
| Verniers | black over gold at W1, gold over white at G1, each an x vernier (bottom edge) and a y vernier (right edge) |
| Ghost box | one carbon (Micron 01) hatch, 40 x 14 mm, on the white sheet under the gold inside W1, with the caption "is there a ghost here?" in black ink on the gold over it |
| Font test | per ink: "line" in Hershey sans and script at 1.5, 2.0, 2.6, 3.5, 5 mm, and "everything falls into line" at 2.6 mm: gold's in W1 below its swatches, black's in the lower half on the right, white's sealed under the gold and black (read it before gluing); black: Signo gold, silver and Moonlight fl pink only, white: all seven inks |
| Spacing ladder | per ink: hatch patches at 0.40 to 1.00 mm, squares outlined twice and three times at 0.6 to 1.2 mm (black: the same three triptych inks; white: all seven, sealed; gold: its five, under the black) |
| Dots, dashes, curves | per ink: dashes 0.3 to 1.6 mm, dots (0.3 to 0.4 mm strokes), crosses 0.8 to 1.6 mm, circles r 0.5 to 4 mm, a spiral |
| Ink crossings | black: every pair of Signo gold, silver and Moonlight fl pink (6 mm cells); white: every pair of its seven inks, sealed; the later pen on top |
| Cut ladder (gold, lower left, hidden under the black) | wedges 60 to 20 degrees, slots 3 to 6 mm, islands held by bridges 2 to 4 mm, a notch open to the trim |
| Edge rulers | every sheet, the middle of each side: lines 12, 13, 14, 16 mm from the paper edge (art cannot go past the crop line) |

The `black`, `gold` and `white` plies are separate pieces of `stack.json` (`assembly: "calibration"`, the same seed). The stack allows trial inks (`defaults.trialInks`): the white Signo and the non-fluorescent Moonlights on the black, gold, ultramarine and violet on the gold-yellow, and silver, fluoro pink and fluoro orange on the white.

Since R12 the sheets carry the pens Nick has (each ink's `pen` and `nominal` in `src/sketch/materials.ts`: Pigma Microns on white and gold-yellow, Signo 1.0mm gel pens and Gelly Roll Moonlight 10s on black), and every test is labelled in its own ink with the pen's name and nominal line width (`penLabel`), so a photo of a sheet says which pen drew each line. Each sheet's notes list its pens in plot order.

Since R13 the stack is turned over: white at the back, gold-yellow in the middle, black in front (plotted in that order). The windows W1, W2, A to E are cut in the black, G1 in the gold; the front black sheet carries only the three triptych inks' font, spacing, marks and crossing tests, and the white carries all seven inks' tests, sealed. The page is fixed (the layout is in page millimetres); `date` is the only control besides the ply.

## Verniers

Each vernier stands across a window edge. The main scale is on the lower ply (the gold at W1, the white at G1): 21 ticks at 1.00 mm (10 mm either side of its 0 tick, every fifth longer), sealed art that runs 4 mm under the upper paper. The vernier is on the upper ply's paper, starting 0.31 mm from the edge (inside the 0.3 mm art margin): 11 ticks at 0.90 mm, the 0 tick, then 5 and 10 longer. The 0 ticks line up when registration is perfect. The vernier tick that lines up with a main tick gives the tenths: if the upper sheet sits d mm in the + direction (right for x, down for y), the vernier's tick k stands at 0.9 k + d and meets the main tick j = 0.9 k + d, so d = j - 0.9 k, that is n + 0.1 k with n the main tick at or before the vernier's 0 tick. The lined-up main tick has to be on the 21-tick scale, so the tenths read for shifts from about -10 mm to +2 mm.

An x vernier reads left-right registration and so lies along a horizontal edge (its ticks stand across the edge and are spread along x); a y vernier lies along a vertical edge.

## Use

```bash
npm run finalize -- run sketches/assembly-calibration/stack.json
npm run plotter-check -- .sketch-output/finalize/assembly-calibration/*
npm run assembly -- preview sketches/assembly-calibration/stack.json
npm run print-queue -- sketches/assembly-calibration/stack.json --into <print-queue-dir> --prefix assembly-calibration --notes sketches/assembly-calibration/notes.json
```

`notes.json` holds each sheet's entry text: how to plot, cut, read each test and what to report back. No baseline is recorded: this is a test sheet, not a print.
