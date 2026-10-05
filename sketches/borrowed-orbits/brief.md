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
- The hidden mass is pinned by default (`massPinned`): it is treated as far heavier than the perturber, so the pass bends the trails without carrying the centre away. In the pilot, with the mass free, a 0.35 mass-ratio pass flung both masses off the page and the drawing stopped describing a displaced centre. Turning `massPinned` off restores two-body motion.
- Mass scale (10^11 kg) is an artistic departure so that tens-of-metres orbits take tens of seconds. The law is unchanged.
- A forbidden region is never physical: it is a perfect absorber at a gap from its drawn edge, and it is cut out of the guides.
- Seed points that fall inside a forbidden region (the arc and gate cross the guides) are captured at step 0 and draw no trail.
- Trails are an extraction of the history, not the history: simplified, dashed, clipped and optionally thinned.

## Rapier evaluation (vault-28f4e)

This was evaluated as a decision, not installed. Rapier is not needed for this study.

- **What Borrowed Orbits needs.** It needs pair attraction toward a few point masses. It needs exact capture against static polygons and moving discs. It needs bitwise resume under its own hashed snapshot.
  - Capture is a swept test on each step's straight drift segment. That segment is the integrator's own path, so the test is exact. The whole pilot (300 particles, 2 masses, 8 bars) runs at about 13,000 steps/s.
  - Nothing bounces, rotates or stacks, so there is no contact response to solve.
- **What Rapier offers** (rapier.rs JS guide, checked 2026-10-04):
  - rigid bodies, colliders and joints, with CCD sweeping for fast bodies;
  - uniform world gravity with a per-body scale;
  - persistent per-body forces through `addForce`/`resetForces`;
  - cross-platform determinism for identical construction and order, with `world.takeSnapshot()` bytes that can be hashed.
- **The gap.** Rapier has no pair or central gravity. Using it would still mean computing the Newtonian force here and pushing it in with `addForce` each step. Rapier's own integrator would then replace the leapfrog, so the energy behaviour measured in the sim tests would have to be re-established. The snapshot hash would also cover Rapier's world bytes, so it would change with every Rapier version.
- **When to revisit.** Only for physical contact as an art goal: particles that bounce off architecture with restitution, or architecture that is knocked over or hinged. The Capture and Slingshot follow-up (vault-2t1zs) is the likely first candidate. Even then, keep the force provider here and use Rapier only for contact.

## Plates: Orbit Plates

The second round. The particle clouds of the first sketch read as noise on a plotter, so this is a three-plate set of clean orbital systems drawn as lines only: orbits, bodies as small exact circles, Lagrange points as small crosses, burns as short ticks. No text, no arrows, no dashes, no culling; the poster frame (the double border and the poster target) stays. The first-round sketch (`sketch.ts`, Borrowed Orbits) is untouched and remains the record of that round. The new sketch is `plates.ts` (name Orbit Plates) with `plates-study.ts` (setup), `plates-extract.ts` (drawing), `lagrange.ts` and `contour.ts` (drawn-only references). Everything that moves is integrated by `sim.ts` (MODEL 1.2.0: `settings.substeps`, `impulses`); analytic geometry appears only as drawn-only references: the Lagrange points and the zero-velocity curves.

Every plate is fitted to the poster target: rotated 90 degrees when that fills it better (`autoOrient`), centred, scaled to fill it inside `plateMargin` (default 0.08 of each side). Integrated lines are simplified with RDP at 0.02 page mm. The recorded steps are chosen so that no vertex of a drawn line is more than 0.05 page mm from the chord of its neighbours (measured in the tests: 0.001 to 0.037 mm), and the recorded `transforms.worldToPage` is a nominal constant, because each plate fits its own drawing and the mapping is not part of the simulation identity. Pens: orbits carbon, transfer and highlights vermilion, reference lines cyan, each with a select.

### SI scales

All plates use the real G, y grows downward, the world is the 48 m x 78 m of the first round, and each system sits at its centre. The simulation limit is 2400 recorded steps per run.

| plate | dt | length | mass | substeps | steps drawn |
| --- | --- | --- | --- | --- | --- |
| hohmann | 1 s | outer orbit 16 m | central 1.0e9 kg, pinned (GM 0.0667 m3/s2) | 8 | 1557 (the outer period) |
| lagrange | 0.5 s | separation a = 12 m | total 6.388e11 kg (binary period 40 s = 80 steps) | 16 | 1200 (15 binary periods) |
| threebody | T tau0 / (2400 k) | L0 = 4 m | 1e11 kg per body | 64 | k x 2400 per period |

The three-body conversion from G = m = 1 units: tau0 = sqrt(L0^3 / (G m0)) = 3.097 s, so x maps to L0 x, v to (L0 / tau0) v, t to tau0 t. Figure-eight: T = 19.59 s. A period longer than the 2400-step limit is integrated as k consecutive runs, each resumed from the exact final state of the previous (the state is synchronized at a step boundary, so the chain is the same computation as one run), and joined: k is 1 for the figure-eight, 16 for butterfly I, 4 for moth I and 32 for yin-yang Ia, chosen so the hairpin turns at the close encounters are sampled to the 0.05 mm criterion.

### Hohmann

