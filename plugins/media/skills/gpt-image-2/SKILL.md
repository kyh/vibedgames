---
name: gpt-image-2
description: "Use OpenAI gpt-image-2 for image generation and editing, arbitrary-size outputs up to 3840x2160, multi-image references, product renders, concept art, icons, and large-canvas illustrations via the vg CLI."
---

# GPT Image 2

Use this skill when the user wants actual image generation or image editing with OpenAI `gpt-image-2`, or when the task needs strong prompting and deliberate output controls for that model.

## Philosophy: Treat Image Work Like A Spec, Not A Vibe

`gpt-image-2` is strongest when the request behaves like a production brief. The job is to translate intent into a spec the model can reliably execute: subject, framing, materials, constraints, output size, and edit boundaries.

**Before generating, ask:**
- What is the deliverable: concept art, icon, product render, scene plate, marketing image, or reference-driven edit?
- What must stay stable: identity, camera angle, silhouette, text, palette, proportions, or brand cues?
- What is the output optimized for: fast iteration, final review, web delivery, or a specific pixel size?
- Is the user asking for one image, or for a reusable system of related images?

**Core principles**:
1. **Specification beats adjective piles**: clear subject/composition/output constraints are stronger than mood-word spam.
2. **Parameters are part of the creative brief**: `size`, `quality`, `output_format`, `output_compression`, and `background` materially change the result.
3. **Edits need preserve-language**: for image edits, state what changes and what must remain untouched.
4. **Truth over theater**: only claim an image exists after `vg image` actually ran and files were written.

## How Image Calls Reach OpenAI

This skill never calls the OpenAI API directly. All generation goes through
the vibedgames CLI (`vg image generate` / `vg image edit`), which proxies
to OpenAI server-side. The OpenAI API key lives on the platform — users
authenticate once with `vg login` and never handle a key locally.

Prerequisites:

- `vg` CLI installed (`npm i -g vibedgames`)
- `vg login` to authenticate

## Working With GPT Image 2

OpenAI documents `gpt-image-2` as the current state-of-the-art GPT Image model for generation and editing. Compared to older GPT Image flows:

- arbitrary image sizes are supported (subject to the constraints below)
- image inputs are always processed at high fidelity
- JPEG and WebP support explicit compression control
- transparent backgrounds are **not** supported; use `gpt-image-1.5` when transparency is a hard requirement

Read these references intentionally:

- `references/openai-gpt-image-2.md` for model and API constraints
- `references/openai-prompting-guide.md` for prompt structure, text-heavy workflows, multi-image prompting, and iteration patterns

### When To Use This Skill

- The user asks for OpenAI image generation or edits and wants the latest model.
- The user wants a prompt for `gpt-image-2`.
- The task benefits from large custom dimensions such as `2048x2048` or `3840x2160`.
- The user wants multi-image reference edits where identity and composition must be split across different source images.
- Pick `gpt-image-1.5` instead when transparency is required.

## Generation Workflow

1. Identify the deliverable, invariants, and output target.
2. Choose the prompt format that is easiest to maintain. A short labeled spec is usually better than a long paragraph for production work.
3. For prompt scaffolding, prefer this order when relevant:
   - intended use or asset type
   - scene or backdrop
   - subject
   - composition or camera framing
   - style/material/era
   - lighting/color treatment
   - text requirements
   - exact constraints and exclusions
4. If the request is text-heavy, layout-sensitive, or reference-driven, read `references/openai-prompting-guide.md` before drafting the final prompt.
5. Normalize detailed prompts instead of expanding them. Only add tasteful augmentation when the user's request is underspecified and the extra detail materially improves the result.
6. Choose output controls deliberately:
   - `size`: `auto` or any `WIDTHxHEIGHT` that satisfies the documented `gpt-image-2` limits
   - `quality`: `low`, `medium`, `high`, or `auto`
   - `output_format`: `png`, `webp`, or `jpeg`
   - `output_compression`: `0-100` for `jpeg` or `webp`
   - `background`: `opaque` or `auto`
7. If the user is logged in (`vg whoami`), run `vg image generate`.
8. Save outputs to a user-visible path and report exactly what was generated.

### Prompt Scaffold

Use a compact spec like this when the task benefits from structure:

```text
Intended use:
Primary request:
Input images:
Scene/backdrop:
Subject:
Style/medium:
Composition/framing:
Lighting/mood:
Text (verbatim):
Constraints:
Avoid:
```

For detailed prompting patterns by task type, read `references/openai-prompting-guide.md`.

### Prompt Construction

Prefer production-oriented prompts:

```text
Create a polished isometric apothecary counter prop for a fantasy management game. Brass scale, labeled glass jars, dark walnut wood, neatly arranged herbs, centered composition, soft studio lighting, readable silhouette, no text, no frame, no watermark.
```

For layout-sensitive work, structure the prompt like a design spec:

- intended use
- scene/background treatment
- subject and focal object
- camera/framing
- rendering direction
- literal constraints
- exclusions

For iterations, change one axis at a time:

- silhouette
- framing
- material treatment
- lighting
- palette
- density of detail

## Edit Workflow

`gpt-image-2` always processes image inputs at high fidelity. That makes edits stronger, but it also means reference-image edits can cost more than older low-fidelity edit flows.

For edits and reference-image workflows:

1. Send the minimum set of images needed for the task.
2. Label image roles in the prompt explicitly, for example:
   - `image 1 = identity anchor`
   - `image 2 = pose/layout reference`
   - `image 3 = texture/material reference`
3. State both:
   - what must change
   - what must stay unchanged
