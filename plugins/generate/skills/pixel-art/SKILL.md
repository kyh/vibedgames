---
name: pixel-art
description: >
  Generate 2D pixel art game assets, characters, sprite sheets, background
  removal, and game backgrounds. Trigger for "pixel art character", "sprite
  sheet", "walk cycle", "game sprites", "isometric sprites", "side-scroller
  assets", "RPG character sprites", "idle animation", "attack animation",
  "jump animation", "game background", "parallax background", "isometric map",
  "2D game art", "pixel art animation", "top-down character", "explosion sprite
  sheet", "animated FX from video", "fire/magic effect". Covers character
  generation (nano-banana-pro / gpt-image-2), sprite sheet animation (nano/edit
  or fal-ai/gpt-image-2/edit), top-down 4-directional walkers, background removal
  (Bria), background generation (parallax layers or isometric map), and animated
  VFX derived from a generated video rendered with additive blend.
metadata:
  author: vibedgames
  version: "0.1.0"
---

# 2D Game Assets

> Requires the `vg` CLI (`npm install -g vibedgames`, or `pnpm dogfood` in this repo). The vibedgames server holds the API key; no per-machine setup.

Full pipeline for 2D pixel art game assets: character → sprite sheets → background removal → game background. Each recipe is independently invokable, run just the part you need.

Always use `--json` so output is machine-readable. Use `--download` to save files locally. Do **not** curl URLs manually, use the `--download` flag.

> **These recipes are the fast path** — 4-frame 2×2 image sheets, great for a quick playable or near-static pose. For polished animation (attack arcs, walk/run cycles, hurt, death) use the `animated-spritesheets` skill: it generates one labeled pose-board image per action, slices it, and packs an engine-loadable `spritesheet.png` + manifest in one command, holding the character's identity consistent across the whole animation.

**Craft rule (all paths): no baked shadows in the sprite.** Prompt against cast/contact/ground shadows, base ellipses, and floor lines — the engine adds shadows at render time, and a baked-in shadow fights the engine's.

---

## Execution rules, follow these strictly

1. **Each generation call = one Bash tool call**: issue each `vg generate run` and `vg generate status` as its own bare tool call. No variable assignments, no pipes, no shell redirects. This keeps every call matching the `vg generate *` allowlist so it runs without permission prompts.

2. **Parallel jobs → async**: issue each `vg generate run --async` as its own separate Bash tool call (not combined into one shell block). All jobs queue and run in parallel server-side; total time ≈ slowest single job. After all are fired, poll each with `vg generate status` sequentially (not in parallel, one failure must not cancel others).

```bash
# Step 1, fire async (each line = its own Bash tool call, returns request_id immediately)
vg generate run fal-ai/nano-banana-pro/edit --prompt "$WALK_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$IDLE_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json

# Step 2, poll sequentially (each line = its own Bash tool call)
vg generate status fal-ai/nano-banana-pro/edit <walk_request_id> --result --download ./walk.png --json
vg generate status fal-ai/nano-banana-pro/edit <idle_request_id> --result --download ./idle.png --json
```

3. **URL source**: always read `downloaded_files[0].url` from the tool result JSON. This is the correct path for all models (nano, gpt, Bria).

4. **Bria sync**: Bria (`fal-ai/bria/background/remove`) has no queue endpoint and does not support `--async`. Run it sync. It completes in seconds.

5. **`--download` paths are relative to your shell's cwd, not the project root.** If the agent is operating in a monorepo from the repo root, a bare `--download walk.png` lands in the root, not next to your game. Always pass a project-relative absolute or qualified path — e.g. `--download "games/my-game/public/assets/sprites/walk.png"` — so the asset lands where the game's loader expects it.

6. **Folder structure**: always save into this layout, deriving the character slug from the character description (kebab-case, e.g. `pirate-carrot`):

```
./game-assets/
<character-slug>/
character.png
sprites/
walk.png
idle.png
attack.png
jump.png
backgrounds/
layer1-sky.png
layer2-midground.png
layer3-foreground.png
```

