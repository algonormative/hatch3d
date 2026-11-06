# God in the Machine

A gold icon routed out of a silver circuit board. From an owner reference (2026-11-05): a saint whose body is serpentine traces, a ray halo, a board of chips and pads on a dark ground.

**Intent.** The figure is the one fluid thing on a rigid sheet. Dominant form: the bust, a single stripe field. Contrast: ridges that fork and wander against a grid of right angles and 45-degree bends. Focal event: the face, the only smooth form, engraved in lines that drop out with the light. Quiet paper: the keep-out around the figure and the bare chip bodies, the board's dark masses. Only the buses cross the keep-out.

**Deliberate departures.** Centred and frontal on purpose, for ritual and monumentality; the board carries the imbalance, and the flawed panel in the robe breaks the symmetry. `off-axis` and `half` are the ones that drop this.

## How it is drawn

- `field.ts`: stripes by iterating an oriented Gabor filter from noise. The zero set is closed loops that never cross, near half a wavelength apart, with forks where the direction field diverges. A plottable line by construction.
- `figure.ts`: silhouette, face relief, halo, all in a local frame carried to the page by `world`, so roll and scale reach everything. The face is scanlines bent by relief, tiered so lines drop out with the light and where they would crowd.
- `route.ts`: an octilinear A* router, with a price on turning.
- `board.ts`: chips, buses, free routes, then fill by occupancy map.

## What the controls change

| Group | The question | Main controls |
| ----- | ------------ | ------------- |
| Face | What is the face? | `face` engraved, contour, void, die; `eyes`; `thirdEye`; `glitch`; `light` |
| Body | What is the body made of? | `drape`; `rigid` (cloth to traces); `order` (labyrinth); `shade`; `wavelength`, `taper` |
| Halo | What does it radiate? | `halo` form; `span`, `reach`, `haloY` (a full turn low on the body is a mandorla); `rings`; `jog` |
| Meeting | How do saint and machine meet? | `keepout`; `dissolve`, `eroded`, `block`; `bus`, `busWidth` |
| Board | What kind of machine? | `chips` layout; `symmetric`; `mirror`; `density`, `cluster`; part mix; `routes`; `chipText`; `padPitch` |
| Placement, Figure | Whose scale? | `scale`, `top`, `figureX`; `flare`, `hair`, `neck`, `roll` |
| Ink | Which pen is what? | `figurePen`, `boardPen`, `haloPen`; `accent`, `liveNets` |

`seed` moves chips and changes the flaw, ridges and board; `bodySeed` and `boardSeed` re-roll one without the other. `starts.json` and `starts-portrait.json` hold the named variations. `portrait.ts` is the same piece on the upright sheet.

## Physical

Measured by finalize and ink-check on 5 variations (2026-11-05): about 20 minutes at gel speed, gold 17 to 31 m, silver 7 to 16 m; portrait gold up to 46 m. Not yet plotted. Fused gold is deliberate: long wires are tapered needles. Pads filled solid at the default `padPitch` of 0.45 mm fuse about 4 m of silver, and silver skips after dense fills, so a print sets `padPitch` to 0.8: Half fell from 4.4 m of fused silver to 43 mm. Tiny rings (BGA balls, halo pads) sit under the 1.0 mm clean radius on purpose and close into dots. Ridges stay above the 0.8 mm clean pitch apart from forks; face lines may close to 0.68 mm on lit planes, which brightens them, and never reach the 0.55 mm fuse pitch by their own spacing.

The fluoro accents are calibrated on black. A finalize stack names the `gold-silver-black` palette, which keeps the black paper and these inks (the default recolours), and `penNames`, so plotter-server asks for the right pen: see `half-stack.json`.