4. If the user needs a controlled retouch, prefer a small delta over a complete reinterpretation.
5. If the edit involves text replacement, localization, or layout preservation, read `references/openai-prompting-guide.md` and treat the prompt like a preservation spec.

Example edit prompt:

```text
Use image 1 as the identity anchor and image 2 as the composition guide. Keep the same bottle shape, label placement, and cork silhouette from image 1. Change only the glass color to smoky teal, add faint condensation, and match the three-quarter tabletop framing from image 2. Do not add extra props, text, or background clutter.
```

## Output Controls That Matter

### Size

OpenAI's guide documents these `gpt-image-2` constraints for explicit `WIDTHxHEIGHT` sizes:

- maximum edge length `<= 3840`
- both edges must be multiples of `16`
- aspect ratio must not exceed `3:1`
- total pixels must be between `655,360` and `8,294,400`

Popular documented sizes include:

- `1024x1024`
- `1536x1024`
- `1024x1536`
- `2048x2048`
- `2048x1152`
- `3840x2160`
- `2160x3840`
- `auto`

### Quality

- Use `low` for drafts, thumbnails, and cheap iteration.
- Use `medium` for normal design iteration.
- Use `high` for final assets when detail materially matters.
- Use `auto` when the brief does not justify forcing a quality level.

### Format And Compression

- `png`: lossless default, best when you want maximum fidelity.
- `jpeg`: smaller and faster; OpenAI notes JPEG is faster than PNG.
- `webp`: good when you want stronger compression with modern web delivery.
- `output_compression`: use only with `jpeg` or `webp`.

### Background

For `gpt-image-2`, use:

- `opaque`
- `auto`

Transparent backgrounds are not supported by this model. Use `gpt-image-1.5` for transparent assets.

## Calling vg image

### Generate

```bash
vg image generate \
  --model gpt-image-2 \
  --prompt "Premium olive oil bottle product shot on a clean stone surface, soft shadows, editorial lighting" \
  --output tmp/olive-oil \
  --filename-prefix olive \
  --params '{"quality":"medium","size":"2048x2048","output_format":"webp","output_compression":80}'
```

Useful params for `gpt-image-2`:

- `quality`: `low` / `medium` / `high` / `auto`
- `size`: any `WIDTHxHEIGHT` matching the constraints above, or `auto`
- `output_format`: `png` / `webp` / `jpeg`
- `output_compression`: `0-100` (jpeg/webp only)
- `background`: `opaque` / `auto`
- `n`: number of images per request

### Edit

```bash
vg image edit \
  --model gpt-image-2 \
  --image refs/identity.png \
  --reference refs/layout.png \
  --prompt "Use image 1 for identity and image 2 for composition. Keep the bottle silhouette and label placement. Change the liquid to deep amber." \
  --output tmp/bottle-edit \
  --params '{"size":"1536x1024","output_format":"jpeg","output_compression":70}'
```

### Smart auto-detect

`vg image` (no subcommand) picks `edit` when any input file flag is
passed (`--image`, `--reference`, `--mask`, `--palette`), otherwise
`generate`:

```bash
vg image --model gpt-image-2 --image sprite.png --prompt "raise the arm slightly" --output tmp/edit
```

### Cross-model comparison

Compare `gpt-image-2` against other models in one command:

```bash
vg image generate \
  --model openai:gpt-image-2,openai:gpt-image-1.5,fal:fal-ai/nano-banana-pro \
  --prompt "Painterly fantasy inn sign, opaque background" \
  --output tmp/compare \
  -n 2 -p 4
```

## Anti-Patterns To Avoid

❌ **Anti-pattern: treating `gpt-image-2` like a transparent-cutout model**
Why bad: OpenAI explicitly documents that transparent backgrounds are not supported for this model.
Better: use `opaque` or `auto`, or switch to `gpt-image-1.5` when transparency is a hard requirement.

❌ **Anti-pattern: forcing huge images by default**
Why bad: larger images raise cost and latency without helping every task.
Better: start with `1024x1024`, `1536x1024`, `1024x1536`, or `low` quality when exploring.

❌ **Anti-pattern: using `output_compression` with `png`**
Why bad: compression control is documented for `jpeg` and `webp`, not `png`.
Better: use `jpeg` or `webp` when compression is part of the requirement.

❌ **Anti-pattern: sending too many reference images**
Why bad: edits already run at high-fidelity image input, so extra references increase complexity and cost.
Better: send the minimum set of anchors needed and label each image's role clearly.

❌ **Anti-pattern: prompt salad**
Why bad: contradictory style and composition cues weaken adherence.
Better: specify one clear composition and one dominant rendering direction.

❌ **Anti-pattern: claiming success before `vg image` ran**
Why bad: a proposed prompt is not a generated asset.
Better: run `vg image` if the user is logged in, or clearly say authentication is missing.

## Variation Guidance

**IMPORTANT**: Do not collapse every request into one polished house style.

- Vary prompt emphasis by deliverable: product render, icon, character art, scene art, and edit requests need different structure.
- Vary size and format based on usage: web delivery, review images, marketing crops, and large art boards have different needs.
- Vary the level of specification: a literal product shot needs tighter control than loose concept exploration.
- Reuse a visual direction only when the user is intentionally building a consistent set.

## References

- API/model notes: `references/openai-gpt-image-2.md`
- Prompting patterns: `references/openai-prompting-guide.md`
- Official model page: https://developers.openai.com/api/docs/models/gpt-image-2
- Official guide: https://developers.openai.com/api/docs/guides/image-generation
- CLI command reference: `vg image --help`, `vg models`

## Remember

This skill should make `gpt-image-2` operational, not ceremonial.

Turn the request into a concrete spec, choose the parameters intentionally, run `vg image` when possible, and report the real output path back to the user.