A pinned central mass (a small circle) and `orbitCount` (2 to 6) concentric circular orbits, radius ratio `spacing` between neighbours (default 1.32), ending at the 16 m outer orbit. Each orbit is integrated for one full period from circular initial conditions; the radii are snapped to a whole number of steps per period (446, 677, 1026 and 1557 for the default four), so every circle closes on itself by construction: the measured closure error is 0.0003 page mm or less. Transfers (`transferMode` chain, or single with `transferIndex`): a transfer particle starts on orbit k and burns at its departure step (a scheduled impulse of the vis-viva delta-v1, 0.0066 m/s for the first default hop), coasts half an ellipse and is circularized at apoapsis (delta-v2, 0.0061 m/s). Only the arc between the burns is drawn, in vermilion; it ends within 2e-3 of the target radius in the test (the burn step is a whole step, so the apoapsis falls up to half a step away). Burn ticks are short strokes along the burn direction, standing 2.4 mm outside the orbit line, with length `tickScale` (mm per m/s) times delta-v. Planets are small circles on the source orbit at departure and on the target orbit at arrival, each an integrated test particle. `stagger` rotates successive chain departures so the arcs do not overlap, `hohmannPhase` is the first departure angle, `departureStep` delays every burn (the particles are placed so they reach the departure angle at that step).

### Lagrange (restricted three-body)

Two dynamic attractors on a circular binary with mass ratio `massRatio` (0.001 to 0.038; the Routh limit is 0.0385) and test particles, all integrated in the inertial frame. The drawing rotates every recorded position by minus the integrated binary angle about the integrated barycentre, so the primaries stand still: a drawing transform that never touches the simulation. Drawn: the two bodies as circles, L1 to L5 as crosses (L1 to L3 by Newton on the collinear equilibrium to 1e-15, L4 and L5 analytic), the zero-velocity curves, and the integrated orbits. The curves are level sets of the Jacobi field 2U = x^2 + y^2 + 2(1 - mu)/r1 + 2 mu/r2: marching squares on a 900-cell grid, joined into continuous polylines through shared cell edges, every vertex then projected exactly onto the level set (|C - level| below 1e-9) and segments split until the exact midpoint is within 0.015 mm. `zvcMode` necks (default) draws levels between consecutive critical values, so the L1, then L2, then L3 neck opens one at a time, plus a fourth level above C(L1) for `zvcCount` 4; `critical` draws the critical levels C(L1) to C(L4) themselves, C(L4) = 3 - mu (1 - mu). `orbitBoundaries` adds each orbit's own zero-velocity boundary at its Jacobi constant.

Orbits: 1 to 3 tadpoles about L4 and L5 and one horseshoe. A tadpole starts on the libration mode of the linearized motion with the velocity of the circular Kepler orbit about the primary; released at rest, or in the pure linear mode, the nonlinearity strings loops (epicycles) along the banana, so this start is chosen for clean lines (at mu 0.002; at larger mu the epicycle is physical and shows). `tadpoleAmplitude` is the x offset in units of a (0.09 default, successive tadpoles 1.3x larger); each is drawn for `tadpoleCycles` libration cycles (period 2 pi / omega, omega from the characteristic equation, 8.6 binary periods at mu 0.002). The horseshoe starts opposite the secondary on the circular orbit about the primary at radius 1 + `horseshoeOffset` (0.02): at mu 0.002 it stays between radii 0.91 and 1.08 and returns after about 15 binary periods (`periods`), but the horseshoe family is delicate: at mu 0.003 and above the same start scatters off the secondary. Jacobi constant along the integrated orbits is conserved to 2e-3 in the test.

### Three-body choreographies

One full period of all three bodies (three passes over the same curve for the figure-eight; three distinct curves for the others) or of body 1 only (`bodies`), the bodies as circles at `bodyPhase` (0 to 1 of the period). Catalog, in G = m = 1 units (positions, velocities in `plates-study.ts`):

- figure-eight: Chenciner and Montgomery (2000), Simo's initial conditions, T = 6.32591398. Return error 7.5e-8 under an independent RK4.
- butterfly I, moth I, yin-yang Ia: Suvakov and Dmitrasinovic, PRL 110, 114301 (2013), x1 = (-1, 0), x2 = (1, 0), x3 = 0, v1 = v2 = (p1, p2), v3 = -2 (p1, p2). The published values were verified by integrating one period with an independent RK4 (the sim is not used for this): butterfly I (0.30689, 0.12551, T 6.2356) returns with an error of 1.8e-3, moth I (0.46444, 0.39606, 14.8939) 3.6e-4, yin-yang Ia (0.51394, 0.30474, 17.3284) 1.5e-3. All three fail the 1e-3 criterion at five digits, so each was refined by Gauss-Newton shooting on (p1, p2, T) to the values in the catalog (butterfly I 0.306890725, 0.125507223, 6.234652214; moth I 0.464445173, 0.396060015, 14.894305175; yin-yang Ia 0.513938525, 0.30473592, 17.328833039), the same orbits to 5 or 6 digits, residual 2e-6, 1e-11 and 7e-8. The published T differs from the refined one at the fourth digit (butterfly 6.2356 against 6.23465), which is what the 1.8e-3 error was.
- Measured closure in the sim (page mm, first against last point of each body, with the k above): figure-eight 0.0000, butterfly I 0.0008, moth I 0.0003, yin-yang Ia 0.0013. With one 2400-step run (k = 1) the leapfrog does not close butterfly (0.12 mm) or yin-yang (about 0.9 mm); the chained runs are what make them close.

Softening is 4e-6 m (1e-6 of the length unit): negligible at these separations and finite at the closest encounters.

### Approximations and departures

- The leapfrog with substeps is second order; the closure and chord figures above are the measured consequences, not guarantees.
- The Hohmann burn is applied at a whole step, so the arc ends up to half a step before or after the exact apoapsis (within 2e-3 of r2).
- The Lagrange plate scale is set by the outer zero-velocity curves, so the orbits are small on the sheet; the plate trades their size for the classical reference lines.
- `horseshoe` is reliable only for mass ratios up to about 0.002.