Create the folders before downloading (`mkdir -p`). Use this structure even for partial runs (e.g. just one sprite sheet still goes in `sprites/`).

7. **End summary**: after all downloads complete, print a summary listing every file path and its CDN URL. Format:

```
=== Game Assets: pirate-carrot ===
character game-assets/pirate-carrot/character.png
https://...
walk game-assets/pirate-carrot/sprites/walk.png
https://...
```

8. **400 on status poll**: `vg generate status --result` fetches the result once; it does not poll automatically. A 400 with `"Request is still in progress"` means the job is still running, wait 10 seconds and retry the exact same `vg generate status` call with the same request_id. Do **not** re-fire the original `vg generate run --async` (the job is already running server-side). Keep retrying every 10–15 seconds until you get a successful result.

---

## Models in the stack

- **Nano Banana Pro**: `fal-ai/nano-banana-pro`, character + background generation; better quality and faster, recommended default
- **Nano Banana Pro Edit**: `fal-ai/nano-banana-pro/edit`, sprite sheet generation from character image
- **GPT-Image-2**: `openai/gpt-image-2`, character + background generation; slower than nano, use when user prefers it or wants cheaper output (`quality=low`)
- **GPT-Image-2 Edit**: `openai/gpt-image-2/edit`, sprite sheet generation; slower than nano, requires model-specific walk prompt; use `quality=low` for cheaper runs
- **Bria RMBG 2.0**: `fal-ai/bria/background/remove`, background removal on all sprite sheets

---

## Recipe 1. Generate character

Ask the user: character description (text) or an existing image to convert. Ask model preference: `nano` (default, better quality + faster) or `gpt` (slower; use `quality=low` if user wants cheaper output).

Define the prompt vars `$CHARACTER_STYLE_PROMPT` and `$IMAGE_TO_PIXEL_PROMPT` from [references/prompts.md](references/prompts.md) (Recipe 1), then:

```bash
# Text → pixel art character (nano)
vg generate run fal-ai/nano-banana-pro \
 --prompt "$CHARACTER_STYLE_PROMPT Character: <character_desc>" \
 --aspect_ratio "1:1" --resolution "1K" \
 --download ./game-assets/<slug>/character.png --json

# Text → pixel art character (gpt)
vg generate run openai/gpt-image-2 \
 --prompt "$CHARACTER_STYLE_PROMPT Character: <character_desc>" \
 --image_size "square_hd" --quality "high" \
 --download ./game-assets/<slug>/character.png --json

# Existing image → pixel art (nano), upload source image first, then run edit
vg generate upload /path/to/image.png --json
vg generate run fal-ai/nano-banana-pro/edit \
 --prompt "$IMAGE_TO_PIXEL_PROMPT" \
 --image_urls "[\"<uploaded_url_from_above>\"]" \
 --aspect_ratio "1:1" --resolution "1K" \
 --download ./game-assets/<slug>/character.png --json
```

Read `downloaded_files[0].url` from the tool result, this is `CHARACTER_URL`, needed for all sprite sheet recipes.

---

## Recipe 2. Generate sprite sheets

Pass `CHARACTER_URL` from Recipe 1. Choose `--style side` (side-scroller) or `--style iso` (isometric RPG). Choose model: `nano` or `gpt`.

**Side-scroller sheets**: 4-frame 2×2 grid animations. Covered types: `walk`, `jump`, `attack`, `idle`. Do not generate additional animation types (hurt, death, run, etc.) unless the user explicitly requests them.

Define the side-scroller prompt vars (`$WALK_PROMPT`, `$WALK_PROMPT_GPT`, `$JUMP_PROMPT`, `$ATTACK_PROMPT`, `$IDLE_PROMPT`) from [references/prompts.md](references/prompts.md) (Recipe 2 — side-scroller). Fire all sheets async (each is its own Bash tool call), then poll sequentially:

