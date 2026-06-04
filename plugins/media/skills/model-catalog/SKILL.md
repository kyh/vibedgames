---
name: model-catalog
description: >
  Choose the right model endpoint for a given task. Modality-organized catalog
  of production endpoint defaults, text-to-image, image-to-image, text-to-video,
  image-to-video, and more. Use when the user has not named a specific model,
  or asks "which model for X", "best endpoint for Y", "what should I use for Z".
---

# Models Catalog

Endpoint-first navigation for production work. Each modality reference lists curated picks organized by use case (premium realism / fast & cheap / 4K / specialized). Before reaching for free-text search, consult the modality reference that matches the task.

> **Runtime:** All endpoint calls use the `vg media` CLI (`npm install -g vibedgames`, or `pnpm dogfood` in this repo). The API key lives on the vibedgames server, so there is no per-machine setup. See the `media` skill for the command reference.

## Endpoint-first rule

1. Pick the endpoint ID from the right modality reference.
2. Verify it: `vg media models --endpoint_id <endpoint_id> --json`.
3. Inspect it: `vg media schema <endpoint_id> --json`.
4. Check cost when relevant: `vg media pricing <endpoint_id> --json`.
5. Use text search only if the routed endpoint is missing, deprecated, rejected, or the role is not covered here:

```bash
vg media models "<task description>" --json
vg media docs "<topic>" --json
```

Do not invent endpoint IDs.

## Modality references

Load the reference matching the user's task:

- [text-to-image.md](references/text-to-image.md), image generation from prompt (text-heavy, premium still, fast draft)
- [image-to-image.md](references/image-to-image.md), image editing, inpainting, background removal, upscaling
- [text-to-video.md](references/text-to-video.md), video generation from prompt (highest quality, fast/economical, multi-shot storytelling)
- [image-to-video.md](references/image-to-video.md), video from a reference frame (including audio-driven and lip-sync variants)
- [video-to-video.md](references/video-to-video.md), video edit, restyle, upscale, background removal
- [text-to-3d.md](references/text-to-3d.md), 3D model generation from text
- [image-to-3d.md](references/image-to-3d.md), 3D model generation from reference images
- [text-to-audio.md](references/text-to-audio.md). TTS, music, SFX generation
- [audio-to-text.md](references/audio-to-text.md), speech-to-text (Whisper, ElevenLabs Scribe with diarization)
- [image-to-text.md](references/image-to-text.md). OCR, captioning, VQA, detection, segmentation

## Utility endpoints

For workflow utility endpoints (resize, composite, mask, audio merge, subtitle, etc.), search the catalog with `vg media models --category <modality>` and inspect the candidates with `vg media schema <endpoint_id>`.

Utility endpoints are explicit because they are deterministic tools, not creative model choices. Always inspect schema before use.
