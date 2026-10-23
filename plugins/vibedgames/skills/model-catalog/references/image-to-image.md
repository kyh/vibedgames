# Image-to-Image Endpoints

Curated picks across 12 use cases (10 editing + 2 quality). The dominant pattern: **instruction-based edit endpoints** (`openai/gpt-image-2.5/flare/edit`, `google/nano-banana-2.1/edit`, `blackforestlabs/flux-3/edit-image`, `fal-ai/nano-banana-pro/edit`) handle most needs. Specialist endpoints come in for outpainting, background removal, product shots, and high-quality upscaling.

Verify with `vg generate models --endpoint_id <id> --json` before running.

## Editing: premium identity-preserving

Instruction-based edits that preserve character / face / product identity.

- `openai/gpt-image-2.5/flare/edit`: OpenAI · GPT Image 2.5 Flare Edit (the default; up to 16 references)
- `openai/gpt-image-2.5/sunburst/edit`: OpenAI · GPT Image 2.5 Sunburst Edit (tightest scoped edits)
- `google/nano-banana-2.1/edit`: Google · Nano Banana 2.1 Edit
- `blackforestlabs/flux-3/edit-image`: Black Forest Labs · FLUX.3 Edit
- `fal-ai/nano-banana-pro/edit`: Google · Nano Banana Pro Edit
- `fal-ai/nano-banana-2/edit`: Google · Nano Banana 2 Edit
- `openai/gpt-image-2/edit`: OpenAI · GPT Image 2 Edit
- `fal-ai/bytedance/seedream/v5/lite/edit`: ByteDance · Seedream v5 lite Edit

## Editing: multi-image compositing

Combine multiple references, product+scene, person+garment.

- `openai/gpt-image-2.5/flare/edit`: OpenAI (up to 16 input images)
- `openai/gpt-image-2/edit`: OpenAI (up to 16 input images)
- `fal-ai/nano-banana-pro/edit`: Google
- `fal-ai/nano-banana-2/edit`: Google
- `fal-ai/qwen-image-edit-plus`: Alibaba · Qwen Image Edit Plus
- `fal-ai/flux-2/klein/9b/edit`: Black Forest Labs · FLUX.2 klein 9B Edit

## Editing: cheap alternatives

Low-cost edits, quick fixes, draft revisions.

- `fal-ai/flux-2/klein/9b/edit`: Black Forest Labs · FLUX.2 klein 9B Edit
- `fal-ai/flux-2/klein/4b/edit`: Black Forest Labs · FLUX.2 klein 4B Edit

## Inpainting (mask-based)

A single modern endpoint covers this, instruction-based has overtaken pure mask-based inpainting.

- `openai/gpt-image-2/edit`: OpenAI · GPT Image 2 Edit (best for both mask-based and instruction-based)

## Outpainting / expand

Extend the image beyond its borders.

- `fal-ai/bria/expand`: Bria AI · Expand Image
- `fal-ai/image-apps-v2/outpaint`: Image Outpaint

## Background remove + replace

Remove or replace the background.

- `bria/guided-remove-background`: Bria AI · Guided Remove Background (the default; RMBG's cut, steered by an optional `prompt` naming what to keep)
- `fal-ai/bria/background/remove`: Bria AI · RMBG 2.0
- `fal-ai/bria/background/replace`: Bria AI · Background Replace
- `fal-ai/birefnet`: BiRefNet
- `fal-ai/birefnet/v2`: BiRefNet v2
- `pixelcut/background-removal`: Pixelcut

## Object removal / eraser

Erase an object and reconstruct what's behind it.

- `fal-ai/bria/eraser`: Bria AI · Eraser
- `fal-ai/bria/fibo-edit/erase_by_text`: Bria AI · Fibo Edit (erase by text)
- `fal-ai/qwen-image-edit-plus-lora-gallery/remove-element`: Alibaba · Qwen Edit Plus
- `fal-ai/nano-banana-2/edit`: Google
- `fal-ai/nano-banana-pro/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Relight

Re-render the lighting of a scene.

- `fal-ai/bria/fibo-edit/relight`: Bria AI · Fibo Edit Relight
- `fal-ai/qwen-image-edit-2509-lora-gallery/lighting-restoration`: Alibaba
- `fal-ai/qwen-image-edit-2509-lora-gallery/remove-lighting`: Alibaba
- `fal-ai/qwen-image-edit-plus-lora-gallery/lighting-restoration`: Alibaba
- `fal-ai/qwen-image-edit-plus-lora-gallery/remove-lighting`: Alibaba
- `openai/gpt-image-2/edit`: OpenAI
- `fal-ai/nano-banana-pro/edit`: Google
- `fal-ai/nano-banana-2/edit`: Google

## Character consistency

Same character across multiple variations.

- `openai/gpt-image-2/edit`: OpenAI
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance · Seedream v5 lite
- `fal-ai/nano-banana-2/edit`: Google
- `fal-ai/nano-banana-pro/edit`: Google
- `fal-ai/ideogram/character/edit`: Ideogram V3 Character Edit

## Product shot / packaging fidelity

Ad imagery that preserves product or packaging fidelity.

- `fal-ai/bria/product-shot`: Bria AI · Product Shot
- `fal-ai/bria/embed-product`: Bria AI · Embed Product
- `fal-ai/qwen-image-edit-2509-lora-gallery/integrate-product`: Alibaba
- `fal-ai/qwen-image-edit-plus-lora-gallery/integrate-product`: Alibaba
- `fal-ai/nano-banana-pro/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Quality: Upscale premium

High-quality upscale for final delivery.

- `fal-ai/topaz/upscale/image`: Topaz Labs
- `clarityai/crystal-upscaler`: ClarityAI · Crystal Upscaler
- `fal-ai/seedvr/upscale/image`: SeedVR2

## Quality: Restoration

Fix blurry, noisy, or damaged images. Modern instruction-based edit endpoints have replaced specialist deblur/denoise models; Topaz upscale is a side path for resolution + light cleanup.

- `fal-ai/topaz/upscale/image`: Topaz Labs (resolution + light cleanup)
- `fal-ai/nano-banana-pro/edit`: Google ("clean up artifacts, sharpen edges")
- `fal-ai/nano-banana-2/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Discovery

```bash
vg generate models --category image-to-image --limit 10 --json
vg generate models "image edit" --json
vg generate docs "image editing" --json
```
