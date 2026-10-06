# References

House rule: anything hatch3d implements or redistributes cites its sources, including both the work behind the idea and the software that shipped it. This file is new, and earlier techniques have not been back-filled yet.

## Stroke text: `sans` and `script` faces

`packages/plot-core/src/hershey-data.ts` is a generated table of single-stroke glyphs for printable ASCII 32–126. It is used by the `sans` and `script` faces in `packages/plot-core/src/stroke-text.ts`.

- A. V. Hershey, *Calligraphy for Computers*, NWL Report No. 2101, U.S. Naval Weapons Laboratory, Dahlgren VA, 1967. The fonts were distributed by the U.S. National Bureau of Standards (NBS). They are public domain, and their use carries the customary request to credit A. V. Hershey and NBS.
  - The coordinate tables were published as N. M. Wolcott and J. Hilsenrath, *A Contribution to Computer Typesetting Techniques: Tables of Coordinates for Hershey's Repertory of Occidental Type Fonts and Graphic Symbols*, NBS Special Publication 424, 1976.
  - `sans` is Hershey Simplex Sans (`futural`).
  - `script` is Hershey Script Simplex (`scripts`).
- Software lineage:
  - [fogleman/axi](https://github.com/fogleman/axi) (MIT, © 2017 Michael Fogleman) repackaged the Hershey data as Python tables (`axi/hershey_fonts.py`).
  - [vpype](https://github.com/abey79/vpype) (MIT) bundles those tables as `vpype/fonts/*.pickle`.
  - The table here was extracted from the vpype pickles. The generator and the source hashes are recorded in the file's header.
