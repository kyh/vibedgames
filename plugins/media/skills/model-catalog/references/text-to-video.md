# Text-to-Video Endpoints

Curated picks across 4 use cases. **ByteDance Seedance 2.0** is the dominant premium choice; **Kling V3/O3** specializes in multi-shot and 4K; **Hailuo 2.3** is a strong newcomer for both premium and fast. Verify with `vg media models --endpoint_id <id> --json` before running.

## Premium realism

Final-quality video.

- `bytedance/seedance-2.0/text-to-video`: ByteDance · Seedance 2.0
- `fal-ai/bytedance/seedance/v1.5/pro/text-to-video`: ByteDance · Seedance 1.5 Pro
- `veo3.1`: Google · Veo 3.1
- `kling-video/v3/pro/text-to-video`: Kling · V3 Pro
- `kling-video/o3/pro/text-to-video`: Kling · O3 Pro
- `minimax/hailuo-2.3/pro/text-to-video`: Minimax · Hailuo 2.3 Pro

## Fast / cheap drafts

Fast motion preview, economical drafts.

- `bytedance/seedance-2.0/fast/text-to-video`: ByteDance · Seedance 2.0 Fast
- `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video`: ByteDance · Seedance 1 Pro Fast
- `xai/grok-imagine-video/text-to-video`: xAI · Grok Imagine
- `veo3.1/lite`: Google · Veo 3.1 Lite
- `kling-video/v3/standard/text-to-video`: Kling · V3 Standard
- `kling-video/o3/standard/text-to-video`: Kling · O3 Standard
- `minimax/hailuo-2.3/standard/text-to-video`: Minimax · Hailuo 2.3 Standard

## 4K capable

Endpoints with native 4K output.

- `kling-video/v3/4k/text-to-video`: Kling · V3 4K
- `kling-video/o3/4k/text-to-video`: Kling · O3 4K

## Multi-shot / storytelling

Multi-shot / element / timeline support.

- `kling-video/v3/pro/text-to-video`: Kling · V3 Pro
- `kling-video/v3/standard/text-to-video`: Kling · V3 Standard
- `bytedance/seedance-2.0/text-to-video`: ByteDance · Seedance 2.0
- `alibaba/happy-horse/text-to-video`: Alibaba · Happy Horse
- `wan/v2.7/text-to-video`: Alibaba · Wan 2.7

## Family-specific prompting

For prompt-craft details, see `model-prompting`:

- Kling family → [model-prompting/references/kling.md](../../model-prompting/references/kling.md)
- Happy Horse → [model-prompting/references/happy-horse.md](../../model-prompting/references/happy-horse.md)

## Discovery

```bash
vg media models --category text-to-video --limit 10 --json
vg media docs "text to video" --json
```
