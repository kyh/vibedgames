# Video-to-Video Endpoints

Curated picks across 5 use cases. **Kling O3** dominates content edit and style remix; **Wan family** specializes in animate/replace and motion control; **Topaz** is the upscale standard. Verify with `vg generate models --endpoint_id <id> --json` before running.

## Style remix / restyle

Restyle the entire video.

- `kling-video/o3/pro/video-to-video/reference`: Kling · O3 Pro Reference
- `kling-video/o3/standard/video-to-video/reference`: Kling · O3 Standard Reference
- `fal-ai/bytedance/video-stylize`: ByteDance · Video Stylize
- `bytedance/seedance-2.0/reference-to-video`: ByteDance · Seedance 2.0 Reference

## Content edit

Change a specific element while preserving motion.

- `kling-video/o3/pro/video-to-video/edit`: Kling · O3 Pro Edit
- `kling-video/o3/standard/video-to-video/edit`: Kling · O3 Standard Edit
- `alibaba/happy-horse/video-edit`: Alibaba · Happy Horse Video Edit
- `wan/v2.7/edit-video`: Alibaba · Wan 2.7 Edit
- `wan-vace-apps/video-edit`: Alibaba · Wan VACE Edit
- `xai/grok-imagine-video/edit-video`: xAI · Grok Imagine Edit
- `bytedance/seedance-2.0/reference-to-video`: ByteDance

## Animate / replace / motion control

Character animation, motion control, dreamactor.

- `wan/v2.2-14b/animate/move`: Alibaba · Wan-2.2 Animate Move
- `wan/v2.2-14b/animate/replace`: Alibaba · Wan-2.2 Animate Replace
- `fal-ai/bytedance/dreamactor/v2`: ByteDance · DreamActor v2
- `kling-video/v3/pro/motion-control`: Kling · V3 Pro Motion Control
- `kling-video/v3/standard/motion-control`: Kling · V3 Standard Motion Control
- `kling-video/v2.6/pro/motion-control`: Kling · V2.6 Pro Motion Control
- `kling-video/v2.6/standard/motion-control`: Kling · V2.6 Standard Motion Control
- `wan-fun-control`: Alibaba · Wan 2.2 Fun Control

## Upscale

Increase video resolution.

- `topaz/upscale/video`: Topaz Labs · Video Upscale
- `bytedance-upscaler/upscale/video`: ByteDance · Upscaler
- `wan-vision-enhancer`: Alibaba · Wan Vision Enhancer

## Background removal

Video background removal / matting.

- `birefnet/v2/video`: BiRefNet v2 Video
- `bria/video/background-removal`: Bria AI · Video BG Removal
- `veed/video-background-removal`: Veed · Video BG Removal
- `veed/video-background-removal/green-screen`: Veed · Green Screen

## VACE / specialized control

Wan VACE family covers inpaint / outpaint / reframe / depth / pose control through multiple endpoints. Discover utility endpoints via `vg generate`:

```bash
vg generate models "wan vace" --json
```

## Discovery

```bash
vg generate models --category video-to-video --limit 10 --json
vg generate docs "video editing" --json
```
