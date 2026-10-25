# Sculpted heads

A figure for the pen built as a signed distance field (SDF), meshed once, then drawn as lines that live on its surface:
engraving slices, meridians, spirals, plate seams, the silhouette. The kit is `sketches/kit/sculpt.ts` (solids and
surface lines), `sketches/kit/sculpt-head.ts` (a ready head and neck) and `sketches/kit/outline.ts` (cuttable window
rings). The worked example is `sketches/breach-triptych/upward-erasure/world.ts`; the tests are
`src/__tests__/sketch-kit-sculpt.test.ts`. Hidden-line projection comes from `sketches/kit/strokes.ts`
(see [wireframe-projection.md](wireframe-projection.md) and [hatching.md](hatching.md) for the general ideas).

## 1. Solids

An `Sdf` is `(x, y, z) => number`, negative inside. Model units are your own; place the result in the world with a matrix.

```ts
import { sphere, ellipsoid, capsule, hull, blend, meshSdf, sculptGeometry } from '../../kit/sculpt.ts';

const skull = ellipsoid([0, 0.13, -0.07], [0.30, 0.39, 0.40]);          // centre, radii
const arm   = capsule([0, 0, 0], [0, -1, 0], 0.15, 0.12);               // a, b, radius at a, radius at b
const wedge = hull([[0, 0.05, 0.33], [0, 0.02, 0.33], [0, -0.125, 0.5], [0.05, -0.16, 0.36], [-0.05, -0.16, 0.36]]);
```

`hull(points)` is sharp-edged and exact near its faces, only a lower bound off edges and corners: good for planar,
faceted forms. `ellipsoid` is exact on the axes and approximate elsewhere.

`blend(base, [shape, k], ...)` folds shapes into the base in order. `k >= 0` is a polynomial smooth union with blend
width `k` (0 is a hard union); `k < 0` carves the shape out with width `-k`.

```ts
const f = blend(skull,
  [capsule([-0.19, 0.11, 0.30], [0.19, 0.11, 0.30], 0.05), 0.08],   // brow, blended in
  [sphere([0.115, 0.05, 0.345], 0.05), -0.05],                       // eye socket, carved
);
```

`smin(a, b, k)` is the same blend on two raw distances; `gradient(f, x, y, z, h?)` is the field's gradient by central
differences.

`meshSdf(f, lo, hi, step, transform?)` meshes `f` inside the box `lo..hi` by naive surface nets, then snaps each vertex
onto the surface with four Newton steps along the gradient and takes the normal from the field. It returns a
`SculptMesh`: `pos`, `nrm` (Float64Array), `tri` (Uint32Array) in model units, and `transform` (model to world, default
identity). `sculptGeometry(mesh)` gives a `THREE.BufferGeometry` in world units for the depth pass.

## 2. The head

`sculptHead(options)` returns an idealised, androgynous head and neck, about 1 unit chin to crown: x to its left, y up,
z forward, origin roughly level with the ears.

```ts
import { sculptHead } from '../../kit/sculpt-head.ts';

const head = sculptHead({ noseShape: 'planar', nose: 1.4, tilt: 0.5, turn: -0.3, neck: 1.2, jaw: 1.2 });
const mesh = meshSdf(head.sdf, head.lo, head.hi, 0.009, transform);
```

Options (all optional; 1 is the canon unless noted):

| Option | Meaning |
| --- | --- |
| `tilt` | radians the head tips back on the neck (the face turns up), default 0 |
| `turn` | radians it turns to its left on the neck, default 0 |
| `neck`, `neckR` | neck length below the jaw (default 1.0) and radius (default 0.15) |
| `jaw` | how far the chin and jaw stand out |
| `nose` | nose length (default 1.25), `bulb` fullness of tip and wings |
| `noseShape` | `'round'` (default) or `'planar'`: a wedge with a sharp bridge, flat sides and underside |
| `chin`, `lips`, `brow`, `cheeks`, `ears`, `cranium`, `noseWidth`, `bridge` | feature scales |

