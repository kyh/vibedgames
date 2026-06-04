# Prompt Patterns

Use these as scaffolds, not rigid templates.

## Reference Inputs For Image-Generated Spritesheets

For `gpt-image-2` or any opaque-background image model, pass the minimum references needed:

1. **Direction-specific identity anchor**: the approved character image for the exact facing direction, usually `1024x1024`. Use the in-game sprite-like anchor, not box art, unless no gameplay-facing anchor exists.
2. **Sheet guide**: an alternating-pixel guide at the target sheet size, such as `1280x512` for a `5x2` sheet. This is a layout and texture hint, not a guarantee that cells will be perfectly registered.
3. **Optional style/reference image**: only include this if the identity anchor is weak. Do not mix conflicting character references.

In the prompt, label the image roles explicitly:

```text
Image 1 is the identity anchor. Preserve this exact character identity, outfit, silhouette, palette, proportions, and facing direction.
Image 2 is the 5 columns x 2 rows spritesheet guide. Use it only for layout and pixel texture.
```

## Background Constraints For Later Removal

Most modern image models do not produce trustworthy native transparency. Treat the output as opaque and plan for background removal.

For spritesheets, ask for:

- one exact flat chroma background color, preferably `#00FF00` when the character/effects do not contain green
- no gradients, texture, vignettes, paper grain, faux transparency checkerboards, or lighting on the background
- no cast shadow, contact shadow, ground shadow, rim haze, or glow touching the background
- no scenery, floor, horizon, props, UI, labels, borders, or frame numbers

Choose the chroma color based on the character and effects:

- Use `#00FF00` by default for purple/fireball/magic characters.
- Avoid magenta if the character or effects use purple, pink, or red tones.
- Avoid green if the character, weapon, aura, or VFX uses green.

Important: do **not** remove background from the whole generated sheet. Crop/recover frames first, then run Bria/remove-bg per frame, then normalize every cleaned frame to a shared center/bottom anchor before building GIFs or runtime strips.

## Single Directional Anchor

```text
Intended use: a reusable single-frame directional anchor sprite for a top-down 2d action game.

Image 1 role: identity anchor. Preserve the exact approved character identity, silhouette, outfit, proportions, and pixel-art readability from this reference image.
Image 2 role: pixel-style anchor. Use this only to reinforce the crisp pixelated treatment and sprite readability.

Primary request: generate a single-frame <direction>-facing anchor sprite.

Subject:
- <character name and role>
- <direction>
- <top-down / 3/4 / rear three-quarter etc>
- Keep this as the same character, not a redesign.

Look and rendering:
- High-resolution pixelated sprite art.
- Chunky crisp sprite edges.
- Preserve the visual family of image 1.
- No painterly shading, no blur, no soft gradients.

Background and composition:
- Exact flat chroma background, preferably #00FF00 unless that conflicts with the character palette.
- No gradients, shadows, texture, scenery, or faux transparency checkerboards.
- No scenery, UI, labels, text, props, borders, or extra characters.
- Deliver a single isolated sprite frame composition, not a sheet.

Avoid:
- realism
- redesigns
- costume changes
- tiny framing
```

## Attack Sheet

```text
Intended use: a reusable attack animation spritesheet for a top-down 2d action game.

Image 1 role: identity anchor. Preserve the exact approved anchor sprite identity.
Image 2 role: pixelation and sheet guide. Use this only to guide the overall chunkiness, pixel-texture feel, and full-sheet composition.

Subject:
- <character name and role>
- <direction-facing top-down sprite view>
- Keep this as the same already-approved sprite character.

Primary request: create a 10-frame attack sequence arranged as a 2 columns x 5 rows spritesheet over the full canvas.
- Frame 1: ready idle
- Frame 2: aim shift
- Frame 3: draw and brace
- Frame 4: aim set
- Frame 5: first shot muzzle flash
- Frame 6: recoil
- Frame 7: recovery
- Frame 8: second shot or follow-through
- Frame 9: settle
- Frame 10: return to idle

Look and rendering:
- High-resolution pixelated sprite art.
- Crisp chunky sprite edges.
- Preserve visible pixel structure.
- No painterly rendering, no airbrushing, no soft gradients.
- Keep the sprite large and centered in each frame area.

Composition and background constraints:
- Use the full canvas as a 2x5 spritesheet.
- Exactly one character figure per frame area.
- Keep the figures separated and fully readable.
- No overlapping between frame areas.
- Use one exact flat chroma background color across the entire sheet, preferably #00FF00 unless that conflicts with the character palette or VFX.
- No gradients, shadows, texture, scenery, floor, horizon, faux transparency checkerboards, or lighting on the background.
- Do not add scenery, props, text, UI, labels, borders, decorative effects, or extra characters.

Avoid:
- redesigning the character
- changing costume colors
- making the sprite tiny
- faux transparency patterns
- floor shadows or environment backdrops
```

## Image-to-Video Walk Cycle

Use this with a neutral `1280x720` start image: one character centered on a flat neutral background, full body visible, enough padding around head and feet. Do not use checkerboards, grids, labels, arrows, floors, shadows, or scenery as the video start image.

Direction options:
- `south / front-facing`
- `north / back-facing`
- `west / left-facing`
- `east / right-facing`

```text
Animate this single character into a simple <direction>-facing in-place walk cycle for a top-down 2D game.

The character must face <direction> for the entire clip.
Do not turn toward any other direction.
Do not pivot, rotate, or show a quarter-turn view.
Do not change the body orientation at any point.

Keep the camera fixed and centered.
Keep the framing unchanged.
Keep the plain neutral background flat.
Do not turn the background into a floor, room, horizon, scene, or perspective grid.

Make the motion low-fidelity, readable, and suited to a game sprite reference.
Use a small looping in-place walk with subtle vertical bobbing, light clothing/equipment sway, and minimal arm swing.
Preserve the sprite-like pixelated look and the exact character identity.

One character only.
Neutral background.
No scene.
No extra props.
No effects.
No attack animation.
No weapon swing.
```

## Prompt adjustment rules

- For `north`, ask for a readable back-facing or rear three-quarter silhouette.
- For `west` / `east`, emphasize side silhouette and weapon readability.
- For high-resolution pixelated output, preserve sprite readability rather than strict tiny-pixel purity.
- Keep the frame list literal and ordered.
