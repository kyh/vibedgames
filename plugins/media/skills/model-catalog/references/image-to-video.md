# Image-to-Video Endpoints

Curated picks across 6 use cases. **Seedance 2.0** dominates for general I2V; **Kling O3 / V3** specializes in reference-to-video and 4K; **Sora 2** is included for I2V. Avatar/lipsync has its own large bucket. Verify with `vg media models --endpoint_id <id> --json` before running.

## Premium realism

Final-quality image-to-video.

- `bytedance/seedance-2.0/image-to-video`: ByteDance · Seedance 2.0
- `bytedance/seedance-2.0/reference-to-video`: ByteDance · Seedance 2.0 Reference
- `fal-ai/bytedance/seedance/v1.5/pro/image-to-video`: ByteDance · Seedance 1.5 Pro
- `veo3.1/image-to-video`: Google · Veo 3.1
- `kling-video/v3/pro/image-to-video`: Kling · V3 Pro
- `kling-video/o3/pro/image-to-video`: Kling · O3 Pro
- `kling-video/o3/pro/reference-to-video`: Kling · O3 Pro Reference
- `sora-2/image-to-video`: OpenAI · Sora 2
- `minimax/hailuo-2.3/pro/image-to-video`: Minimax · Hailuo 2.3 Pro

## Fast / cheap

Economical / fast I2V.

- `bytedance/seedance-2.0/fast/image-to-video`: ByteDance
- `bytedance/seedance-2.0/fast/reference-to-video`: ByteDance
- `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video`: ByteDance
- `xai/grok-imagine-video/image-to-video`: xAI · Grok Imagine
- `xai/grok-imagine-video/reference-to-video`: xAI
- `veo3.1/lite/image-to-video`: Google · Veo 3.1 Lite
- `kling-video/v3/standard/image-to-video`: Kling · V3 Standard
- `minimax/hailuo-2.3/standard/image-to-video`: Minimax

## First/last frame interpolation

Controlled transition between start and end frames.

- `kling-video/o1/image-to-video`: Kling · O1 First-Last (Pro)
- `kling-video/o1/standard/image-to-video`: Kling · O1 First-Last (Standard)
- `veo3.1/first-last-frame-to-video`: Google · Veo 3.1
- `veo3.1/fast/first-last-frame-to-video`: Google · Veo 3.1 Fast
- `veo3.1/lite/first-last-frame-to-video`: Google · Veo 3.1 Lite
- `wan-flf2v`: Alibaba · Wan 2.1 First-Last
- `vidu/q1/start-end-to-video`: Vidu
- `vidu/start-end-to-video`: Vidu
- `pixverse/c1/image-to-video`: PixVerse C1

## Reference-to-video

Multiple reference images (person / style / element) → video.

- `bytedance/seedance-2.0/reference-to-video`: ByteDance · Seedance 2.0
- `bytedance/seedance-2.0/fast/reference-to-video`: ByteDance · Fast
- `fal-ai/bytedance/seedance/v1/lite/reference-to-video`: ByteDance · Lite
- `kling-video/o3/pro/reference-to-video`: Kling · O3 Pro
- `kling-video/o3/standard/reference-to-video`: Kling · O3 Standard
- `kling-video/o3/4k/reference-to-video`: Kling · O3 4K
- `alibaba/happy-horse/reference-to-video`: Alibaba · Happy Horse
- `xai/grok-imagine-video/reference-to-video`: xAI · Grok Imagine
- `veo3.1/reference-to-video`: Google · Veo 3.1
- `wan/v2.7/reference-to-video`: Alibaba · Wan 2.7
- `pixverse/c1/reference-to-video`: PixVerse C1

## 4K capable

Endpoints with native 4K output.

- `kling-video/v3/4k/image-to-video`: Kling · V3 4K
- `kling-video/o3/4k/image-to-video`: Kling · O3 4K
- `kling-video/o3/4k/reference-to-video`: Kling · O3 4K Reference

## Avatar / talking head / lipsync

Talking head, avatar, lip-sync video. The widest bucket in this modality, models differ meaningfully in input requirements, motion style, and language support.

- `veed/fabric-1.0`: Veed · Fabric 1.0 (image + audio)
- `creatify/aurora`: Creatify · Aurora
- `fal-ai/bytedance/omnihuman`: ByteDance · OmniHuman
- `fal-ai/bytedance/omnihuman/v1.5`: ByteDance · OmniHuman v1.5
- `bytedance/lynx`: ByteDance · Lynx
- `kling-video/v1/standard/ai-avatar`: Kling · AI Avatar (Standard)
- `kling-video/v1/pro/ai-avatar`: Kling · AI Avatar (Pro)
- `kling-video/ai-avatar/v2/pro`: Kling · AI Avatar v2 Pro
- `kling-video/ai-avatar/v2/standard`: Kling · AI Avatar v2 Standard
- `hunyuan-avatar`: Tencent · Hunyuan Avatar
- `hunyuan-portrait`: Tencent · Hunyuan Portrait
- `hunyuan-custom`: Tencent · Hunyuan Custom
- `kling-video/lipsync/audio-to-video`: Kling · Lipsync Audio-to-Video
- `kling-video/lipsync/text-to-video`: Kling · Lipsync Text-to-Video
- `flashtalk`: Flashtalk

For the multi-step TTS → lipsync recipe, see [media-recipes/references/character-lipsync.md](../../media-recipes/references/character-lipsync.md).

## Family-specific prompting

- Kling → [model-prompting/references/kling.md](../../model-prompting/references/kling.md)
- Happy Horse → [model-prompting/references/happy-horse.md](../../model-prompting/references/happy-horse.md)

## Discovery

```bash
vg media models --category image-to-video --limit 10 --json
vg media docs "image to video" --json
```
