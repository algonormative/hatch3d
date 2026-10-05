# Borrowed Orbits

Can a broken trajectory describe an unseen event? The masses are never drawn. The pen draws three things only: particle trails, a set of exact concentric guide circles about an apparent centre, and a few precise forbidden solids that end trajectories abruptly. The guides are the precise, artificial architecture; the trails are the natural paths that do not respect it.

The conceit is borrowing. Particles are seeded on the guide circles with the circular-orbit velocity about the apparent centre C, as if the mass sat at C. The real hidden mass sits displaced from C, so each orbit precesses, stretches into an ellipse, falls in or escapes. An optional hidden second mass passes through during the run and kinks the trails: the unseen event. Nothing in the drawing says where either mass is.

## Physical model

Newtonian gravity, Plummer-softened, in a restricted N-body approximation: attractors carry mass and exert force; test particles respond to every attractor and exert none. Force is explicit, `F = G·M·m·(y − x) / (|y − x|² + ε²)^{3/2}`, and acceleration is `F/m`; velocity changes only by `a·dt`, position only by `v·dt`, with a fixed-step kick-drift-kick leapfrog (`dt` = 0.1 s, a declared constant). Units are metres, seconds, kilograms; y grows downward like page millimetres. `G` is the real constant. The contract is `model.ts`; the integrator and its tests are `sim.ts` and `src/__tests__/borrowed-orbits-sim.test.ts`.

The world is 48 m x 78 m, the same as Prescribed Weather, and maps onto the Tabloid poster target at the same scale (about 5.07 page mm per metre; the double border enlarges it by about 1.9%).

- **Hidden mass.** At `C + (massDX, massDY)`, default offset (+3, +5) m, dynamic so a perturber can tug it. Its mass is set through time, the thing the eye perceives: `orbitPeriod` (default 60 s) is the period of a circular orbit at the middle guide radius `(guideInner + guideOuter)/2` (13 m by default) about the true mass, `M = 4π² r³ / (G T²)`. At the defaults that is **M = 3.61 x 10^11 kg** (a small mountain). Softening 0.6 m; a particle whose drift comes within `captureRadius` (1.2 m) is captured at the radius.
- **Particles.** `particlesPerGuide` (default 60) on each of `guideCount` (default 5) circles, evenly spaced (alternate rings offset by half a step) plus seeded angular jitter (0.35 of the spacing) and a seeded speed jitter (`speedJitter`, default 3%). Velocity blends by `borrow` between the circular velocity about the true mass (0: stable near-circular orbits about the hidden mass) and the circular velocity about C computed as if the mass were at C (1, default). `spin` picks clockwise or counter-clockwise revolution. Particle mass 1 kg (it cancels in `a = F/m`).
- **Perturber (the unseen event).** A second hidden dynamic mass `perturberRatio` (default 0.35) times the primary, on a straight entry: it heads along `perturberAngle` (degrees, y down) with `perturberSpeed` (default 2 m/s), passing `perturberImpact` metres to one side of C (signed, default 8 m), and reaches that closest-approach point at `perturberStep` (default 400, i.e. 40 s) if nothing deflected it. Its start is the closest-approach point minus velocity x time. Ratio 0 or the toggle off removes it from the simulation entirely.
- **Boundary.** `open` (default): trails continue past the frame and are clipped to it; a particle more than `escapeMargin` (30 m) outside the domain rectangle is marked escaped and stops. `absorb`: crossing the frame captures the particle at the crossing.
- **Forbidden regions.** `forbiddenLayout`: `none`, `bars` (default; `forbiddenCount` thin radial bars of 0.5 m, each between two guide rings and clear of both, at golden-angle spacing from a seeded phase, so raising the count only adds bars), `arc` (one 2.4 m band of a circle about a point behind it, passing a seeded distance from C and cutting across the guide field) or `gate` (two exactly mirror-symmetric slabs flanking C). A particle whose drift segment crosses one, or that starts inside one, is captured there. The test is a swept segment against every edge, so nothing tunnels through a region thinner than a step.