```bash
# Fire all 4 async, each is its own Bash tool call
vg generate run fal-ai/nano-banana-pro/edit --prompt "$WALK_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$JUMP_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$ATTACK_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "21:9" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$IDLE_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json

# Poll each, each is its own Bash tool call, run sequentially
vg generate status fal-ai/nano-banana-pro/edit <walk_request_id> --result --download ./game-assets/<slug>/sprites/walk.png --json
vg generate status fal-ai/nano-banana-pro/edit <jump_request_id> --result --download ./game-assets/<slug>/sprites/jump.png --json
vg generate status fal-ai/nano-banana-pro/edit <attack_request_id> --result --download ./game-assets/<slug>/sprites/attack.png --json
vg generate status fal-ai/nano-banana-pro/edit <idle_request_id> --result --download ./game-assets/<slug>/sprites/idle.png --json

# GPT variants: replace fal-ai/nano-banana-pro/edit with openai/gpt-image-2/edit
# Walk must use WALK_PROMPT_GPT (not WALK_PROMPT)
# Replace --aspect_ratio with explicit --image_size:
# 1:1 → --image_size "square_hd"
# 21:9 → --image_size "{\"width\": 2688, \"height\": 1152}"
```

**Isometric RPG sheets**: 3/4 overhead perspective. Covered types: `walk-down`, `walk-up`, `walk-side`, `attack-down`, `attack-up`, `attack-side`, `idle-iso`. Do not generate additional animation types unless the user explicitly requests them.

> **Top-down 4-directional games** (Bomberman, Zelda-like, twin-stick): the `walk-down` / `walk-up` / `walk-side` set IS your 4-directional movement set — render `walk-side` once and **mirror it (`setFlipX`) for left**, so you only generate three sheets. Use idle = frame 0 of the matching direction. This is the cheapest path to a believable top-down walker.

> Generate attack-down first, attack-up and attack-side both reference it for style consistency.

Define the isometric prompt vars (`$WALK_DOWN_PROMPT`, `$WALK_UP_PROMPT`, `$WALK_SIDE_PROMPT`, `$ATTACK_DOWN_PROMPT`, `$ATTACK_UP_PROMPT`, `$ATTACK_SIDE_PROMPT`, `$IDLE_ISO_PROMPT`) from [references/prompts.md](references/prompts.md) (Recipe 2 — isometric), then:

```bash
# Fire walk sheets + idle async, each is its own Bash tool call
vg generate run fal-ai/nano-banana-pro/edit --prompt "$WALK_DOWN_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$WALK_UP_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$WALK_SIDE_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$IDLE_ISO_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "1:1" --resolution "1K" --async --json

# Poll walk results sequentially
vg generate status fal-ai/nano-banana-pro/edit <walk_down_request_id> --result --download ./game-assets/<slug>/sprites/walk-down.png --json
vg generate status fal-ai/nano-banana-pro/edit <walk_up_request_id> --result --download ./game-assets/<slug>/sprites/walk-up.png --json
vg generate status fal-ai/nano-banana-pro/edit <walk_side_request_id> --result --download ./game-assets/<slug>/sprites/walk-side.png --json
vg generate status fal-ai/nano-banana-pro/edit <idle_iso_request_id> --result --download ./game-assets/<slug>/sprites/idle-iso.png --json

# Attack-down sync, needed as reference before firing attack-up and attack-side
vg generate run fal-ai/nano-banana-pro/edit --prompt "$ATTACK_DOWN_PROMPT" --image_urls "[\"$CHARACTER_URL\"]" --aspect_ratio "9:16" --resolution "1K" --download ./game-assets/<slug>/sprites/attack-down.png --json

# Fire attack-up and attack-side async, passing attack-down URL from above result
vg generate run fal-ai/nano-banana-pro/edit --prompt "$ATTACK_UP_PROMPT" --image_urls "[\"$CHARACTER_URL\", \"<attack_down_url>\"]" --aspect_ratio "9:16" --resolution "1K" --async --json
vg generate run fal-ai/nano-banana-pro/edit --prompt "$ATTACK_SIDE_PROMPT" --image_urls "[\"$CHARACTER_URL\", \"<attack_down_url>\"]" --aspect_ratio "16:9" --resolution "1K" --async --json

vg generate status fal-ai/nano-banana-pro/edit <attack_up_request_id> --result --download ./game-assets/<slug>/sprites/attack-up.png --json
vg generate status fal-ai/nano-banana-pro/edit <attack_side_request_id> --result --download ./game-assets/<slug>/sprites/attack-side.png --json

# GPT variants: replace fal-ai/nano-banana-pro/edit with openai/gpt-image-2/edit
# Replace --aspect_ratio with explicit --image_size:
# 1:1 → --image_size "square_hd"
# 9:16 → --image_size "{\"width\": 720, \"height\": 1280}"
# 16:9 → --image_size "{\"width\": 1280, \"height\": 720}"
```