The result:

- `sdf`, and `lo`/`hi`, the box to mesh.
- `place(q)` takes a point in the head's own frame (before tilt and turn) to the mesh's frame; `unplace(x, y, z)` goes
  back. Do feature work (zones, planes, distances) in the head's own frame, where the face is always upright.
- `parts.head` is the head alone, in its own frame; `parts.neck` is the neck alone, in the mesh's. Whichever is nearer
  says head or neck: `head.parts.head(...head.unplace(...p)) <= head.parts.neck(...p)`. Their difference is a smooth
  field that is zero where the two meet.
- `at`: landmarks on or just off the surface, in the mesh's frame: `noseTip`, `noseRoot`, `nostrils`, `lipUpper`,
  `lipLower`, `mouth`, `chin`, `chinUnder`, `eyes`, `brow`, `ears`, `crown`, `throat`, `neckBase`. Use them to centre a
  ring (nostrils), start a line (lip), or aim a camera.

## 3. Lines on the surface

`isoLines(mesh, value, spacing, level0 = 0, only?, phase?)` takes one scalar per vertex (a `Float64Array`) and returns
its level sets at `level0 + i * spacing`, or only at the levels in `only`, chained into polylines. Each `IsoLine` has
`level`, `index` (the integer `i`, for thinning every nth line) and `points: SurfacePoint[]` (`{ p, n }`, model-unit
position and unit normal). `perVertex(mesh, (p, n) => number)` builds the scalar. A vertex set to `NaN` drops the
triangles it touches, which is how you confine a family to a region.

The families you will use:

```ts
const hq = (fn: (q: V3) => number) => perVertex(mesh, p => fn(head.unplace(...p)));

isoLines(mesh, hq(q => q[1]), 0.02);                                   // level slices, in the head's own frame
isoLines(mesh, hq(q => q[0]), 1, 0, [0]);                              // the midline plane
isoLines(mesh, perVertex(mesh, p => Math.atan2(p[0], p[2])), 0.15);    // meridians round the neck
isoLines(mesh, perVertex(mesh, p => p[1]), 1, 0, [-0.5]);              // a single ring, by `only`
```

Any plane is `q . d` for a direction `d`; turning `d` per region gives plates of different hatch direction.

Spirals: pass an angle as `phase`, a distance as `value`, and make the distance advance by one `period` per turn.

```ts
const angle = hq(q => Math.atan2(q[1] - cy, q[2] - cz));
const dist  = hq(q => Math.hypot(q[1] - cy, q[2] - cz) / turnWidth * 2 * Math.PI);
isoLines(mesh, dist, 2 * Math.PI, 0, undefined, { values: angle, period: 2 * Math.PI });
```

Only the `phase` values are unwrapped (within each triangle), so the spiral breaks where the angle wraps, one piece per
turn.

The silhouette is `contourLines(mesh, eye)`, with `eye` in model units (`modelPoint(mesh, worldEye)` converts). It is
the zero set of the normal's dot product with the direction to the eye, smooth rather than polygonal, and includes
hidden stretches, which the depth pass removes.

`toWorld(mesh, points)` turns a line's points into `THREE.Vector3`s through `mesh.transform`. Then
`projectStrokes(strokes, { view, depth, width, height, bias }, hooks)` projects, clips and splits them by a depth buffer
(`renderDepthBufferCPU([sculptGeometry(mesh)], view, W, H)`); `hooks.begin(stroke, index, whole)` returns the receiver
for each stroke's visible runs. `hiddenBias(view, slack, distance)` gives the bias. `Upward Erasure` builds a `Mark`
list (points, pen, rank, id), runs `projectStrokes` once, and sorts the pieces into pens afterwards.

## 4. Plates

Cut the skin into plates, each engraved in its own direction:

