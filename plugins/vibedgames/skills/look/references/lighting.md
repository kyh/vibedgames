# Lighting a 3D game

The goal is a place that reads, with characters that never turn into
silhouettes. API details (shadow maps, acne, bias) are in `threejs` →
`references/graphics-recipes.md`.

## Characters first

- **No character is a silhouette.** Every character, creature and held item
  shows form and colour against every background it appears on. Add a rim or
  back light relative to the camera before making the key light prettier.
- **Light about the line to the eye.** Under a wide lens a figure at the frame
  edge must show a lit side and a shade side just like one at the centre. A
  key that only works from the default camera angle fails at the edges.
- **Shadow is darker than light, and a different temperature.** Shaded faces
  of a material are clearly darker than lit faces, warm against cool.

## Budget the lights on day one

- Count every visible thing that looks like it emits light, and measure how
  many real lights the renderer can afford (including what adaptive quality
  does to that number) **before** anyone tunes.
- **One shadow-casting key.** One directional light casts the world's
  shadows. Its shadow camera covers the play area around the player only, and
  follows the player in texel-sized steps so shadow edges don't crawl as they
  walk.
- **A fixed pool of real lights.** The number of point/spot lights never
  changes during play (adding or removing lights recompiles shaders mid-game).
  Keep N lights in the scene and move them to the lamps that matter most near
  the camera, fading intensity rather than swapping.
- **Emissive is not a light.** Anything that looks like it lights its
  surroundings does, through a pool light or baked light. Otherwise it reads
  as a sticker.

## Exposure

- **Expose each map from a meter.** Pick written targets per map: share of
  blown pixels (≤ 1%), share of crushed pixels, mean luminance of the play
  area. Read them from a capture of the player's camera; adjust the light,
  then exposure.
- **Darkness is reached with light, not exposure.** A dark scene is made by
  removing light, not by turning the camera down. Keep the population (enemies,
  pickups) visible in it, measured with them present.
- **Auto-exposure, if any, meters what is lit** and adapts slowly, so a lit
  subject never burns white, unlit space can fall to black, and a muzzle
  flash never strobes the whole frame.
- **One owner for exposure**, and each screen (arena, menu, results) has its
  own rig. A menu's lights never leak into play.

## Indirect light and reflections

- **Bounce is real.** A sunlit floor warms the wall beside it; a corridor is
  darker than a courtyard. Use baked lightmaps, light probes
  (`LightProbeGenerator`, irradiance volumes) or AO, not a brighter ambient.
- **Reflections show something real**: an environment map from the sky or a
  probe of the place (`PMREMGenerator`), never a default studio HDR in a cave.
- **Effects take the scene's light.** Particles, smoke and decals are lit by
  where they are, unless they emit.

## First person: hands, held items, carried lights

- **A carried light leaves from its mount**, with a hot centre and soft spill,
  and the player's own body or weapon never shadows it.
- **Hands and held items read in the dark.** Light them with a fill that only
  affects the view model (a separate layer or scene rendered over the world),
  so they stay readable, stay darker than the brightest lit world surface,
  and never pump with exposure.
- **View-model fills never reach the world**, and the view model never casts
  into it.
- Before editing a near-camera texture, find which light term (direct,
  ambient, environment, emissive) carries its brightness.
