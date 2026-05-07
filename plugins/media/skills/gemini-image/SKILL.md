---
name: gemini-image
description: "Use Google Gemini image models (Gemini 3 Pro Image, Gemini 3.1 Flash Image / Nano Banana 2 Pro, Gemini 2.5 Flash Image / Nano Banana) for image generation, multi-image reference composition, character consistency, thinking-mode planning, and Google Search-grounded visuals through the vg CLI."
metadata:
  short-description: "Gemini image generation + editing through vg image."
---

# Gemini Image

Use this skill when the user wants image generation or editing with Google's Gemini image models, or when the task requires deliberate model selection, multi-image references, or grounded image generation.

## Philosophy: One API, Three Models, Pick With Intent

Google ships image generation through the same `generateContent` endpoint as the rest of Gemini. The decision space is not "which prompt" first — it is "which model, which `imageConfig`, which references, and is thinking worth its tokens."

**Before generating, ask:**
- What is the deliverable: concept art, marketing visual, product render, edit pass, infographic, screenshot, or character-consistent set?
- Which model fits: Pro (thinking, premium fidelity), 3.1 Flash (best all-around, widest aspect ratios, search grounding), or 2.5 Flash / Nano Banana (cheapest and fastest, 1K cap)?
- What must stay stable across calls: character identity, palette, layout, brand text, or aspect ratio?
- Does the task need reasoning over the prompt (multi-step layout, infographic, world building) or is a direct render enough?
- Is one image the goal, or does the user want iterative editing (issue several `vg image edit` calls, each feeding back the prior output)?

**Core principles**:
1. **Model selection is a parameter**: 3 Pro, 3.1 Flash, and 2.5 Flash are not interchangeable — they differ in resolution ceiling, reference capacity, aspect ratios, and whether thinking is on.
2. **`imageConfig` is part of the prompt**: `aspectRatio` and `imageSize` materially change framing, token cost, and asset usefulness.
3. **References have roles**: when sending multiple input images, label each image's job in the prompt rather than dumping a stack.
4. **Thinking is paid compute**: enable it for layout-heavy or reasoning-heavy briefs, skip it for direct renders.
5. **Truth over theater**: only claim an image was generated after `vg image` actually ran and bytes were written to disk.

## How Image Calls Reach Gemini

This skill never calls the Gemini API directly. All generation goes through
the vibedgames CLI (`vg image generate` / `vg image edit`), which proxies
to `POST /v1beta/models/{model}:generateContent` server-side with
`responseModalities=["TEXT","IMAGE"]`. The Gemini API key lives on the
platform — users authenticate once with `vg login` and never handle a key
locally.

Prerequisites:

- `vg` CLI installed (`npm i -g vibedgames`)
- `vg login` to authenticate

## Working With Gemini Image Models

Three image models are available:

- `gemini-3-pro-image-preview` — Pro tier, thinking on by default, up to 4K, up to 6 object + 5 character refs.
- `gemini-3.1-flash-image-preview` — best all-around, up to 4K, 14 aspect ratios, up to 10 object + 4 character refs, web + image search grounding.
- `gemini-2.5-flash-image` — Nano Banana; speed and cost optimized, 1K cap, up to 3 reference images, no thinking.

All outputs carry a SynthID watermark. Transparent backgrounds are not supported. Audio and video inputs are not accepted by these models.

Read these references intentionally:

- `references/gemini-image-models.md` for model variants, `imageConfig`, reference limits, and pricing-shaped token costs
- `references/gemini-prompting-guide.md` for prompt structure, multi-image references, multi-turn editing, thinking, and grounding

### When To Use This Skill

- The user asks for Gemini image generation or Nano Banana.
- The user wants to edit an image with Gemini image models.
- The user needs character or product consistency across several renders using reference images.
- The user wants a grounded image (real-world product, recent event, location) via Google Search.
- The user is comparing Gemini against `gpt-image-2`, `gpt-image-1.5`, or fal-hosted models.

### Model Selection

| Need | Recommended model | vg alias |
|---|---|---|
| Highest fidelity, complex layout, infographics, multi-step reasoning | `gemini-3-pro-image-preview` | `gemini-3-pro-image` |
| Most aspect ratios, most references, image-search grounding, balanced cost | `gemini-3.1-flash-image-preview` | `gemini-3.1-flash-image` |
| Cheap iteration, quick drafts, simple prompts at 1K | `gemini-2.5-flash-image` | `nano-banana` |
| Transparent cutouts | None — use `gpt-image-1.5` | — |
| Native pixel art / sprite art | None — use `retro-diffusion` or `gpt-image-2` | — |

## Generation Workflow

