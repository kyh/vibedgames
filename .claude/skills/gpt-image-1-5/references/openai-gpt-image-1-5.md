# OpenAI GPT Image 1.5 Notes

This reference is intentionally narrow: only the parts needed to use `gpt-image-1.5` well inside Claude Code.

## Model Notes

From OpenAI's model page:

- `gpt-image-1.5` is the current GPT Image model for state-of-the-art image generation.
- Inputs: text and image.
- Outputs: image and text.
- OpenAI describes it as having better instruction following and prompt adherence than prior GPT image variants.

Model page:
- https://developers.openai.com/api/docs/models/gpt-image-1.5

## Images API Notes

From the Images API reference:

- `gpt-image-1.5` is accepted by the Images resource.
- Relevant endpoint for this skill's script: `POST /v1/images/generations`
- Other image endpoints also exist, including edits and variations.

Documented request controls relevant to generation:

- `size`: `1024x1024`, `1024x1536`, `1536x1024`, `auto`
- `quality`: `low`, `medium`, `high`, `auto`
- `output_format`: `png`, `webp`, `jpeg`
- `background`: `transparent`, `opaque`, `auto`

Documented response details relevant to scripting:

- GPT image models return image payloads as base64 JSON data.
- Generation responses include usage data for GPT image models.

Images API reference:
- https://developers.openai.com/api/reference/resources/images

## Practical Guidance

- Use `png` for lossless outputs and most transparent assets.
- Use `webp` when you want transparency with smaller files.
- Use `jpeg` only when transparency is not needed.
- Use `low` or `medium` for iteration; reserve `high` for final passes.
- Use portrait or landscape size only when composition genuinely benefits from it.

## Prompting Heuristics

Prompt with intent, not maximal length:

- subject
- composition
- style direction
- materials or rendering cues
- constraints
- exclusions

Example:

```text
Create a top-down alchemy table icon for a fantasy crafting game. Brass tools, stained oak, readable silhouette, soft studio lighting, centered, transparent background, no text, no frame, no watermark.
```
