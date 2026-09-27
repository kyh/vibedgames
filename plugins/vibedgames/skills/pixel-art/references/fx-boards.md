# Ability/spell FX boards (Recipe 6)

One generated board per effect gives every ability a silhouette players read at a glance, where a shared particle pack gives five abilities the same yellow starburst.

## Board shape

A 4×3 grid of 12 consecutive frames, no grid lines, labels or numbers, effect ~60% of the cell, same centre and scale in every cell. The prompt carries a per-frame beat list (1–3 anticipation, 4–8 peak, 9–12 decay) and the kit's palette hexes — `$FX_BOARD_PROMPT` in [prompts.md](prompts.md) (Recipe 6). Matte per the Recipe 5 lanes: energy art on flat black (cut luma<28, draw additive), matter art on flat `#00FF00` (`#FF00FF` for green effects; key + despill). `--background transparent` returns alpha≈254 with a painted glow — never rely on it.

```bash
# Fire async (own Bash tool call each; 4 in parallel is fine), then poll
vg generate run openai/gpt-image-2 --prompt "$FX_BOARD_PROMPT" --image_size "square_hd" --quality "high" --provider vibedgames --async --json
vg generate status openai/gpt-image-2 <request_id> --result --download ./game-assets/<slug>/fx/<effect>-board.png --json
```

- ~$1/board at `--quality high` on the platform runner (`--provider vibedgames`), 60–90 s each. Without the flag, `openai/gpt-image-*` routes to a local Codex CLI when one is installed; Codex-routed boards honour the matte less reliably (one probe came back white) — eyeball every board before packing.
- **Pack**: slice uniform 256-px cells → BOX-reduce to 128 → 12×1 horizontal strip (`pack-spritesheet.mjs` from Recipe 5, or PIL `Image.BOX`); frames stay centred in a fixed cell.
- **Directional art points RIGHT** (bolt, dagger fan, arrow) and is rotated at runtime toward the aim; move the origin onto the caster with an x-offset.
- **Ground-anchored art needs a vertical offset** from the anchor point (a cloud above the target, a pillar or flames rising from it).
- Register the strip + its prompt row in the `*-sources.json`; a target-anchored effect only plays if the sim emits its ability event (`vfx` skill, "Wiring FX to sim events").
