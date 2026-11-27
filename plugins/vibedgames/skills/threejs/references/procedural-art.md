# Authored forms from code

For everything not worth a generation call: hazards, pickups, repeated props,
world kits, collision proxies, and the first pass of any object before its
art arrives. Heroes, creatures and anything organic come from
`vg generate 3d` (`model-catalog` → `references/3d.md`); props that hinge,
open or break come from `image-to-threejs`. What the frame should look like
is `look`; whether it's good enough is `game-playbook` →
`references/visual-bar.md`.

**Order: form, then materials, then light, then effects.** Glow does not
finish a primitive. A box with two cylinders and an emissive strip is a
placeholder however much bloom sits on it; recoloured cubes are one variant,
not a family.

## Modelling rules

- **Silhouette first.** The object reads as a black shape before any
  material. Test it: set every material to flat black against the sky.
- **Primitives are a base, not the model.** Combine them with extrusions,
  lathes, tubes, custom buffers and trim; add functional parts that explain
  the object (hinges, vents, fins, brackets, rails, bolts, cables, sensors)
  and a little asymmetry.
- **Detail where the camera looks.** Player-facing sides at play distance,
  never the underside.
- **States are swaps, not new meshes**: a material swap, an animated child,
  an emissive strip, an effect socket.
- **Collision proxy apart from the visual group**: one capsule, box or
  sphere group matching the gameplay footprint.
- **Name the parts that matter** (`cockpitGlass`, `leftEngine`, `hazardTeeth`,
  `pickupCore`, `collisionProxy`) so code, effects and tests can find them.
- **Share and instance.** One geometry and material per repeated bolt,
  panel, window, spike or rail segment.

## Geometry toolkit

| Class                   | For                                             |
| ----------------------- | ----------------------------------------------- |
| `ExtrudeGeometry`       | panels, fins, wings, badges, glyphs, signs      |
| `LatheGeometry`         | capsules, domes, engines, pipes, turret bases   |
| `TubeGeometry`          | cables, rails, conduits, curved blades          |
| custom `BufferGeometry` | tapered hulls, rocks, shards, wedges, terrain   |
| `ShapeGeometry`         | decals, flat icons, trim strips, hazard markers |
| `InstancedMesh`         | windows, bolts, lane markers, debris, grass     |
| `BatchedMesh`           | many different props sharing one material       |
| `LOD`                   | near and far versions of dense or heavy props   |

Real bevels too expensive? Fake them: a thin darker offset panel, an edge
strip, a duplicated trim mesh one notch out.

## Families by role

- **Vehicle** (runner, racer, ship, drone): tapered hull from an extrusion
  or custom buffer, a nose that says what it does (intake, blade, sensor
  strip), a canopy, engines with nozzle rings and a dark inner disc, fins
  with trim lines, undercarriage, decals, and state cues (boost flare,
  shield shell, scorch, overheat).
- **Character**, when one must be built in code: tapered limbs grouped
  under named joints (so procedural animation has pivots), separate armour
  plates, belt and pack, one identity mark (visor, crest, mask, tool), and
  material zones for skin, cloth, metal, glass. Stacked spheres are a
  placeholder.
- **Hazards and enemies**: each role its own silhouette, a danger material,
  a telegraph visible from distance, a state change before it acts, and a
  proxy. Low barrier, arch or gate, moving sweeper or crusher, zone or trap,
  enemy (core, sensor, weapon, locomotion base).
- **Rewards and interactables**: readable and wanted while the player is
  moving. A token (ring, core, value icon), a shard (facets, bracket,
  orbiting chips), a capsule (glass shell, item inside). A power-up's shape
  says its effect and differs from score pickups. Moving collectibles get
  idle, attract (only if attraction is a mechanic) and collect states.
- **World kit**: modular, instanceable pieces sized to the level plan —
  track plates and rails, arena tiles and spawn pads, city window strips and
  rooftop units, faceted rocks and crystals, industrial pipes and gantries,
  space debris. Build in layers: near props for speed and scale, mid props
  for the playable corridor, far silhouettes for depth at few draw calls.
  Every layer stays clear of threats and the next decision.

Build one representative scene at play distance with real feedback before
multiplying the kit.

## Material roles

Name a small set of shared materials by job and reuse them on every mesh
doing that job, instead of a colour per mesh:

| Role              | Job                                        |
| ----------------- | ------------------------------------------ |
| `bodyPrimary`     | dominant shell                             |
| `bodySecondary`   | contrast panels                            |
| `trim`            | rails, bevels, edge highlights             |
| `hazard`          | danger, damage, warning stripes            |
| `reward`          | collectibles                               |
| `status`          | shield, boost, buffs                       |
| `glass`           | canopy, lens, visor                        |
| `signal`          | authored emissive strips and lights        |
| `groundContact`   | dark matte under objects; shadow receivers |
| `decalDark/Light` | panel lines, scratches, numbers            |

World signal colours are the HUD's colour roles (`game-ui` → "Color roles"):
the same red means danger on a hazard and on the health bar. Separate roles
by roughness and metalness, not hue alone (values in
`graphics-recipes.md` → "PBR Material Recipes"). `MeshPhysicalMaterial`
only where clearcoat, transmission or sheen shows during play.

## Surface detail that scales

- Canvas-drawn trim sheets for panel lines, arrows, numbers and hazard
  stripes; one small shared wear or noise texture, not unique full-size
  images for tiny marks.
- Thin offset decal meshes for glyphs, faction marks and scuffs, with
  `polygonOffset` (`graphics-recipes.md` → "Z-Fighting").
- Reuse the HUD's icon shapes as world decals; it ties the two together.
- Every mark says scale, function, faction, route or state. Random noise
  is not detail.

## Factory contract

Each factory returns its group and what the game needs to know about it, so
an imported GLB can replace it later without touching callers:

```ts
type ModelFactoryResult = {
  root: THREE.Group;
  collision?: THREE.Object3D;
  sockets?: Record<string, THREE.Object3D>; // effect anchors: muzzle, exhaust, core
  bounds: THREE.Box3;
  stats: { meshes: number; materials: number; triangles: number };
};
```

Keep materials, geometry factories, the world kit, effects and render
settings in separate modules even in a small game. Generation never runs in
browser code; assets are generated to disk first (`generated-assets.md`).

## Instancing and LOD

- Instance copies that share geometry and material; set
  `instanceMatrix.needsUpdate` (and `instanceColor`) once after a batch of
  writes, and recompute bounds when instances move far, or the group culls
  wrongly.
- Different materials or per-frame transforms on every instance erase the
  win; collision stays separate from instanced detail.
- LOD only when an object spans a long distance range or a background role
  gets a heavy model. Leave a distance gap between levels so they don't pop,
  and check under the moving gameplay camera, not a static orbit.

---

Draws on [threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills)
(MIT, © 2026 Majid Manzarpour), rewritten for this skill set.
