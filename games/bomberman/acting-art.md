# Bomberman character acting

Built-in `image_gen`; original walk/video assets retained. Four raw PNG sheets,
16 authored frames plus mirrored left placement. Runtime uses explicit frame
rectangles and foot pivots in `src/render/character-action.ts`. No raster retouch,
resampling, chroma-keying or regenerated walk/fire. Alpha extracted by the same
image tool where its initial output contained a painted checkerboard.

| Runtime asset                          | Final source under generated_images/01a072e5-b121-77b0-b7f7-52a06ec3e9e2 | Size      |
| -------------------------------------- | ------------------------------------------------------------------------ | --------- |
| public/assets/player-place-down-v2.png | exec-d652cf84-48bb-40b7-91b0-9b2353b33a98.png                            | 1341×1173 |
| public/assets/player-place-up-v2.png   | exec-60229db3-c00f-4550-9add-ed83127d8517.png                            | 1254×1254 |
| public/assets/player-place-side-v2.png | exec-399df99b-8978-49fd-94ec-d963a10c6144.png                            | 1254×1254 |
| public/assets/player-victory-v2.png    | exec-e755116a-fc93-4ea1-bc52-844772206fd4.png                            | 1322×1190 |

Source root: `/Users/kyh/.codex/generated_images/`. Final runtime files live in
`/Users/kyh/.codex/worktrees/93e8/vibedgames/games/bomberman/public/assets/`.
All four are verified RGBA with alpha spanning0–255. PNG bytes copied unchanged.
Original sprites use4 walk frames at9fps; fire uses16 video-derived frames at32fps.

## Final prompt set

### Down placement

Input: original `player-down.webp`.

> Use case: identity-preserve. Production game animation sprite sheet. Input image is the exact existing DOWN-facing walk sprite sheet, used as the character identity, pixel rendering, size, and framing reference. Create a NEW 4-frame bomb-placement gesture for this SAME white and teal chibi bomber character, facing DOWN toward the viewer in all frames. Keep exact helmet shape, teal cap, tiny gold fuse light, peach face, black eyes, white/lavender suit and boots, dark pixel outline, chunky pixel-art shading, same perspective and proportions. Output a square 2x2 sheet, exactly four equal cells, read left-to-right then top-to-bottom, genuinely transparent alpha, no background or checkerboard. Anchor the feet at the same position and keep the character same apparent size in every cell, matching reference. Frame1: small knee bend, right hand beginning to reach toward ground. Frame2: knees bent, right arm reaching down in front of body, clear hand-down gesture. Frame3: hand withdrawing, knees beginning to straighten. Frame4: return to exact front-facing neutral stance of reference. This is a 240ms responsive action, restrained changes, no jump or body rotation. No bomb held or appearing in the sheet; the game draws its existing bomb separately. No extra characters, text, cell borders, lighting changes, ground shadow or new costume parts. Preserve small pixel edge structure and clean silhouette, readable rendered at61px. Deliver only the four-frame production sprite sheet.

Alpha edit of `exec-2edcd9ea-2401-4cb1-b368-57ef20c7f0af.png`:

> Use case: background-extraction. Edit this production game sprite sheet ONLY to remove the fake checkerboard completely. Output a PNG with a REAL transparent alpha channel: all pixels outside the four pixel-art characters must have zero alpha. The checkerboard was accidentally painted into an opaque RGB image; it is NOT an intended background. Do not replace it with a flat white, black, green or other opaque background. Keep the four sprites' colored pixels, poses, positions and outlines unchanged. Keep 2x2 equal frame layout. Deliver actual transparent sprites usable with alpha blending in a game, no presentation background.

### Up placement

Input: original `player-up.webp`.

