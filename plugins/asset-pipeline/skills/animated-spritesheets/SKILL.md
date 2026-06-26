---
name: animated-spritesheets
description: "Turn a character anchor into an engine-loadable animated spritesheet by generating ONE labeled pose-board image (a grid of the same character in the frames of an action) and slicing it. Works for any action — idle, run, jump, attack, hurt, crouch, death, roll. Generates a per-frame-labeled pose board on a flat chroma matte, recovers/slices the frames, keys + despills, normalizes with headroom, optionally pixel-snaps, and packs spritesheet.png + a manifest. Triggers: 'sprite animation', 'animated spritesheet', 'attack animation', 'walk/run cycle', 'animate this character', 'game sprite animation', 'sprite pose sheet'."
metadata:
  short-description: "Character anchor -> labeled pose-board image -> engine-loadable spritesheet."
---

# Animated Spritesheets

Turn a character into a packed, engine-loadable spritesheet by generating **one
labeled pose-board image** — a grid of the *same* character in the frames of an
action — then recovering/slicing it. This is the **image-generation** method.

> **Why image generation, not image-to-video.** One generation per action keeps
> identity consistent (cloak/face/weapon stay the same across frames); video
> morphs the character mid-clip. Trade-off: fewer frames (a model reliably lays
> out ~4–12 grid cells, not a long strip), so motion is choppier — per-frame pose
> labels + pixel-snapping make the few frames count.

## The happy path

You are an agent. All scripts run with `uv run <script>` (PEP 723; deps
auto-install), take `--help`, and the deterministic ones have `--selftest`.

```bash
# 0. (once) An approved character anchor PNG on a flat chroma matte (the identity
#    reference). Make it via the pixel-art skill, or:
uv run scripts/sprite_prompt.py anchor --direction e --chroma '#00FF00'   # -> vg generate run

# 1. ASK what the action needs (frame count / fps)
uv run scripts/sprite_presets.py --action attack --json

# 2. PROMPT — get the labeled pose-board prompt (per-frame semantic poses on an
#    implied 4x3 grid, identical-character + no-shadow litany, the craft):
uv run scripts/sprite_prompt.py pose-board --action attack --direction e --frames 8 \
  --frame-prompt-style specific --pose-board standard --style lobit-v1 --chroma '#00FF00'

# 3. GENERATE the pose board with the anchor as the identity reference. The board
#    is a 4-col x 3-row grid; the first N cells are the frames (4:3 aspect):
vg generate run fal-ai/nano-banana-pro/edit --prompt "<from step 2>" \
  --image_urls '["<anchor_url>"]' --aspect_ratio "4:3" --resolution "1K" \
  --download attack-board.png --json

# 4. PROCESS into runtime frames with ONE command. Default = naive uniform slice
#    (the robust path). If the model spilled a pose across cell borders, add
#    --recover to segment by connected components instead:
uv run scripts/process_sheet.py attack-board.png --action attack --rows 3 --cols 4 --frames 8 --out-dir runs/hero-attack
```

The deliverable is `<out-dir>/spritesheet.png` + `spritesheet.json`, with
`runtime/` frames and `review/<action>.gif`. Load it:

```ts
// spritesheet.json -> { frameWidth, frameHeight, frameCount, fps, animations }
this.load.spritesheet("attack", "assets/hero-attack/spritesheet.png", { frameWidth: 256, frameHeight: 256 });
this.anims.create({ key: "attack", frameRate: 10,
  frames: this.anims.generateFrameNumbers("attack", { start: 0, end: 7 }) }); // end = frameCount - 1
```

## What `process_sheet.py` does (under the hood)

1. **slice/recover** — `--recover` runs `recover_component_frames.py` (detect the
   foreground component in each grid cell — robust to the model spilling poses
   across cell edges); default is a naive uniform `--rows ×
   --cols` slice. `--frames N` takes the first N cells.
2. `chroma_clean.py clean` — key the matte → fringe → despill → decontaminate
   (global speck-removal so dark/low-contrast sprites stay clean).
3. `normalize_canvas.py` — place each frame on a shared 256×256 anchor with
   **headroom** (`--char-fill`, default ~0.5 of the cell) so attack arcs and big
   poses never clip the edge.
4. `pack_spritesheet.py` — pack to `spritesheet.png` + manifest.
5. `sheet_qc.py` — QC the packed sheet and report a verdict (same token in the
   `--json` `qc` field and the human badge, just uppercased there): **`clean`** /
   **`review`** (soft hints to eyeball — size outliers, possible facing flips) /
   **`warn`** (hard defects — empty cells, edge-clipping, foot-baseline wander).
   Runs automatically; `--no-qc` skips it. **Read the verdict:** regenerate the board
   on `warn`; eyeball `review/<action>.gif` on `review`. Run it standalone too:
   `sheet_qc.py sheet.png [--json] [--strict]`.

Optional: `--pixel-snap` snaps frames onto a recovered native pixel grid (the
crisp low-bit look). It runs *before* normalize so frames re-uniform; note it can
shrink frames unevenly on non-native AI art — eyeball the gif. Off by default.

## Craft

- **Consistency is the whole point.** Prompt "identical character, do not redesign
  between frames," and reference the anchor as identity.
- **Headroom.** Draw the character small with margin (~20–50% of the frame) so
  effects/arcs have room.
- **Grid the model can do.** A 4×3 board (first 6–10 cells) is the sweet spot.
  Past ~12 cells the model loses layout consistency.
- **Make it ONE motion, not N poses.** The model's default failure is each cell as
  a separate dramatic pose, so frames jump around instead of tracing one swing.
  Two prompt moves beat this, both built into `sprite_prompt.py pose-board`:
  (1) it always frames the used cells as *consecutive film frames of one continuous
  motion sampled at evenly-spaced instants*; (2) with `--frame-prompt-style specific`
  (the default) it writes per-frame labels as **monotonic spatial progression along a single path**
  (weapon back → wind-up peak → mid-strike across centerline → contact →
  follow-through → recover), not abstract beats. **If you add an action** to
  `sprite_presets.py` / `frame_label`, label it as progression along one path —
  that, not the frame count, makes it read as motion.
- **Lock the facing.** The model loves to mirror a cell (often frame 1). The
  pose-board prompt pins facing in *every* cell (`_pose_board_facing_lock`);
  `--direction e`/`w` adds a side-profile lock. `sheet_qc.py` catches gross flips;
  eyeball the gif for subtle ones.
- **Lock the scale.** Same *size* in every cell on a shared foot baseline — pose
  change fine, scale change not. The prompt says so. `normalize_canvas` can't
  un-drift mixed scales, so `sheet_qc.py` flags size outliers (sparing monotonic
  pose arcs like a death collapse).
- **Matte.** Flat `#00FF00` (`#FF00FF` if the subject is green). Generate-time
  prompts must forbid baked shadows — the engine adds those.
- **Genre/action data** comes from `sprite_presets.py` (frames, fps, profiles).

## Remember

One labeled pose-board image, one consistent character, recovered into frames.
Fewer frames than a video clip, but they're the *same* character across the whole
animation — which is what a game sprite needs most.
