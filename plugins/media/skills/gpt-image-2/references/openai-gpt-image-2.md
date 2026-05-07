# OpenAI GPT Image 2 Notes

This reference is intentionally narrow: only the parts needed to use `gpt-image-2` well inside Claude Code.

## Model Notes

From OpenAI's model page and image generation guide, as verified on April 21, 2026:

- `gpt-image-2` is OpenAI's current state-of-the-art GPT Image model for generation and editing.
- The model page lists alias `gpt-image-2` and snapshot `gpt-image-2-2026-04-21`.
- Inputs: text and image.
- Outputs: image.
- Documented endpoints include:
  - `POST /v1/images/generations`
  - `POST /v1/images/edits`
  - Responses API image-generation workflows are also supported.

Official sources:

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/guides/image-generation

## Output Controls

The image generation guide documents these output controls for GPT Image:

- `size`
- `quality`
- `output_format`
- `output_compression`
- `background`

For `gpt-image-2` specifically:

- `size`, `quality`, and `background` support `auto`.
- `background: "transparent"` is not supported.
- `output_compression` applies to `jpeg` and `webp`.
- The Images API returns base64-encoded image data.

Guide notes:

- `jpeg` is faster than `png`.
- Square images are typically fastest to generate.

## Size Constraints

OpenAI's image generation guide documents that explicit `WIDTHxHEIGHT` sizes for `gpt-image-2` must satisfy all of these constraints:

- maximum edge length `<= 3840`
- both edges are multiples of `16`
- long-edge to short-edge ratio `<= 3:1`
- total pixels between `655,360` and `8,294,400`

Documented example sizes include:

- `1024x1024`
- `1536x1024`
- `1024x1536`
- `2048x2048`
- `2048x1152`
- `3840x2160`
- `2160x3840`
- `auto`

## Edit Notes

The guide documents that `input_fidelity` should be omitted for `gpt-image-2`:

- the API does not allow changing it for this model
- image inputs are always processed at high fidelity
- edit requests with reference images can therefore consume more input tokens

Practical implication:

- send only the reference images you actually need
- label image roles clearly in the prompt
- prefer small-delta edits when continuity matters

## Practical Guidance

- Use `low` for quick ideation and draft passes.
- Use `medium` for normal iteration.
- Use `high` for final outputs when detail matters enough to justify cost and latency.
- Use `png` when you want the safest default fidelity.
- Use `jpeg` or `webp` when compression or delivery size matters.
- Do not promise transparent cutouts with this model.
