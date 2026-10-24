# Text-to-Video Endpoints

Curated picks across 4 use cases. **ByteDance Seedance 2.5** is the default premium choice (native audio, up to 30s); **Kling 4.0** and **FLUX 3 Max** are the newest premium alternatives; **Kling V3/O3** specializes in multi-shot and 4K. Verify with `vg generate models --endpoint_id <id> --json` before running.

## Premium realism

Final-quality video.

- `bytedance/seedance-2.5/us/text-to-video`: ByteDance · Seedance 2.5 (the default; native audio, 4-30s)
- `kling/v4/text-to-video`: Kling · 4.0 (3-30s, 1080p)
- `blackforestlabs/flux-3-max/text-to-video`: Black Forest Labs · FLUX 3 Max
- `minimax/h3-max/text-to-video`: MiniMax · H3 Max
- `bytedance/seedance-2.0/text-to-video`: ByteDance · Seedance 2.0
- `fal-ai/bytedance/seedance/v1.5/pro/text-to-video`: ByteDance · Seedance 1.5 Pro
- `fal-ai/veo3.1`: Google · Veo 3.1
- `fal-ai/kling-video/v3/pro/text-to-video`: Kling · V3 Pro
- `fal-ai/kling-video/o3/pro/text-to-video`: Kling · O3 Pro
- `fal-ai/minimax/hailuo-2.3/pro/text-to-video`: Minimax · Hailuo 2.3 Pro

## Fast / cheap drafts

Fast motion preview, economical drafts.

- `bytedance/seedance-2.0/fast/text-to-video`: ByteDance · Seedance 2.0 Fast
- `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video`: ByteDance · Seedance 1 Pro Fast
- `xai/grok-imagine-video/text-to-video`: xAI · Grok Imagine
- `fal-ai/veo3.1/lite`: Google · Veo 3.1 Lite
- `fal-ai/kling-video/v3/standard/text-to-video`: Kling · V3 Standard
- `fal-ai/kling-video/o3/standard/text-to-video`: Kling · O3 Standard
- `fal-ai/minimax/hailuo-2.3/standard/text-to-video`: Minimax · Hailuo 2.3 Standard

## 4K capable

Endpoints with native 4K output.

- `fal-ai/kling-video/v3/4k/text-to-video`: Kling · V3 4K
- `fal-ai/kling-video/o3/4k/text-to-video`: Kling · O3 4K

## Multi-shot / storytelling

Multi-shot / element / timeline support.

- `fal-ai/kling-video/v3/pro/text-to-video`: Kling · V3 Pro
- `fal-ai/kling-video/v3/standard/text-to-video`: Kling · V3 Standard
- `bytedance/seedance-2.0/text-to-video`: ByteDance · Seedance 2.0
- `alibaba/happy-horse/text-to-video`: Alibaba · Happy Horse
- `fal-ai/wan/v2.7/text-to-video`: Alibaba · Wan 2.7

## Family-specific prompting

For prompt-craft details, see `model-prompting`:

- Kling family → [model-prompting/references/kling.md](../../model-prompting/references/kling.md)
- Happy Horse → [model-prompting/references/happy-horse.md](../../model-prompting/references/happy-horse.md)

## Discovery

```bash
vg generate models --category text-to-video --limit 10 --json
vg generate docs "text to video" --json
```