---

## Recipe 3. Remove backgrounds

Bria has no queue endpoint, run sync (no `--async`). Each is its own Bash tool call:

```bash
vg generate run fal-ai/bria/background/remove --image_url "<walk_url>" --download ./game-assets/<slug>/sprites/walk-transparent.png --json
vg generate run fal-ai/bria/background/remove --image_url "<jump_url>" --download ./game-assets/<slug>/sprites/jump-transparent.png --json
vg generate run fal-ai/bria/background/remove --image_url "<attack_url>" --download ./game-assets/<slug>/sprites/attack-transparent.png --json
vg generate run fal-ai/bria/background/remove --image_url "<idle_url>" --download ./game-assets/<slug>/sprites/idle-transparent.png --json
```

**Bria is segmentation, not chroma-key.** It removes the background even when the subject shares the background's color — a white-armored character on a white background comes out clean, with the white armor intact. Do **not** reach for ffmpeg `colorkey`/`chromakey` to cut sprite backgrounds: it punches holes in any same-colored part of the subject. Bria also handles a multi-frame sheet (2×2 walk grid) in a single call, keeping every frame. After Bria, the sheet keeps its original dimensions, so a 1024² 2×2 sheet stays 1024² with 512² frames.

---

## Recipe 4. Generate backgrounds