1. Identify the deliverable, invariants, and target aspect ratio / size.
2. Pick the model: 3 Pro for premium reasoning, 3.1 Flash for balanced default, 2.5 Flash for cheap drafts.
3. Draft the prompt with the order that matches the brief:
   - intended use or asset type
   - subject
   - scene or backdrop
   - composition or camera framing
   - style / material / era
   - lighting / color treatment
   - text requirements (verbatim, in quotes)
   - exact constraints and exclusions
4. Choose `imageConfig` deliberately:
   - `aspectRatio`: pick from the model's supported list (see `references/gemini-image-models.md`)
   - `imageSize`: `"1K"`, `"2K"` (3.x only), `"4K"` (3.x only), or `"512"` / `"0.5K"` (3.1 Flash only)
5. Decide if thinking helps:
   - 3 Pro: thinking is on by default; use `thinkingConfig.thinkingLevel: "minimal"` for direct renders
   - 3.1 Flash: thinking is opt-in; set `thinkingLevel: "High"` for layout-heavy work
   - 2.5 Flash: no thinking
6. If grounding is needed (real product, recent event, real place), add `tools: [{"google_search": {}}]`.
7. If the user is logged in (`vg whoami`), run `vg image generate`.
8. Save outputs to a user-visible path and report the file path and the model used.

### Prompt Scaffold

Use a compact spec like this when the brief benefits from structure:

```text
Intended use:
Subject:
Scene/backdrop:
Composition/framing:
Style/medium:
Lighting/mood:
Text (verbatim):
Aspect ratio:
Constraints:
Avoid:
```

For the actual API request, this maps to a single string in `contents[0].parts[0].text` plus the `imageConfig` block, both managed by the proxy.

### Prompt Construction

Prefer production-oriented prompts:

```text
Editorial overhead shot of a single matcha latte on a pale linen runner, ceramic cup with a thin gold rim, faint steam, scattered loose-leaf tea, warm afternoon window light from the left, magazine-style negative space on the right for headline text, no people, no logos.
```

For text-heavy or layout-sensitive work, structure the prompt as a design spec rather than a mood description, and quote any literal copy verbatim.

For iterations, change one axis at a time:
- subject pose or framing
- material or palette
- lighting direction
- background treatment
- density of detail

## Edit Workflow

For edits and reference-image workflows:

1. Send the minimum set of images needed.
2. Label image roles in the prompt explicitly:
   - `image 1 = identity anchor`
   - `image 2 = layout/pose reference`
   - `image 3 = palette/material reference`
3. State both:
   - what must change
   - what must stay unchanged
4. Prefer small deltas over wholesale reinterpretation when continuity matters.
5. For character or product consistency across many outputs, send the same identity anchor image in every call and keep the anchor language in the prompt verbatim.

Example edit prompt:

```text
Use image 1 as the identity anchor and image 2 as the composition guide. Keep the same character face, hair color, jacket pattern, and proportions from image 1. Change only the background to a rainy night street with neon signage, and match the three-quarter framing from image 2. Keep aspect ratio 16:9. Do not redesign the jacket, do not add new characters, do not add text.
```

### Iterative Editing

Gemini's chat-based multi-turn refinement isn't available through `vg image` — each call is a one-shot. For iterative refinement, feed the previous output back as the next call's `--image`, restate the identity anchor language verbatim, and prefer small deltas. Each turn re-pays high-fidelity input tokens, so consolidate edits when you can.

## `imageConfig` Choices That Matter

### Aspect Ratio

- `gemini-3.1-flash-image-preview`: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9
- `gemini-3-pro-image-preview` and `gemini-2.5-flash-image`: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9

Pick the aspect ratio based on the deliverable:
- 1:1 for icons, product tiles, social squares.
- 16:9 for hero images, screenshots, marketing banners.
- 9:16 for vertical mobile, story content.
- 21:9 for cinematic plates.
- 4:5 for editorial portraits.
- 1:4, 1:8, 4:1, 8:1 (3.1 Flash only) for ribbons, banners, vertical strips.

### Image Size

- `"512"` or `"0.5K"`: drafts and thumbnails (3.1 Flash only).
- `"1K"`: standard, available on all three models.
- `"2K"`: detailed work, 3.x models only.
- `"4K"`: final assets, 3.x models only.

Token cost scales with size. Stay at `1K` while exploring; bump to `2K` or `4K` only when detail materially matters.

### Thinking

- `thinkingLevel: "minimal"` — fastest, weakest reasoning.
- `thinkingLevel: "High"` — stronger layout planning, more tokens.
- 3 Pro: thinking is on by default; explicitly set `"minimal"` to disable.
- 3.1 Flash: thinking is opt-in.
- 2.5 Flash: no thinking knob.

### Grounding

Add `tools: [{"google_search": {}}]` to ground the image on real-world facts retrieved via Google Search.

- 3.1 Flash: web + image search.
- 3 Pro and 2.5 Flash: web search only.
- The image search path cannot retrieve images of people.

## Calling vg image

### Generate