```ts
const seeds  = scatterOn(mesh, minDist, rng, p => zoneOf(p) === 'plate', fixedSeeds.map(head.place), p => head.unplace(...p));
const plates = platesOn(mesh, seeds, p => head.unplace(...p));
```

`scatterOn(mesh, minDist, rng, keep, fixed?, frame?)` puts the `fixed` seeds first, then adds mesh vertices in a seeded
order wherever `keep` allows and none is nearer than `minDist` (measured in `frame`). `platesOn` returns per-vertex
`plate` (nearest seed), `second` (next nearest) and `gap` (how much nearer the first is), plus `at(p)` for any point.
Put seeds on the features (nose, lips, chin, brow) so each sits on one plate.

Hatch a plate by computing a plane scalar for the vertices where `plates.plate[v] === k || plates.second[v] === k`
(NaN elsewhere), then keep only points where `plates.at(sp.p).plate === k && plates.at(sp.p).gap > SEAM`. The hatch stops
short of every seam by `SEAM`, leaving a groove.

Draw the seam as the zero of the difference of the two seeds' distances, for each pair that touches:

```ts
value[v] = Math.hypot(...sub(q, seedA)) - Math.hypot(...sub(q, seedB));   // NaN unless v's plates are {a, b}
isoLines(mesh, value, 1, 0, [0]);
```

## 5. Cuttable windows

`traceMask(inside, box, cell = 0.25, { simplify?, minRadius?, minArea? })` samples an inside test on a grid of `cell` mm
over a `Rect` box, traces closed rings by marching squares, then relaxes and simplifies them. A region running off the
box is closed along the box edge. `minArea` (default 4 mm2) drops small loops; `simplify` defaults to `cell * 0.4`.
Rings are `Point[]` in the same units as the box. `outline.ts` also exports `relax`, `area` and `simplifyRing`.

```ts
const window = traceMask(windowAt, { x0: 0.2, x1: 279, y0: 0.2, y1: 431 }, 0.25, { simplify: 0.08, minRadius: 0.5, minArea: 6 });
```

`minRadius` (mm) closes then opens the region by a disc of that radius, so no notch, spike or corner is tighter than
the knife. This matters when the cut guide is offset: an offset of a ring with a sharp inside corner self-intersects,
and one with a thin spike disappears. Make `minRadius` at least the offset.

## 6. Lessons

These came out of building Upward Erasure.

- **Back-face cull hatch points.** Keep a point only if its normal faces the eye (`n . (eye - p) > 0`, see `facing` in
  `world.ts`). Grazing folds sit inside the depth test's slack and leak through it otherwise.
- **Zone by the head's own height, not just the normal.** A test on the normal alone reads the undersides of the
  cheekbones as jaw. Combine it with the height in the head's frame (`JAW`, `CROWN` in `world.ts`).
- **Spirals need only the angle unwrapped.** Unwrapping the whole sum puts points off the spiral; this is why `phase`
  exists and is separate from `value`.
- **Seams from the gap's level set are jagged.** The gap has a crease along the seam. Use the signed difference of
  distances for the line and the gap only for stopping the hatch short.
- **Cut rings need a morphological radius.** Cutting corners of a traced ring changes its shape unpredictably; use
  `minRadius`.
- **Lines hook into a smooth-union crease.** Where the jaw meets the neck the field bends and a line curls into the
  crease. Stop lines short on both sides (`zoneOf` leaves a gap of about 0.014 units around the seam).
- **Per-column random streams.** When a noise-driven glitch moves with a phase, give each column its own seeded stream
  so changing the phase does not reshuffle which column does what.

## 7. Speed

Meshing the head at step 0.009 head units takes about 10 to 15 seconds; use 0.015 to 0.02 for drafts (the step control in
`world.ts` runs 0.006 to 0.02). Cache the whole head stage at module level, keyed by the parameters that affect it and
the seed, so changing a later stage does not rebuild it: see `headStage` in `world.ts`, and
[sketch-lab.md](../sketch-lab.md) for the live viewer that benefits from it.