**Pipeline note:** Layer 1 (sky) and the isometric map only need `CHARACTER_DESC`, no image reference. Fire Layer 1 async immediately after character generation so it runs in parallel while you generate sprite sheets. Layers 2 and 3 are sequential (each needs the previous layer's URL from the tool result).

**Side-scroller, 3-layer parallax** — define `$LAYER1_SKY_PROMPT`, `$LAYER2_MID_PROMPT`, `$LAYER3_FG_PROMPT`, `$ISO_MAP_PROMPT` from [references/prompts.md](references/prompts.md) (Recipe 4).

```bash
# Layer 1, sky/backdrop. Fire async (no image dep) so it runs in parallel with sprite generation
vg generate run fal-ai/nano-banana-pro --prompt "$LAYER1_SKY_PROMPT" --aspect_ratio "21:9" --resolution "1K" --async --json

# Poll Layer 1 (after sprite sheets are done), then read its URL from the result
vg generate status fal-ai/nano-banana-pro <layer1_request_id> --result --download ./game-assets/<slug>/backgrounds/layer1-sky.png --json

# Layer 2, midground (needs CHARACTER_URL + layer1 URL from above result)
vg generate run fal-ai/nano-banana-pro/edit --prompt "$LAYER2_MID_PROMPT" --image_urls "[\"<character_url>\", \"<layer1_url>\"]" --aspect_ratio "21:9" --resolution "1K" --download ./game-assets/<slug>/backgrounds/layer2-midground.png --json

# Bria bg-remove on layer 2 (sync, no queue endpoint)
vg generate run fal-ai/bria/background/remove --image_url "<layer2_url>" --download ./game-assets/<slug>/backgrounds/layer2-transparent.png --json

# Layer 3, foreground (needs CHARACTER_URL + layer1 URL + layer2-transparent URL from above result)
vg generate run fal-ai/nano-banana-pro/edit --prompt "$LAYER3_FG_PROMPT" --image_urls "[\"<character_url>\", \"<layer1_url>\", \"<layer2_transparent_url>\"]" --aspect_ratio "21:9" --resolution "1K" --download ./game-assets/<slug>/backgrounds/layer3-foreground.png --json

# Bria bg-remove on layer 3 (sync, no queue endpoint)
vg generate run fal-ai/bria/background/remove --image_url "<layer3_url>" --download ./game-assets/<slug>/backgrounds/layer3-transparent.png --json

# GPT variant: replace nano endpoints with openai/gpt-image-2 and openai/gpt-image-2/edit
# Use --image_size '{"width": 2688, "height": 1152}' for 21:9 with gpt
```

**Isometric, single top-down map**

```bash
vg generate run fal-ai/nano-banana-pro --prompt "$ISO_MAP_PROMPT" --aspect_ratio "1:1" --resolution "1K" --download ./game-assets/<slug>/backgrounds/map.png --json
```

---

## Recipe 5. Animated FX from a generated video (explosions, fire, magic)

Real fire/explosion motion beats an AI-drawn frame strip, and you can sidestep alpha extraction entirely with one trick: **generate the effect on pure black, then render it additively** (`BlendModes.ADD`), where black contributes nothing — no background removal needed.

1. **Generate** a short clip on a pure-black background. Use `$EXPLOSION_PROMPT` from [references/prompts.md](references/prompts.md) (Recipe 5) — it prompts hard for a locked-off camera and no smoke/grey haze (grey survives ADD blend and shows as a haze square):

```bash
vg generate run bytedance/seedance-2.0/fast/text-to-video --prompt "$EXPLOSION_PROMPT" --aspect_ratio "1:1" --resolution "720p" --async --json
# then: vg generate status bytedance/seedance-2.0/fast/text-to-video <id> --result --download ./game-assets/<slug>/fx/explosion.mp4 --json
```

2. **Extract a frame strip** with ffmpeg. Sample the active window (skip the empty lead-in, include the decay tail so it fades out), scale each frame to a power-of-two, tile into one horizontal sheet. Pin exact dims so Phaser's `load.spritesheet` math is unambiguous:

```bash
# 16 frames over the burst→decay window, each 128², into a 2048×128 strip
ffmpeg -y -ss 0.5 -to 3.05 -i explosion.mp4 -vf "fps=6.3,scale=128:128:flags=lanczos,tile=16x1" -frames:v 1 explosion.png
```

3. **Render additively** — black reads as transparent, flames glow, frames can overlap/jitter without looking wrong:

```ts
this.load.spritesheet("explosion", "assets/explosion.png", { frameWidth: 128, frameHeight: 128 });
this.anims.create({
  key: "explode",
  frames: this.anims.generateFrameNumbers("explosion", { start: 0, end: 15 }),
  frameRate: 32,
});
// per blast tile:
this.add.sprite(x, y, "explosion").setBlendMode(Phaser.BlendModes.ADD).play("explode");
```

This same pattern works for muzzle flashes, magic bursts, impact sparks, and portals — anything that reads as emitted light. For solid/opaque FX (smoke, debris) you still need real alpha (Bria per frame), so prefer ADD-friendly subjects when generating.

---

## Parameters

- **Model**: `nano` is the default: better quality and faster. `gpt` is slower; use it when the user specifically requests it or asks for the cheapest option, in that case set `--quality "low"` to significantly reduce cost
- **Walk + gpt-image-2**: always use `WALK_PROMPT_GPT`, not `WALK_PROMPT`. GPT needs explicit side-profile orientation instructions to get the direction right
- **Attack aspect ratio**: `21:9` (nano) or `2688×1152` (gpt) for side-scroller attacks. Isometric attacks: `9:16` for down/up, `16:9` for side
- **Isometric attack-up and attack-side**: always pass `ATTACK_DOWN_URL` as second reference image to keep attack style consistent across directions
- **Background layers**: generate in order (1 → 2 → 3). Each references previous layers. Layer 1 keeps background; layers 2 and 3 get background-removed
