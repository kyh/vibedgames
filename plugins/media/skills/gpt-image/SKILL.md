---
name: gpt-image
description: "Use OpenAI gpt-image-1.5 for image generation requests, prompt design, transparent-background assets, style-controlled illustrations, concept art, icons, and API-backed image creation via the Images API."
---

# GPT Image 1.5

Use this skill when the user wants actual image generation with OpenAI `gpt-image-1.5`, or when the task requires strong prompting and parameter selection for that model.

## Philosophy: Translate Intent Into A Production Request

Image generation is not "write a pretty prompt and hope." The job is to convert a vague art request into a concrete production request with the right subject, composition, style, constraints, and output settings.

**Before generating, ask:**
- What is the deliverable: concept art, icon, product render, marketing image, character sheet, UI element, or transparent asset?
- What must stay stable: framing, palette, era, camera angle, background treatment, text, or brand details?
- What should the file be optimized for: review, iteration speed, print quality, web use, or transparent cutout?
- Is the user asking for a single image, or are they really asking for a system of related images?

**Core principles**:
1. **Intent over adjective soup**: concrete composition and constraints beat long lists of style words.
2. **Output settings are part of the prompt**: size, quality, format, and background materially change usefulness.
3. **Truth over theater**: only claim an image was generated after running the API or receiving output.

## Working With GPT Image 1.5

OpenAI documents `gpt-image-1.5` as the latest GPT Image model with text and image input, and image and text output. The Images API supports `gpt-image-1.5` for generation, with `png`, `webp`, or `jpeg` output and documented size/quality/background controls. See `references/openai-gpt-image-1-5.md`.

### When To Use This Skill

- The user asks you to generate an image with OpenAI.
- The user wants a prompt for `gpt-image-1.5`.
- The user needs transparent-background assets, icons, concept art, product shots, or stylized illustrations.
- The user needs a runnable API example or a wrapper script for the Images API.

### Generation Workflow

1. Clarify the target deliverable and output constraints from the user request.
2. Write a prompt with these parts when relevant:
   - subject
   - composition
   - style/material/era
   - lighting/camera
   - important exclusions
   - file intent
3. Choose API settings deliberately:
   - `size`: `1024x1024`, `1024x1536`, `1536x1024`, or `auto`
   - `quality`: `low`, `medium`, `high`, or `auto`
   - `output_format`: `png`, `webp`, or `jpeg`
   - `background`: use `transparent` only with `png` or `webp`
4. If image generation is requested and `OPENAI_API_KEY` is available, use `scripts/gpt_image_generate.py`.
5. Save outputs to a user-visible path and report exactly what was generated.

### Prompt Construction

Prefer compact, production-oriented prompts:

```text
Create a side-view fantasy inn sign for a 2D platformer. Carved wood, brass brackets, hand-painted fox emblem, warm lantern glow, readable silhouette, transparent background, no mockup, no text, centered composition.
```

For style-sensitive work, add one clear visual direction instead of five contradictory ones:

- good: `1990s SNES-era platformer prop with restrained palette and crisp pixel clusters`
- bad: `hyper realistic painterly low poly anime cinematic pixel art watercolor`

For iteration, change one axis at a time:

- silhouette
- palette
- camera/framing
- surface detail
- mood/lighting

### OpenAI Cookbook Prompting Pointers

The OpenAI cookbook guidance for GPT Image 1.5 strengthens the prompt strategy above:

- Start by setting the **intended use** clearly: concept art, screenshot, icon, edit, text-heavy graphic, product render, or transparent asset.
- Keep prompt structure ordered and explicit:
  - subject
  - environment/background
  - composition / camera / framing
  - style / materials / era
  - lighting / color treatment
  - exact constraints and exclusions
- Be specific about **placement and relationships**: where objects are, what is foreground vs background, what overlaps, what must remain visible.
- For edits, state both:
  - what must change
  - what must stay unchanged
- For text in images, treat wording as literal content:
  - quote the exact text
  - keep it short
  - specify placement and typography expectations
- For multiple reference images, label them in the prompt conceptually, for example `image 1 = character silhouette`, `image 2 = color palette`, `image 3 = environment mood`.
- Iterate with **small controlled deltas** instead of rewriting the whole prompt every time.
- If layout fidelity matters, describe the image more like a design spec than a mood board.

### Sprite Animation Consistency

For low-resolution sprite animation edits, the model needs more than "same character" language. Tiny pixel characters drift easily in:

- frame-1 size
- body orientation
- outline thickness
- face readability
- costume silhouette

For sprite-strip work, use this stricter pattern:

1. Start from the **currently shipped in-game frame**, not an older concept export.
2. Build a transparent **reference canvas** with that shipped frame upscaled and placed into the intended slot layout.
3. Prefer one full-strip edit over frame-by-frame edits.
4. If iterating, prefer a **small-delta retouch** of the best current strip rather than a full reinterpretation.
5. In multi-image edits, label each image by role explicitly:
   - `Image 1 = identity anchor`
   - `Image 2 = pose/layout/motion anchor`
6. State both:
   - **what must change**
   - **what must stay unchanged**
7. Repeat the preserve list aggressively for:
   - side view
   - head size
   - silhouette family
   - palette family
   - outline thickness
   - apparent scale

