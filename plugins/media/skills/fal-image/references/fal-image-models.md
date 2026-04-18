# fal Image Model Notes

These notes summarize the initial fal image endpoints configured in this skill.

Official model pages checked:

- `https://fal.ai/models/xai/grok-imagine-image/api`
- `https://fal.ai/models/xai/grok-imagine-image/edit/api`
- `https://fal.ai/models/fal-ai/nano-banana-2/api`
- `https://fal.ai/models/fal-ai/nano-banana-2/edit/api`
- `https://fal.ai/models/fal-ai/nano-banana-pro/api`
- `https://fal.ai/models/fal-ai/nano-banana-pro/edit/api`
- `https://fal.ai/models/fal-ai/gpt-image-1.5/api`
- `https://fal.ai/models/fal-ai/gpt-image-1.5/edit/api`

## Grok Imagine Image

- Generate endpoint: `xai/grok-imagine-image`
- Edit endpoint: `xai/grok-imagine-image/edit`
- Good for: xAI-family image generation and conversational image editing
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio` on generation
  - `output_format`
  - edit uses `image_urls`
  - edit supports multiple reference images
- Workflow note from this repo:
  - transparent-background intent was not reliable enough in our sprite experiments
  - treat Grok as a chroma-key candidate unless a later run proves true alpha handling
  - if using chroma, ask for exact flat `#00FF00`, no gradients, no shadows on the background, no texture, and no green spill

## Nano Banana 2

- Generate endpoint: `fal-ai/nano-banana-2`
- Edit endpoint: `fal-ai/nano-banana-2/edit`
- Good for: fast, modern image generation and conversational edits
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio`
  - `output_format`
  - `resolution`
  - `safety_tolerance`
  - edit uses `image_urls`
- Workflow note from this repo:
  - transparent-background requests produced faux-transparent/dark-background results rather than clean alpha
  - use exact chroma green `#00FF00` instead
  - forbid gradients, shadows on the background, texture, vignette, and green spill

## Nano Banana Pro

- Generate endpoint: `fal-ai/nano-banana-pro`
- Edit endpoint: `fal-ai/nano-banana-pro/edit`
- Good for: higher-end realism, typography, and coherent composition
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio`
  - `output_format`
  - `resolution`
  - `safety_tolerance`
  - edit uses `image_urls`
- Workflow note from this repo:
  - like Nano Banana 2, transparent-background intent was not reliable for sprite extraction
  - use exact chroma green `#00FF00` instead
  - the model may still frame the subject too small, so check scale as well as background obedience

## GPT Image 1.5

- Generate endpoint: `fal-ai/gpt-image-1.5`
- Edit endpoint: `fal-ai/gpt-image-1.5/edit`
- Good for: strong prompt adherence and high-fidelity edits
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `image_size`
  - `background`
  - `output_format`
  - `quality`
  - edit uses `image_urls`

## Practical Comparison Guidance

- Compare prompt adherence, identity consistency, edit locality, and transparency/background handling.
- Do not assume size and formatting controls mean the same thing across Grok, Banana, and GPT Image families.
- For edits, first compare with one reference image before adding multiple references.
- For this pirate workflow specifically, avoid magenta chroma. `#FF00FF` is too close to the bandana/warm shadow family and can contaminate edge cleanup.
