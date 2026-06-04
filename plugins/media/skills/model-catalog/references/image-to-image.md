# Image-to-Image Endpoints

Curated picks across 12 use cases (10 editing + 2 quality). The dominant pattern: **instruction-based edit endpoints** (`nano-banana-pro/edit`, `nano-banana-2/edit`, `openai/gpt-image-2/edit`, `seedream/v5/lite/edit`) handle most needs. Specialist endpoints come in for outpainting, background removal, product shots, and high-quality upscaling.

Verify with `vg media models --endpoint_id <id> --json` before running.

## Editing: premium identity-preserving

Instruction-based edits that preserve character / face / product identity.

- `nano-banana-pro/edit`: Google · Nano Banana Pro Edit
- `nano-banana-2/edit`: Google · Nano Banana 2 Edit
- `openai/gpt-image-2/edit`: OpenAI · GPT Image 2 Edit
- `fal-ai/bytedance/seedream/v5/lite/edit`: ByteDance · Seedream v5 lite Edit

## Editing: multi-image compositing

Combine multiple references, product+scene, person+garment.

- `openai/gpt-image-2/edit`: OpenAI (up to 16 input images)
- `nano-banana-pro/edit`: Google
- `nano-banana-2/edit`: Google
- `qwen-image-edit-plus`: Alibaba · Qwen Image Edit Plus
- `flux-2/klein/9b/edit`: Black Forest Labs · FLUX.2 klein 9B Edit

## Editing: cheap alternatives

Low-cost edits, quick fixes, draft revisions.

- `flux-2/klein/9b/edit`: Black Forest Labs · FLUX.2 klein 9B Edit
- `flux-2/klein/4b/edit`: Black Forest Labs · FLUX.2 klein 4B Edit

## Inpainting (mask-based)

A single modern endpoint covers this, instruction-based has overtaken pure mask-based inpainting.

- `openai/gpt-image-2/edit`: OpenAI · GPT Image 2 Edit (best for both mask-based and instruction-based)

## Outpainting / expand

Extend the image beyond its borders.

- `bria/expand`: Bria AI · Expand Image
- `image-apps-v2/outpaint`: Image Outpaint

## Background remove + replace

Remove or replace the background.

- `bria/background/remove`: Bria AI · RMBG 2.0
- `bria/background/replace`: Bria AI · Background Replace
- `birefnet`: BiRefNet
- `birefnet/v2`: BiRefNet v2
- `pixelcut/background-removal`: Pixelcut

## Object removal / eraser

Erase an object and reconstruct what's behind it.

- `bria/eraser`: Bria AI · Eraser
- `bria/fibo-edit/erase_by_text`: Bria AI · Fibo Edit (erase by text)
- `qwen-image-edit-plus-lora-gallery/remove-element`: Alibaba · Qwen Edit Plus
- `nano-banana-2/edit`: Google
- `nano-banana-pro/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Relight

Re-render the lighting of a scene.

- `bria/fibo-edit/relight`: Bria AI · Fibo Edit Relight
- `qwen-image-edit-2509-lora-gallery/lighting-restoration`: Alibaba
- `qwen-image-edit-2509-lora-gallery/remove-lighting`: Alibaba
- `qwen-image-edit-plus-lora-gallery/lighting-restoration`: Alibaba
- `qwen-image-edit-plus-lora-gallery/remove-lighting`: Alibaba
- `openai/gpt-image-2/edit`: OpenAI
- `nano-banana-pro/edit`: Google
- `nano-banana-2/edit`: Google

## Character consistency

Same character across multiple variations.

- `openai/gpt-image-2/edit`: OpenAI
- `fal-ai/bytedance/seedream/v5/lite/text-to-image`: ByteDance · Seedream v5 lite
- `nano-banana-2/edit`: Google
- `nano-banana-pro/edit`: Google
- `ideogram/character/edit`: Ideogram V3 Character Edit

## Product shot / packaging fidelity

Ad imagery that preserves product or packaging fidelity.

- `bria/product-shot`: Bria AI · Product Shot
- `bria/embed-product`: Bria AI · Embed Product
- `qwen-image-edit-2509-lora-gallery/integrate-product`: Alibaba
- `qwen-image-edit-plus-lora-gallery/integrate-product`: Alibaba
- `nano-banana-pro/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Quality: Upscale premium

High-quality upscale for final delivery.

- `topaz/upscale/image`: Topaz Labs
- `clarityai/crystal-upscaler`: ClarityAI · Crystal Upscaler
- `seedvr/upscale/image`: SeedVR2

## Quality: Restoration

Fix blurry, noisy, or damaged images. Modern instruction-based edit endpoints have replaced specialist deblur/denoise models; Topaz upscale is a side path for resolution + light cleanup.

- `topaz/upscale/image`: Topaz Labs (resolution + light cleanup)
- `nano-banana-pro/edit`: Google ("clean up artifacts, sharpen edges")
- `nano-banana-2/edit`: Google
- `openai/gpt-image-2/edit`: OpenAI

## Discovery

```bash
vg media models --category image-to-image --limit 10 --json
vg media models "image edit" --json
vg media docs "image editing" --json
```
