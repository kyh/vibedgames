# Visual bar: hold a game to real reference shots

For when looks matter: the user names a game it should look like, asks for a
"polished" or "studio-quality" pass, or the game plays fine but its screenshots
read like a browser toy. It costs real rounds — skip it for a jam prototype.

The idea: _playable is the floor, visual parity is the gate._ Lock real
screenshots of shipped games, write a per-game bar from them, and let a fresh
critic (see `critic-loop.md`) judge live captures against that bar until every
criterion passes. "Better than last round" never counts; the refs do.

## 1. Lock the refs

- 4–8 real screenshots of **shipped** games in the target genre and look, cover
  four slots: wide gameplay, mid-distance action, HUD-heavy frame, environment
  or lighting mood. Highest resolution you can find. PNG (`ref-sxs.mjs` reads
  PNG only).
- Save to `refs/ref-NN-<slug>.png` at the project root, with `refs/SOURCES.md`:
  file, title, URL, date, slot, "review only, not shipped".
- **Never under `public/` or anything `vg deploy` uploads.** Refs are critic
  input, not game assets.
- Frozen once the loop starts. A ref may change only with a logged reason, never
  to a weaker one, and the critic re-scores from scratch.
- A "stylized" look is valid only when the refs share that stylization at the
  same craft level. Pixel-art refs → a pixel-art bar; don't force 3D.

## 2. Homage, not copy

- Original title, character names, lore, art, UI and audio.
- Never put franchise, character or studio names, or "in the style of <game>",
  into a `vg generate` prompt. Describe the look with `LOOK.md` vocabulary.
- **Never feed a ref to `vg generate` as an image or edit input.** Refs are only
  ever looked at.

## 3. Decompose the look → `art/LOOK.md`

One paragraph per ref: palette, key-light direction and colour, fill/ambient,
sky and fog, material families (stone, metal, cloth, foliage, skin), ground
treatment, prop density, HUD grammar, post (bloom, grade, vignette, AO, DoF).
This is the prompt vocabulary for every generation and the critic's checklist.

## 4. Write the bar → `art/BAR.md`

5–12 criteria, numbered `C1..Cn`, each with **PASS when**, **FAIL signs**, the
refs that justify it, and `core` or `game`. Lock it before art starts. Mid-loop
you may add a criterion (logged); never remove, merge away or soften one.

Core five, always present (wording adapts to 2D refs; intent doesn't):

| id  | name                 | PASS when                                                                                                                                                                                            | FAIL signs                                                                       |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C1  | Lighting & surfaces  | one readable key light, shadows or shading where the ref has them, contact darkening at bases, surfaces show variation (texture, roughness, dithering for pixel art), grade inside the ref's palette | fullbright, flat single-colour planes, no grounding shadows, toy-plastic palette |
| C2  | Density & silhouette | matched crops show comparable prop, terrain and unit breakup; multi-part silhouettes; no primitive standing in for a real object                                                                     | stamped boxes, empty floors, tile seams, sparse where the ref is dense           |
| C3  | Blur test            | every blurred side-by-side reads as the same genre **and** production tier                                                                                                                           | game half reads flatter, emptier, or like a web page                             |
| C4  | Live capture         | every still is a `vg playtest screenshot` of the running build at the current commit; crop only                                                                                                      | mockups, composited plates, retouching, old build                                |
| C5  | In motion            | frames sampled across a real run match still quality                                                                                                                                                 | placeholders, missing textures, flicker, popping, z-fighting                     |

Game-specific (C6+) — only what the refs actually show, each with observables:
HUD craft (`game-ui`), hero silhouette readability, VFX that lights the scene
(`vfx`), night/threat grade, crowd or horde density, wet reflections, far-field
depth, a genre signature named in `LOOK.md`. Never "feels premium".

## 5. Build the art in this order

Lighting first — it's the cheapest lever and multiplies every asset after it.
After each step, capture and run a critic check scoped to that step's criteria.

1. **Light & grade** with placeholders still in: key light, shadows, fill, AO,
   tonemap, grade, fog, bloom (`threejs` post-processing; Phaser 4 lights and
   filters in `phaser`). Gate: the blurred placeholder scene already matches the
   ref's value structure and light direction (C1, C3).
2. **Surfaces**: every placeholder material/tile replaced; break repetition with
   variation and decals (`pixel-art`, `threejs` textures). Gate: C1.
3. **Density**: hero units, props, scatter, debris, silhouettes at the locked
   camera distance (`character-design`, `regenerate-3d`, `image-to-threejs`,
   instancing). Gate: C2.
4. **HUD** in the refs' grammar — framed panels, a real typeface, icon set
   (`game-ui`). Skip if no HUD criterion.
5. **Motion**: animation states, hit/ability VFX, camera feel (`animation`,
   `vfx`, `game-feel`). Gate: C5.

Track every visible thing in `art/LEDGER.md` — element, source (generated,
procedural, authored), status `placeholder | draft | final`, target ref. Zero
`placeholder` rows before the parity loop. `asset-pipeline` checks the files.

## 6. Escalation ladder

Trigger: the same criterion fails two critic checks in a row with no visible
change in its side-by-side. Climb one rung, note why. Never lower the bar.

1. Light and post: shadows, AO, tonemap, grade, fog, bloom.
2. Surface fidelity: normal/roughness maps, detail textures, decals, variation.
3. Density: instancing, more props, terrain displacement, debris.
4. Renderer features: shadow cascades, SSAO, a full post stack; Phaser canvas →
   WebGL filters and lights.
5. Engine: refs are 3D and the game is 2D → move to `threejs`. Keep gameplay
   behind a renderer seam so this doesn't mean a rewrite.

## Automatic FAIL

Never excused when the bar and refs call for them: a placeholder primitive in
any still or frame; a flat single-colour surface dominating a still where the
ref is textured; no shadows or contact darkening where the refs have them;
default fonts or unstyled controls under a HUD criterion; a 2D plate backdrop
where the ref shows 3D space; missing textures, flicker or popping in motion;
any side-by-side failing the blur test; a still not from the live build.

## Banned soft-pass phrases

In a verdict they void it; in your own status lines they're a tell you're
rationalising. Rewordings count.

- "fine for a browser game / prototype / jam", "impressive for a web build"
- "close enough", "good enough", "mostly there", "nearly parity", "acceptable for now"
- "not photoreal, but", "stylized is a valid choice" (when the refs aren't)
- "PASS with notes", "conditional WIN", "soft WIN"
- "big improvement over last round" or "gameplay is solid, so" as grounds to pass