For states that should begin from idle, there are two different tools:

- **Hard-lock on import**: good when gameplay must start from the exact shipped idle frame, but it can create a visible jump if the generated frame 2 does not match the locked frame 1 closely.
- **Protected frame-1 edit**: stronger when you need visual continuity. Keep frame 1 immutable in the edit itself, ideally with masking, and allow GPT to change only later frames.

Practical rule:

- If the problem is "the animation does not start from the real idle sprite," hard-lock can help.
- If the problem is "frame 1 and frame 2 feel like different characters," hard-lock alone is not enough. Use a more surgical edit or a mask.

Example structure:

```text
Create a portrait 16-bit pixel-art gameplay screenshot.
Subject: a pirate hero climbing a rope.
Environment: sea cave opening with dock platforms and shallow surf below.
Composition: side-view, centered hero, upward route clearly readable, HUD at top only.
Style: authentic 16-bit pixel art, 256x384 internal resolution, 4x nearest-neighbor upscale.
Lighting/color: bright coastal blues with warm stone and wood tones.
Constraints: visible pixels, limited palette, stepped shading, no glossy rendering, no collage, no poster framing.
```

## Using The Bundled Scripts

### Generate images

```bash
OPENAI_API_KEY=... \
python3 .claude/skills/gpt-image-1-5/scripts/gpt_image_generate.py \
  --prompt "Isometric potion shop icon, transparent background, polished game asset" \
  --out-dir tmp/potion_shop --quality high --size 1024x1024 --output-format png
```

Useful flags:

- `--background transparent`
- `--n 1`
- `--filename-prefix hero`
- `--user some-trace-id`

The script calls `POST /v1/images/generations`, decodes `b64_json`, and writes image files to disk.

### Edit images

```bash
OPENAI_API_KEY=... \
python3 .claude/skills/gpt-image-1-5/scripts/gpt_image_edit.py \
  --image input.png \
  --prompt "Keep the same sprite, raise the arm slightly" \
  --out-dir tmp/edit
```

Multi-image edits with fidelity control:

```bash
OPENAI_API_KEY=... \
python3 .claude/skills/gpt-image-1-5/scripts/gpt_image_edit.py \
  --image identity.png \
  --image motion-guide.png \
  --input-fidelity high \
  --prompt "Use image 1 for identity and image 2 for pose" \
  --out-dir tmp/edit
```

The edit script calls `POST /v1/images/edits` with multipart form data.

## Anti-Patterns To Avoid

❌ **Anti-pattern: claiming success before generation**
Why bad: the user asked for images, not a hypothetical prompt.
Better: run the script if credentials are available, or clearly say that API access is missing.

❌ **Anti-pattern: contradictory prompt stacks**
Why bad: the model gets weaker guidance, not stronger guidance.
Better: choose one subject, one composition, and one primary style direction.

❌ **Anti-pattern: transparent background with `jpeg`**
Why bad: OpenAI documents transparency for `png` and `webp`, not `jpeg`.
Better: use `png` or `webp` when transparency matters.

❌ **Anti-pattern: pretending sprite sheets are guaranteed**
Why bad: image models are better at generating single assets or illustrations than deterministic sheet layouts.
Better: ask for one asset, one pose, or one state per call unless the user explicitly wants experimentation.

❌ **Anti-pattern: defaulting every request to highest quality**
Why bad: it slows iteration and can waste cost on early ideation.
Better: use `low` or `medium` while exploring, then raise quality for final outputs.

❌ **Anti-pattern: treating "same character" as enough for tiny sprites**
Why bad: the model may preserve the idea of the character while still changing scale, orientation, or silhouette.
Better: restate exact invariants such as side view, head size, outline thickness, palette family, and apparent scale.

❌ **Anti-pattern: replacing frame 1 after the fact when the real problem is sequence mismatch**
Why bad: a locked first frame can make the animation more jarring if frame 2 was generated as a different-looking character.
Better: use hard-lock only when the generated strip already matches well, or move to a masked/protected frame-1 edit.

❌ **Anti-pattern: using repeated copies of the seed sprite as a stronger identity anchor by default**
Why bad: for tiny sprite work, repeating the same seed across every slot can still drift into a bad reinterpretation instead of preserving the intended character.
Better: test whether a single seeded slot or a surgical retouch of the current best strip produces better continuity.

## Variation Guidance

**IMPORTANT**: Do not converge on one house style for every request.

- Vary prompt structure by asset type: prop prompts, character prompts, icons, and scene art need different emphasis.
- Vary rendering direction based on the brief: painterly illustration, flat iconography, 3D render look, pixel-inspired concept, or UI-ready cutout.
- Prefer context-fit over random variation. Reuse style only when the user is building a consistent set.

## References

- API/model notes: `references/openai-gpt-image-1-5.md`
- Runnable generator: `scripts/gpt_image_generate.py`
- Runnable editor: `scripts/gpt_image_edit.py`
- OpenAI cookbook prompting guide: https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide/

## Remember

This skill should make image generation operational, not theoretical.

Turn the request into a precise prompt, choose the settings intentionally, run the API when possible, and report the real output path back to the user.
