---
name: model-routing
description: >
  Choose default model endpoint IDs for the production skills in this
  plugin. Use this with character-design, cinematography, storytelling,
  pixel-art, regenerate-3d, and media-workflow when the user
  has not named a specific model.
---

# Model routing

Use these endpoint defaults when a domain skill needs a model. These choices
come from project-specific guidance. Still run `vg media schema <endpoint_id>
--json` before execution and `vg media pricing <endpoint_id> --json` when cost
matters.

Endpoint-first rule:

1. Pick the endpoint ID from this skill.
2. Verify it with `vg media models --endpoint_id <endpoint_id> --json`.
3. Inspect it with `vg media schema <endpoint_id> --json`.
4. Check `vg media pricing <endpoint_id> --json` when cost matters.
5. Use text search only if the routed endpoint is missing, deprecated,
   rejected, or the task needs a model role not covered here.

Do not invent endpoint IDs.

## Image generation

### Text-heavy image work

Use for infographics, UI mockups, posters, product labels, packaging text,
readable signs, book covers, educational diagrams, and any output where text
inside the image must be accurate.

1. `openai/gpt-image-2`
   - Use `quality=high`.
   - Prefer 2K or 4K custom `image_size` when the final must be detailed.
   - Treat as expensive. Do not use it for cheap drafts.
2. `nano-banana-pro`
   - Use as the second choice when text is important but GPT Image 2 is not
     available or the user accepts a lower ceiling.

Cheap and simple models are not acceptable for text-heavy production.

### Premium still images

Use for commercial stills, realistic product scenes, editorial photography,
cinematic keyframes, and high-quality visual concepts.

- More realistic output: `openai/gpt-image-2`.
- High-quality styled output: `openai/gpt-image-2`.
- One step down: `nano-banana-pro`.
- Strong cheaper alternative: `nano-banana-2`.

### Fast draft images

Use for quick concepts, mood options, rough composition, and cheap iteration.

- `flux-2/klein/9b`

Do not use fast draft output as final commercial delivery unless the user asks.

## Image editing

Use for background replacement, relighting, cleanup, object changes, product
placement, outfit changes, character edits, and multi-image composition.

1. `nano-banana-pro/edit`
2. `openai/gpt-image-2/edit`
3. `fal-ai/bytedance/seedream/v5/lite/edit`

For product fidelity, also consider:

- `nano-banana-pro`
- `nano-banana-2`
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`
- `nano-banana-2/edit`

For consistent characters, use `openai/gpt-image-2` first. If editing an
existing character image, inspect `openai/gpt-image-2/edit`.

## Video generation

### Highest quality video

Use Seedance 2.0 first for final, high-quality video.

- Text to video: `bytedance/seedance-2.0/text-to-video`
- Image to video: `bytedance/seedance-2.0/image-to-video`
- Reference to video: `bytedance/seedance-2.0/reference-to-video`

Fast variants exist for lower latency:

- `bytedance/seedance-2.0/fast/text-to-video`
- `bytedance/seedance-2.0/fast/image-to-video`
- `bytedance/seedance-2.0/fast/reference-to-video`

### Fast or lower-cost video

Use Grok Imagine Video for fast, lower-cost motion previews and economical
video generation.

- Text to video: `xai/grok-imagine-video/text-to-video`
- Image to video: `xai/grok-imagine-video/image-to-video`
- Video edit: `xai/grok-imagine-video/edit-video`

### Multi-shot storytelling

Use in this order:

1. `bytedance/seedance-2.0/text-to-video`
2. `bytedance/seedance-2.0/image-to-video`
3. `bytedance/seedance-2.0/reference-to-video`
4. `kling-video/v3/pro/text-to-video`
5. `kling-video/v3/pro/image-to-video`
6. `alibaba/happy-horse/text-to-video`
7. `alibaba/happy-horse/image-to-video`

Use Kling v3 when its multi-prompt, element, or custom element controls match
the requested shot plan. Use Happy Horse after Seedance and Kling unless the
user specifically asks for it.

### Native audio and lip-sync

Use for talking avatars, speech-driven face motion, product spokespersons,
UGC-style presenters, and lip-sync from an image plus audio or text.

1. `veed/fabric-1.0`
   - Image plus uploaded audio.
2. `veed/fabric-1.0/text`
   - Image plus text speech.
3. `creatify/aurora`
   - Avatar video from image plus audio, with optional visual direction.

## Campaign and UGC routing

Use these when the user asks for campaign-level marketing or creator-style
social content.

### Marketing campaign assets

- Campaign key art, landing heroes, posters, text-heavy ads, app visuals, and
  exact-copy layouts: `openai/gpt-image-2` at `quality=high`.
- Premium still variants: `openai/gpt-image-2`, then
  `nano-banana-pro`, then `nano-banana-2`.
- Edits from product, logo, UI, or lifestyle references:
  `nano-banana-pro/edit`, then `openai/gpt-image-2/edit`.
- Fast variant exploration: `flux-2/klein/9b`.
- Product reveal or social campaign video:
  `bytedance/seedance-2.0/image-to-video`.
- Text-to-video campaign concept: `bytedance/seedance-2.0/text-to-video`.

### UGC and creator ads

- Portrait plus audio talking head: `veed/fabric-1.0`.
- Portrait plus text talking head: `veed/fabric-1.0/text`.
- Avatar with visual direction: `creatify/aurora`.
- Existing footage with new speech: `sync-lipsync/v2`.
- Product b-roll: `bytedance/seedance-2.0/image-to-video`.
- Fast b-roll draft: `xai/grok-imagine-video/image-to-video`.

## Utility endpoints

Workflow utility endpoint IDs live in the `workflow` skill reference:
`workflow/references/utility-endpoints.md`.

Utility endpoints are allowed to be explicit because they are deterministic
tools, not creative model choices. Always inspect schema before use.
