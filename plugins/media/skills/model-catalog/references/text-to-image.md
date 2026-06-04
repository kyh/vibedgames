# Text-to-Image Endpoints

Curated picks across 8 use cases. The four standout families dominate this modality: **OpenAI gpt-image-2**, **Google nano-banana** (Pro / 2), **ByteDance Seedream v5 lite**, and **ByteDance Dreamina v3.1**. Verify with `vg media models --endpoint_id <id> --json` before running.

## Premium realism

Final commercial photoreal, realistic ads, editorial, premium portraits.

- `openai/gpt-image-2`: OpenAI · GPT Image 2 (use `quality=high`, expensive)
- `nano-banana-pro`: Google · Nano Banana Pro
- `nano-banana-2`: Google · Nano Banana 2
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance · Seedream v5 lite

## Premium stylized

Branded / illustrative output.

- `openai/gpt-image-2`: OpenAI
- `nano-banana-pro`: Google
- `nano-banana-2`: Google
- `ideogram/v3`: Ideogram
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance · Seedream v5 lite
- `fal-ai/bytedance/dreamina/v3.1/text-to-image`: ByteDance · Dreamina v3.1

## Fast / cheap drafts

Quick iteration, low-cost drafts.

- `flux-2/klein/4b`: Black Forest Labs · FLUX.2 klein 4B
- `flux-2/klein/9b`: Black Forest Labs · FLUX.2 klein 9B
- `flux-2/flash`: Black Forest Labs · FLUX.2 flash
- `z-image/turbo`: Alibaba · Z-Image Turbo

## 4K / ultra-res

Models capable of 2K-4K output.

- `openai/gpt-image-2`: OpenAI
- `nano-banana-pro`: Google
- `nano-banana-2`: Google
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance

## Text rendering / typography

Readable text inside the image, posters, UI, packaging.

- `openai/gpt-image-2`: OpenAI · best-in-class typography
- `nano-banana-pro`: Google
- `nano-banana-2`: Google
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance
- `fal-ai/bytedance/dreamina/v3.1/text-to-image`: ByteDance · particularly strong with Asian languages

## Anime / manga / stylized

Anime, manga, game concept-art styles. Modern endpoints with strong style + character handling fit here too.

- `openai/gpt-image-2`: OpenAI
- `nano-banana-pro`: Google
- `nano-banana-2`: Google
- `ideogram/v3`: Ideogram
- `recraft/v4/pro/text-to-image`: Recraft V4 Pro
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance
- `xai/grok-imagine-image`: xAI · Grok Imagine

## Vector / SVG / transparent background

- `recraft/v4/text-to-vector`: Recraft V4 (Vector)
- `recraft/v4/pro/text-to-vector`: Recraft V4 Pro (Vector)

## Open-weights (commercial-friendly)

Open-weight, fine-tunable models.

- `flux-2/klein/4b`: Black Forest Labs
- `flux-2/klein/9b`: Black Forest Labs
- `qwen-image-2512`: Alibaba · Qwen Image 2512
- `z-image/base`: Alibaba · Z Image Base
- `z-image/turbo`: Alibaba · Z-Image Turbo

## Family-specific prompting

For prompt-craft details, see the `model-prompting` skill:

- GPT Image 2 → [model-prompting/references/gpt-image-2.md](../../model-prompting/references/gpt-image-2.md)
- Kling family → [model-prompting/references/kling.md](../../model-prompting/references/kling.md)

## Discovery

```bash
vg media models "text to image" --json
vg media models --category text-to-image --limit 10 --json
vg media docs "text to image" --json
```
