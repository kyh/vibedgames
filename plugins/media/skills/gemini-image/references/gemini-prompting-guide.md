# Gemini Image Prompting Guide

Patterns and pitfalls for prompting `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`, and `gemini-2.5-flash-image`. Source guidance: https://ai.google.dev/gemini-api/docs/image-generation

## Prompt Structure That Works

Order matters less than coverage. A strong prompt names:

1. **Intended use** — concept art, screenshot, icon, product render, infographic, edit pass, character sheet.
2. **Subject** — what is in frame and what it is doing.
3. **Scene / backdrop** — environment, surface, background treatment.
4. **Composition** — camera angle, framing, lens feel, focal point.
5. **Style / medium** — photographic, painterly, 3D render, line art, pixel-inspired, editorial.
6. **Lighting / color** — direction, mood, palette family.
7. **Text in image** — quoted verbatim, with placement and typography intent.
8. **Constraints / exclusions** — what must not appear (no text, no people, no logos, no frame).

For Pro and 3.1 Flash, the model handles long structured prompts well. For 2.5 Flash, keep prompts tighter.

## Compact Spec Pattern

When the brief benefits from structure, write the prompt as a labeled spec:

```text
Intended use: marketing hero image
Subject: a single matte-black wireless earbud floating mid-air
Scene: soft gradient backdrop, deep navy to graphite
Composition: dead-center subject, slight three-quarter rotation, generous negative space below for headline
Style: high-end product photography
Lighting: rim light from upper right, subtle bounce from lower left
Text: none
Constraints: no logos, no shadows on the floor, no second earbud
Aspect: 16:9
```

This collapses to one `text` part on the wire, plus `imageConfig.aspectRatio: "16:9"`.

## Multi-Image References

Send references as additional `inline_data` parts in the same `contents[0].parts` array. Then label each image's job in the prompt:

```text
image 1 = identity anchor (use the face, hair, jacket from this image exactly)
image 2 = pose/composition reference (match this framing and body angle)
image 3 = palette reference (sample background colors from this image)
```

Then state both:
- what must change
- what must stay unchanged

Repeat the preserve list for the things that drift most: face proportions, palette family, brand text, silhouette, scale.

Reference budgets:
- 3.1 Flash: up to 10 object + 4 character refs.
- 3 Pro: up to 6 object + 5 character refs.
- 2.5 Flash: up to 3 total.

Send the minimum that anchors the brief. Each extra image costs input tokens and dilutes attention.

## Character Consistency Across Calls

To keep a character consistent across many renders:

1. Lock one **identity anchor image** of the character at production quality.
2. Send the anchor as `image 1` in every call.
3. In the prompt, name the character and re-state invariants verbatim each call:
   `"Keep the same face, hair color, costume silhouette, and proportions from image 1."`
4. Vary only the new request (pose, scene, lighting).
5. For sets (turnarounds, expression sheets), prefer one prompt that requests the full set in one call over many fragmented calls.

For multi-turn refinement, open a chat session — visual context carries forward without re-sending the anchor every turn.

## Multi-Turn Editing

Open a chat session for any request that will need more than one revision:

```python
chat = client.chats.create(
    model="gemini-3.1-flash-image-preview",
    config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
)

resp = chat.send_message("Create a cozy reading nook illustration, autumn palette")
# refine
resp = chat.send_message("Make it night with warm lamplight, keep the layout")
# undo
resp = chat.send_message("Go back to the daytime version but add a sleeping cat on the chair")
```

Each turn returns a new image; the prior image stays in context. This is stronger than one-shotting six revisions.

## Text In Images

Treat text as literal content:

- Quote the exact wording in double quotes.
- Keep it short.
- Specify placement: top-left, centered, lower band, etc.
- Specify typography intent: serif, sans, hand-lettered, all caps, weight.
- Avoid stacking long copy in image generation — render layout in code if the copy is more than a headline.

Pro is the strongest model for in-image text and structured layout (infographics, posters). 3.1 Flash handles short headlines well. 2.5 Flash is the weakest at text fidelity.

## Thinking Mode

- 3 Pro: thinking is on by default. Leave it on for infographics, multi-element scenes, or layout-heavy briefs. Set `thinkingLevel: "minimal"` for direct renders to save tokens.
- 3.1 Flash: thinking is opt-in. Turn it on with `thinkingLevel: "High"` when the prompt has many elements, complex relationships, or text layout requirements.
- 2.5 Flash: no thinking; keep prompts tight and direct.

Thinking tokens are billed regardless of whether `includeThoughts` is true.

## Grounding With Google Search

Add `tools: [{"google_search": {}}]` when the image must reflect:

- a specific real product (with current packaging, model, color).
- a real public location.
- a recent event or seasonal context.
- a real public figure (subject to model safety).

3.1 Flash also supports image search grounding — useful when a real visual reference exists on the open web. Image search cannot retrieve images of people.

Treat grounded images as illustration, not citation. The model reconstructs, it does not reproduce.

## Iteration Discipline

Change one axis at a time:

- subject pose or framing
- material or palette
- lighting direction
- background treatment
- detail density

Rewriting the whole prompt every revision makes drift impossible to diagnose.

## Edit Prompt Pattern

```text
Use image 1 as the identity anchor and image 2 as the composition guide.
Keep the same [face | silhouette | brand label | logo placement | palette family] from image 1.
Change only [the background | the lighting direction | the pose] to [new spec].
Match the [framing | aspect | crop] from image 2.
Aspect ratio: 16:9.
Do not add text. Do not add new characters. Do not change the costume.
```

State invariants positively ("keep ___") and exclusions negatively ("do not ___"). Both forms reinforce the same idea and reduce drift.

## When To Walk Away From Gemini

- **Transparent assets**: not supported. Use `gpt-image-1.5` (PNG/WebP transparent) or render on flat color and key it out.
- **Tight pixel art at native low resolution**: not the strength here. Use `retro-diffusion` or sprite-specific pipelines.
- **Very large arbitrary dimensions** (e.g., `3840x2160`): `gpt-image-2` supports explicit `WIDTHxHEIGHT`; Gemini operates on aspect ratios + size buckets.
- **Multi-image edits with masks**: Gemini does not expose a mask channel for the image model the way OpenAI's Images API edit endpoint does.

## Quick Reference

| Want | Set |
|---|---|
| Square icon | `aspectRatio: "1:1"`, `imageSize: "1K"` |
| Hero image | `aspectRatio: "16:9"`, `imageSize: "2K"` |
| Cinematic plate | `aspectRatio: "21:9"`, `imageSize: "4K"` (Pro/3.1) |
| Mobile vertical | `aspectRatio: "9:16"`, `imageSize: "2K"` |
| Editorial portrait | `aspectRatio: "4:5"`, `imageSize: "2K"` |
| Banner / ribbon | `aspectRatio: "8:1"` or `"4:1"` (3.1 Flash only) |
| Quick draft | `gemini-2.5-flash-image`, `imageSize: "1K"` |
| Layout-heavy | `gemini-3-pro-image-preview`, thinking default |
| Real-product render | `tools: [{"google_search": {}}]` |