> Use case: identity-preserve. Edit this existing BACK/UP-facing bomber sprite sheet into a four-frame placement gesture. Preserve exact character identity, view, pixel-art rendering, size, teal helmet, tiny gold fuse, white/lavender armored suit, backpack and boots. The character must face AWAY from viewer in all four cells. Keep square 2x2 equal frame layout and same fixed feet anchor in each cell. Frame1 upperleft: small knee bend with right arm beginning reach. Frame2 upperright: clear crouch, right hand reaching to ground beyond character. Frame3 lowerleft: hand retracts, knees straighten. Frame4 lowerright: original neutral back-facing stance. Subtle responsive240ms acting, no rotation, no jump, no bomb sprite (game draws bomb separately). The game needs actual transparent pixels: deliver RGBA PNG with zero alpha outside the four sprites. NO painted checkerboard, no white background, no black background, no opaque backdrop. Preserve clean dark pixel outlines, no ground shadows, no text, no grid lines, no new costume features. Deliver only the production alpha sprite sheet.

Alpha edit of `exec-abf2f5b2-070b-464c-8ddc-b56c52b6037f.png`:

> Use case: background-extraction. Remove the accidentally painted checkerboard from this four-frame game sprite sheet. Return a PNG with real alpha channel, zero alpha outside the four character silhouettes. Preserve all four original characters exactly, their pixel color, pose, and layout. No white, black or any opaque replacement background. Keep four separate sprites in2x2 grid. Actual transparent game asset, not an illustration of transparency.

### Side placement

Input: original `player-side.webp`.

> Use case: identity-preserve. Edit this existing right-facing pixel-art bomber walk sheet into a four-frame bomb-placement gesture for the SAME character. Exactly preserve side view facing RIGHT, helmet shape with teal cap, gold fuse light, peach face, white/lavender armor and boots, proportions and chunky dark pixel outline. Square2x2 sheet fourequalcells fixed feet anchor. Frame1 top-left slight crouch right arm beginning forward/down reach; Frame2 top-right deepened crouch hand-down toward ground in front to RIGHT; Frame3 bottom-left hand retracts and knees recover; Frame4 bottom-right original neutral right-facing stance. Restrained240ms action, no rotation, no jump. No bomb in image; game draws existing bomb independently. Genuine transparent alpha outside sprites, no painted checkerboard or white backdrop. No cell borders, labels, text, ground shadow or costume changes. Production sprite sheet readable at61px.

### Victory

Input: original `player-down.webp`.

> Use case: identity-preserve. Create a four-frame victory gesture by editing this exact front/down-facing pixel-art bomber character sheet. Keep SAME white and lavender armored chibi character, teal helmet cap with tiny gold fuse light, peach face, simple black eyes, dark pixel outline, proportions, chunky pixel-art rendering and high front game view. Four equal cells in2x2 sheet, fixed grounded feet pivot. Frame1 top-left: original neutral stance, hands at sides. Frame2 top-right: both fists confidently raised shoulder height, small happy eyes. Frame3 bottom-left: both hands overhead in a cheerful victory V, grounded feet together, no jump. Frame4 bottom-right: settled proud salute with one hand at helmet, other hand on hip, neutral tall standing posture. A brief celebration for actual winner, readable at61px. Keep consistent standing helmet size and suit in all frames, no trophy, medal, text, pose labels or extra props. Deliver genuine RGBA PNG with transparent alpha outside sprites; no checkerboard or opaque background, no cell lines or ground shadow. Production game sprites only.

Alpha edit of `exec-2a473a94-64fc-4eab-9f3b-9527ef7b2e5f.png`:

> Use case: background-extraction. Remove ALL painted checkerboard outside the four characters. Preserve the four pixel-art victory sprites, poses, colors and 2x2 layout exactly. Deliver RGBA PNG with a REAL transparent alpha channel, zero alpha outside the colored sprites. Do not replace checkerboard with white, black or any opaque background. No ground, shadows, border or text. Actual transparent production game sheet.

## Runtime decisions

Placement lasts280ms after rendered accepted placement, seeking past network age.
Walking/turning interrupts immediately; no fuse/input delay. Victory lasts720ms,
then holds the salute until movement, death or reset. Foot pivots compensate for
nonuniform generated padding. Each sheet uses one scale to retain actual crouch.
The tool changed canvas dimensions during alpha extraction; code uses measured
cuts rather than assuming equal quadrants.

Root inspected all sixteen frames in the actual Phaser renderer against the
original walk poses, including mirrored left. Native placement/interruption and
new title layouts passed on the isolated art snapshot. Final integrated multiplayer,
clock, mix and device evidence is tracked with the completion plan.