```bash
vg image generate \
  --model gemini-3.1-flash-image \
  --prompt "Editorial overhead shot of a single matcha latte on linen, magazine negative space on the right, warm window light" \
  --output tmp/matcha \
  --params '{"imageConfig":{"aspectRatio":"16:9","imageSize":"2K"}}'
```

Useful params for Gemini:

- `imageConfig.aspectRatio`: any aspect ratio supported by the model
- `imageConfig.imageSize`: `"512"` / `"0.5K"` (3.1 Flash) / `"1K"` / `"2K"` / `"4K"`
- `thinkingConfig.thinkingLevel`: `"minimal"` / `"High"` (3 Pro / 3.1 Flash)
- `tools`: e.g. `[{"google_search":{}}]` for grounding

### Edit

```bash
vg image edit \
  --model gemini-3-pro-image \
  --image refs/identity.png \
  --reference refs/layout.png \
  --prompt "Use image 1 for identity and image 2 for composition. Keep the same face and jacket. Change background to a rainy night street with neon signage." \
  --output tmp/identity-edit \
  --params '{"imageConfig":{"aspectRatio":"16:9","imageSize":"4K"},"thinkingConfig":{"thinkingLevel":"High"}}'
```

### Cross-model comparison

```bash
vg image generate \
  --model gemini:gemini-3.1-flash-image-preview,openai:gpt-image-2 \
  --prompt "Painterly fantasy inn sign, opaque background" \
  --output tmp/compare \
  -n 2 -p 4
```

### Smart auto-detect

`vg image` (no subcommand) picks `edit` when any input file flag is passed
(`--image`, `--reference`), otherwise `generate`. Gemini does not accept
`--mask` or `--palette` roles — pass refs through `--image` / `--reference`
and label their job in the prompt.

## Anti-Patterns To Avoid

❌ **Anti-pattern: defaulting every request to 3 Pro**
Why bad: Pro thinking burns tokens on briefs that don't need reasoning.
Better: start with 3.1 Flash. Move to 3 Pro when layout, infographics, or multi-step reasoning matter.

❌ **Anti-pattern: requesting transparent backgrounds**
Why bad: Gemini image models do not produce transparent backgrounds.
Better: render on a flat color and key it out downstream, or switch to `gpt-image-1.5` for native transparent assets.

❌ **Anti-pattern: piling on reference images**
Why bad: each reference inflates input tokens and dilutes the model's focus. 2.5 Flash caps at 3 total; even 3.1 Flash works best with a tight set.
Better: send the minimum identity / layout / palette anchors needed, and label each image's role in the prompt.

❌ **Anti-pattern: leaving thinking at default for direct renders**
Why bad: 3 Pro defaults to thinking on; a literal product shot pays for reasoning it doesn't need.
Better: set `thinkingConfig.thinkingLevel: "minimal"` when the brief is direct.

❌ **Anti-pattern: forcing 4K early**
Why bad: 4K multiplies token cost without helping ideation.
Better: explore at 1K, lock the prompt, then re-render at 2K or 4K once.

❌ **Anti-pattern: using a Gemini image as evidence of facts**
Why bad: even with Google Search grounding, the rendered image is a stylized reconstruction, not a citation.
Better: ground when the image must reflect a real subject, but treat it as illustration, not source-of-truth.

❌ **Anti-pattern: claiming success before `vg image` ran**
Why bad: a proposed prompt is not a generated asset.
Better: run `vg image` if the user is logged in, or clearly say authentication is missing.

❌ **Anti-pattern: ignoring the SynthID watermark for redistribution decisions**
Why bad: every Gemini image carries an invisible SynthID watermark.
Better: surface this when the user asks about provenance, attribution, or "is this AI-generated."

## Variation Guidance

**IMPORTANT**: Do not collapse every Gemini request into one polished house style.

- Vary model choice by deliverable: drafts on 2.5 Flash, balanced work on 3.1 Flash, premium and complex layouts on 3 Pro.
- Vary aspect ratio by usage: square for icons, 16:9 for heroes, 9:16 for mobile, 21:9 for cinematic, 4:5 for editorial.
- Vary image size by stage: 1K while exploring, 2K/4K only at lock-in.
- Vary prompt structure by brief: a literal product shot needs tighter constraints; a stylized illustration needs more rendering direction; an infographic needs explicit text and layout.
- Reuse identity anchors only when the user is intentionally building a consistent set.

## References

- Model variants and parameters: `references/gemini-image-models.md`
- Prompting patterns: `references/gemini-prompting-guide.md`
- Official guide: https://ai.google.dev/gemini-api/docs/image-generation
- CLI command reference: `vg image --help`, `vg models`

## Remember

This skill should make Gemini image generation operational, not ceremonial.

Pick the model, set `imageConfig` and thinking with intent, run `vg image` when the user is logged in, and report the real output path and model back to the user.