## Seeds

Two seeds are separate from day one. `structureSeed` (0..999) reseeds only the `structure` stream, the forbidden layout. `dynamicsSeed` (0..999) reseeds only the `dynamics` stream, the particle jitter. Value 0 uses the plain stream name, n > 0 uses `<name>#<n>`. Changing `dynamicsSeed` leaves the geometry hash unchanged; changing `structureSeed` leaves the particles' initial state unchanged. Dash phase comes from its own stream, `trail-dashes`, and is a drawing choice, not dynamics.

## What is drawn

Part ids are independent of simulation region ids: `trails`, `guides`, `forbidden-outline`, `forbidden-hatch`, plus a diagnostic part `orbit-state-step-<n>-key-<stateKey>` (or `orbit-state-off`) that carries snapshot identity into `result.json`.

- **Trails** run over the last `trailSteps` steps (default 400) ending at the print step `step` (default 600, in steps of 0.1 s), taken from `history(config, max(0, step - trailSteps), step)`. A captured particle's trail ends exactly at its capture point; an escaped one ends where it escaped; one that stopped before the window draws nothing. Each trail is simplified (Ramer-Douglas-Peucker, 0.05 page mm), clipped to the poster content frame, and pieces under 0.15 mm are dropped.
- **Taper** (default 0.5): the oldest `taper` fraction of each trail breaks into dashes that shrink from 3 mm to 0.5 mm and sit further apart (0.7 mm to 3.5 mm) toward the tail, so the pen reads as fading. Phase is seeded per particle. 0 is solid.
- **Trail minimum spacing** (`trailMinSpacing`, x pen width, default 0 = off) removes stacked ropes where many particles share a path, with `cullMinSpacing` from the cloud study, after taper and clipping, then re-simplifies the thinned ink.
- **Guides** are exact circles about C, polygons with chord error under 0.05 mm, drawn-only (no physics), cut where a forbidden solid stands.
- **Forbidden regions** are drawn as outline plus 45-degree parallel hatch (`hatchPitch`, default 1 mm) on the structure pen (carbon). The drawn polygon is smaller than the simulation's capture polygon by a fixed 0.1 m (about 0.5 page mm), so a trail ends exactly at its capture point yet keeps a visible gap from the outline. Overlapping bars hide each other.

## Off state

`orbitsEnabled` off draws guides and forbidden regions only. It never calls the simulation, and no simulation control changes the drawing.

## Controls

Simulation controls are `expensive`; the Marks group (`trailSteps`, `taper`, `trailMinSpacing`, `trailPen`, `drawGuides`, `guidePen`, `structurePen`, `hatchPitch`) only re-extracts marks from the same history and never changes the state key. Macros (neutral at 0.5): `displacement` moves the hidden mass (+12 m x, +20 m y over full travel); `disturbance` raises the perturber ratio (+1), lowers `borrow` (-0.4) and raises `speedJitter` (+0.06). Navigators: radar `event` (displacement, disturbance, taper), xy `hidden-mass`, xy `apparent-centre`, xyz `perturber` (angle, impact, step).

## Approximations and departures

- Restricted problem: particles neither attract each other nor pull on the masses.
- Leapfrog is second order and symplectic but not exact; orbits close to a mass with the 0.1 s step are the least accurate, and `softening` keeps close passes finite.
- Mass scale (10^11 kg) is an artistic departure so that tens-of-metres orbits take tens of seconds. The law is unchanged.
- A forbidden region is never physical: it is a perfect absorber at a gap from its drawn edge, and it is cut out of the guides.
- Seed points that fall inside a forbidden region (the arc and gate cross the guides) are captured at step 0 and draw no trail.
- Trails are an extraction of the history, not the history: simplified, dashed, clipped and optionally thinned.
