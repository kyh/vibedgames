# OpenAI GPT Image Prompting Guide Notes

Use this reference when the task is prompt-heavy rather than parameter-heavy:

- text in images
- localization or text replacement edits
- multi-image reference prompting
- sketch-to-render or layout-preservation edits
- photoreal outputs where composition and polish matter
- prompts that are getting long or unstable

This is a distilled reference from the current OpenAI cookbook prompting guide for GPT Image models:

- https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide

## Core Prompting Principles

- Treat the prompt like a production spec, not a bag of style words.
- Include the intended use so the model understands the expected polish level and layout discipline.
- Use the format that is easiest to maintain. Short labeled sections are often easier to iterate on than a single paragraph.
- Keep prompt order stable. A reliable order is:
  - scene/backdrop
  - subject
  - key details
  - constraints
- If the user prompt is already specific, normalize and clarify it instead of inventing extra requirements.
- If the user prompt is generic, add only the detail that materially improves the result.

## Compact Prompt Scaffold

Use this scaffold when you need a repeatable prompt shape:

```text
Intended use:
Primary request:
Input images:
Scene/backdrop:
Subject:
Style/medium:
Composition/framing:
Lighting/mood:
Color palette:
Materials/textures:
Text (verbatim):
Constraints:
Avoid:
```

Guidance:

- `Intended use` is important. Examples: product mockup, landing-page hero, infographic, gameplay prop, text localization, sketch-to-render.
- `Input images` should label each image by role, not just filename.
- `Text (verbatim)` should contain the exact wording when text matters.
- `Constraints` should capture preserve-language and must-have requirements.
- `Avoid` should capture clear negatives without turning into a huge blacklist.

## Text In Images

Use stricter prompting when text accuracy matters:

- quote exact text
- say that the text must be rendered verbatim
- specify placement and typography expectations when relevant
- for tricky words, acronyms, or short labels, spell them out letter by letter if accuracy is critical
- for localization edits, preserve layout, hierarchy, and non-text visual elements unless the user asked for broader redesign

Useful pattern:

```text
Replace only the existing headline text with "SUMMER MARKET".
Keep the same typography style, placement, hierarchy, and surrounding graphics.
Do not change any other aspect of the design.
```

## Multi-Image Prompting

When multiple images are provided:

- reference them by index
- assign one job to each image
- keep roles distinct

Common roles:

- `image 1 = identity anchor`
- `image 2 = composition/layout reference`
- `image 3 = style/material reference`

Practical rule:

- send the minimum number of images needed
- describe how each image should influence the result
- restate preserve constraints when continuity matters

## Layout Preservation And Sketch-To-Render

For drawings, wireframes, compositions, or rough mockups that should be preserved:

- explicitly preserve layout
- explicitly preserve proportions
- explicitly preserve perspective
- then add realism, materials, or polish
- say not to add new elements or text unless that is part of the request

Useful pattern:

```text
Preserve the exact layout, proportions, and perspective.
Choose realistic materials and lighting consistent with the source.
Do not add new elements or text.
```

## Photoreal And Polished Renders

For photoreal work:

- say `photorealistic` directly when that look is required
- use camera/framing language for composition
- describe materials, textures, and lighting concretely
- use quality cues selectively rather than stacking many aesthetic adjectives

Good quality levers:

- realistic materials
- soft studio lighting
- macro detail
- textured brushstrokes
- editorial composition

Bad quality pattern:

- long chains of contradictory style tags with no clear subject or layout

## Iteration Discipline

When iterating:

- change one axis at a time
- repeat important invariants on every revision
- avoid rewriting the whole prompt unless the direction is genuinely wrong

Good iteration axes:

- composition
- lighting
- palette
- amount of detail
- one object or material change

## When To Reach For This Reference

Read this file before drafting when:

- the user wants text-heavy graphics
- the prompt needs multiple input images
- the task is an edit with strict preservation requirements
- the request is for an infographic, ad, UI mock, or packaging image
- the current prompt is drifting into adjective soup
