---
name: storytelling
description: >
  Build multi-shot narrative image, video, and audio workflows with `vg generate`.
  Use this for storyboards, shot lists, multi-prompt video, first-frame to
  last-frame pipelines, social stories, brand films, and sequence continuity.
---

# Storytelling with `vg generate`

Use this skill when the user wants a sequence, not a single asset. Load
references as needed:

- `references/shot-planning.md`
- `references/workflows.md`
- `references/examples.md`

Load `model-catalog` alongside this skill for default endpoint choices.

The goal is to produce clear story beats and executable vg generate runs. Avoid
generic inspiration copy, fake dialogue, and em dashes.

## Inputs to collect

Ask only when missing information affects execution.

- Format: ad, short film, music video, documentary, tutorial, social story.
- Duration and aspect ratio.
- Number of shots or allowed range.
- Main subject, character, product, or location.
- Continuity anchors: character, product, wardrobe, environment, color.
- Source media: first frame, reference image, product shot, audio track.
- Audio needs: narration, music, sound design, transcript, no audio.
- Preferred model: `model-catalog` defaults unless the user names one.

## Genmedia workflow

Follow the standard workflow in the [`generate` skill](../generate/SKILL.md): resolve endpoint → inspect schema/pricing → upload references (first frame, character, product, voiceover) → run each shot `--async` + `status` → download to `./outputs/story/{request_id}_{index}.{ext}`. Default endpoint IDs are in the Model routing section below.

Then choose the sequence route:

- Highest quality video: start with Seedance 2.0 endpoints from `model-catalog`.
- Native multi-prompt: use if schema has shot arrays, prompt lists, or timeline fields.
- First/last frame: controlled transitions between key frames.
- Image-to-video per shot: maximum continuity from approved stills.
- Manual per-shot generation: when the model only supports one prompt.
- Audio-first: generate or upload audio, then plan visual shot lengths.
- Lip-sync or talking avatar: Fabric 1.0 or Creatify Aurora from `model-catalog`.

Return a shot table with endpoint, request id, prompt summary, local path, and any continuity issues. Genmedia downloads clips; it does not replace a timeline editor unless the chosen model returns a complete stitched video.

## Shot planning

Plan every sequence as beats first:

1. Hook: immediate visual reason to keep watching.
2. Setup: who, what, where, and why it matters.
3. Development: movement, discovery, proof, or escalation.
4. Turn: reveal, transformation, result, or emotional change.
5. Close: final image, product memory, CTA-safe frame, or unresolved mood.

For each shot, write:

- Shot number and duration.
- Story purpose.
- Visual prompt.
- Continuity anchor.
- Input reference, if any.
- Genmedia endpoint.
- Expected output path.

## Prompt build order

Use this structure for each shot:

```text
SHOT [number], [duration]:
[story purpose]. [subject and action]. [location and time]. [camera framing].
[camera movement]. [lighting and color]. [continuity anchor]. [transition or
relationship to previous shot].
```

Keep one shot to one clear action unless the selected model supports multi-shot
or timeline prompting.

## Model routing

- Highest quality video: `bytedance/seedance-2.0/text-to-video`,
  `bytedance/seedance-2.0/image-to-video`, or
  `bytedance/seedance-2.0/reference-to-video`.
- Fast or lower-cost video: `xai/grok-imagine-video/text-to-video` or
  `xai/grok-imagine-video/image-to-video`.
- Multi-shot sequence: Seedance 2.0 first, then
  `fal-ai/kling-video/v3/pro/text-to-video`, then
  `fal-ai/kling-video/v3/pro/image-to-video`, then
  `alibaba/happy-horse/text-to-video` or
  `alibaba/happy-horse/image-to-video`.
- Text-heavy keyframes, boards, UI frames, posters, or infographics:
  `openai/gpt-image-2` at `quality=high`.
- Talking avatar, native audio, or lip-sync:
  `veed/fabric-1.0`, `veed/fabric-1.0/text`, or `fal-ai/creatify/aurora`.

## Quality bar

Before returning:

- Shot order has a clear narrative function.
- The first shot is strong enough for the platform.
- Continuity anchors are repeated without bloating every prompt.
- Camera motion is varied but not random.
- Durations add up to the requested runtime.
- Async request IDs and downloaded files are recorded.
- The model's actual schema, not assumptions, drove the final command.
