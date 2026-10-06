# Breach Cathedral: Agent

A fork of [Breach Cathedral](../breach-cathedral/brief.md). The original is "a system being interrupted by a living one". Here the living force has put on the system's suit: "some otherworldly force is showing itself as an agent of the system" (owner, 2026-10-05, from a reference image of a seated wireframe figure in a suit with a ribbon-helix head on a throne of beams).

- **Stance.** The camera stands to the right and below, so the agent towers over the eye. Its shoulders turn toward the gaze, and the head looks up and to the viewer's left (`gazeTurn`, `gazeLift`, seeded jitter). A beam of straight lines leaves the face along the gaze (`beam`). Each seed sets the legs (apart, together or crossed, with the crossing shoe off the floor), resting or clutching hands, and the head angle; `legs` overrides the seed.
- **Abstraction.** The limbs and trunk are cut into planes (`facets`, default 6; 0 = smooth). Each plane takes one value from the light, and its edges are crisp carbon lines.
- **The agent.** A seated figure built from parametric tubes (trunk, thighs, shins, upper arms, forearms), with block hands gripping the armrests and block shoes. It sits in the same CPU depth pass as everything else, so it occludes the throne and is occluded by it.
- **Cloth.** The default is a tailored pinstripe suit:
  - stripes run along each garment piece, with vermilion side seams, cuffs and trouser hems, carbon trouser creases and shirt cuffs, and silhouettes traced where each surface turns edge-on;
  - rings cross-hatch the stripes in the deepest shadow and are the only hatch on the domed knees, shoulders and elbows;
  - lapels, a striped tie and a collar sit over the trunk, and the shirt in the opening stays paper.
  
  `cloth: ribbon` swaps the suit for the helix membrane wound round the body, with 64-step rests.
- **The force.** The head is one helix strand wound into an egg-shaped skull. Where it passes in front of the face it narrows to an opening that looks out. The system pierces it: a few large slabs, heavy beams or broad plates, are driven straight through the head along one seeded direction and stand well out of the cage on both sides (`pierce`). Above the crown a second strand joins the head strand, and both unwind and flare up into the breach. It stops short of the art edge, so it never reads as cropped.
- **Impressionistic value.** The head is the light. Stripe density follows an aura that falls off with distance from the head, modulated by facing and broken up by seeded low-frequency noise:
  - near the head the suit blows out to paper;
  - the trousers and the base stay heavy.
  
  The same field quiets the slabs near the head. Acid rays leave the head on a plane behind the throne, dashed in one fixed 64-step rhythm.
- **The system.** A cathedral throne of slabs, using the Tower's slab grammar: plinth, seat, armrests, legs, back posts and rails. Behind it is a cathedral of cantilevered wall slabs, laid out by where the camera sees them so they frame both sides.
- **The breach.** The crest rail breaks open above the head and its shards lift. Wall slabs near the head are pushed back. Fragments rise around the head, and debris stays inside the frame and off the body.

Line spacing: stripe, lamination and rib strides double in screen space until neighbours are at least 0.55 mm apart.

At defaults the art is about 4–5k paths and 60–68 m of pen-down travel, using the Tower's six pens (finalizer-compatible). Seed 3 (crossed legs) is the owner's pick.

```bash
node --import tsx cli/sketch.ts render sketches/breach-cathedral-agent/sketch.ts --seed 3 \
  --finishing '{"border":{"style":"double","pen":"carbon","inset":12,"contentGap":6}}' --out .sketch-output/agent/s3
```
