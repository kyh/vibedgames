---
name: look
description: "Art-direct a 3D browser game's image: turn a reference into pass/fail statements, one tone curve, sky/fog/horizon, lens, a grade per level, honest materials, lighting that keeps characters readable, exposure from a meter, shimmer-free detail. Use when it looks flat, washed out, plastic, too dark, like a prototype, or the person wants a cinematic or AAA look."
---

# The look

This is art direction for a three.js (or any 3D) game: what the frame should
look like and how to tell whether it does. The `threejs` skill owns the API
(materials, post, shadows, z-fighting fixes); this skill owns the decisions.
Lighting specifics: [references/lighting.md](references/lighting.md). The bar
and the critic loop that judge it: `game-playbook` →
`references/visual-bar.md`, `references/critic-loop.md`,
`references/quality-bar.md`.

## 1. Write the look down before you tune it

- **Turn the reference into statements a stranger can mark pass or fail** on a
  capture. Not "make it moody" but "with nothing lit, the night is near black,
  not dusk blue"; "the player always shows a lit side and a shade side";
  "vertical FOV 55°". Cover the lens, exposure, where light comes from, the
  palette, the ground, the hands or held item, the HUD.
- **Measure the reference.** Sample its frames: average luminance, share of
  crushed blacks and blown whites, dominant hues, saturation, FOV estimate.
  Write those numbers beside each statement. An adjective in a note ("a bit
  warmer") is a direction, never a slider to turn up three times.
- **One look page per game, one table of values per level** (exposure, fog
  colour and density, grade, key light). Every later change edits that page,
  not a scattered constant.

## 2. Fix global causes before tuning any one map

Run these over the whole game before touching a single level's grade:

- Sun above the terrain that frames the play space (no level lit from under
  the horizon).
- No accidental mirrors: roughness never 0 on non-glass, metalness only 0 or 1
  unless the look page says otherwise.
- Albedo in physical ranges (roughly 0.04–0.9 linear). Nothing pure black,
  nothing pure white.
- One texture per name in the build; no level inheriting another screen's
  grade or lights (menus included).
- Every LOD uses the same material as its base mesh; no opaque material marked
  alpha-test.

## 3. The image pipeline

- **Render linear, tone map once.** `renderer.toneMapping =
  ACESFilmicToneMapping` (or AgX/Neutral) and `outputColorSpace = SRGBColorSpace`,
  and no second curve in a post pass. Colour textures are `SRGBColorSpace`;
  data maps (normal, roughness, metalness, AO) stay linear.
- **The sky lives inside the exposure range.** If changing the sky's colour
  doesn't change the screen, it is clipped. Bring it into range.
- **Fog is the horizon.** Fog takes the sky's horizon colour so distance
  dissolves into sky, not into grey. Fog applies to geometry, not the sky dome
  (`material.fog = false` on the dome).
- **The far plane reaches everything drawn**, and distance haze never
  shimmers. Check every weather and every camera the game uses.
- **Lens from the concept.** Record the vertical FOV the reference implies
  (most third-person games 50–65°, first-person 70–80° horizontal-equivalent)
  and make every capture tool read the game's value.
- **A grade per level**: exposure, contrast, saturation, lift and gain, with
  shadows cooler than highlights (or the reverse, on purpose). Built once as a
  LUT or a small colour pass, values in the look page.
- **Bloom only where light is**: emissive sources, specular glints, effects.
  Threshold high enough that a lit wall never glows. Small emitters (eyes,
  reticles, filaments) glow at their own size, never as a white flower.

## 4. Materials before props

- **Find the broken channel before touching colour.** A surface that looks
  wrong is traced to normals, albedo, material flags, lights or post, and to
  the object drawing it, by hiding one thing at a time.
- **Honest materials.** Bare metal is metal; everything else is dielectric.
  Roughness never maxed and always varied across the surface (a roughness map,
  or at least noise). Generated material maps are graded before use: coated
  metal reads coated, wood reads wood, black reads black under the game's own
  light.
- **Dark materials get dark through sheen and light, not albedo.** Keep albedo
  above its family's floor; never lower albedo to fight auto-exposure.
- **Materials first, then dressing.** Hero surfaces hold up at standing
  distance with real normal and roughness and no visible repeat (break tiling
  with a second, differently-scaled sample or triplanar blend) before any
  prop pass is judged. Rock, architecture, foliage and backdrop share one
  scale of finish.

## 5. Nothing crawls

- Thin geometry (wires, railings, slats, grates) is never thinner than about a
  pixel at the distance it is seen. Swap in a far version or fade it; don't
  widen it or dither it.
- Mipmaps and anisotropy on every repeating texture; specular aliasing tamed
  with roughness at distance.
- Foliage keeps its silhouette under motion, zoom and every quality tier;
  plants that hide players hide them on every tier.
- Near fire and smoke show no card edges or flat fills: soft particles
  (depth fade), several layered cards, and lit by the scene.

## 6. Stylised and painterly looks

- Paint in the painting's own space: strokes belong to 2D layers arranged the
  way the painting composes them, not to the faces of 3D blocks.
- Fewer, bigger strokes over solid masses of value. Stepped values with
  coloured shade (shadows shift hue, not only darken), an ink line where the
  style has one, and nothing that boils frame to frame unless the motion is
  eased and intended.
- Each place gets its own palette and landmark, not a recolour of the last.

## Done means

- [ ] Look page with pass/fail statements and measured numbers per level.
- [ ] Global checks pass across every map.
- [ ] Captures from the **player's camera**, at play distance and default
      settings, scored against the reference (`game-playbook` →
      `references/critic-loop.md`).
- [ ] Motion checked on recorded video, not stills: no shimmer, crawl or pop.
