# Campaign & UGC routing

Use-case routing for campaign-level marketing and creator-style social content.
Where the modality references organize picks by *what you generate*, this one
organizes by *the deliverable*. Verify any endpoint with
`vg generate models --endpoint_id <id> --json` and inspect schema before running.

## Marketing campaign assets

- Campaign key art, landing heroes, posters, text-heavy ads, app visuals, and
  exact-copy layouts: `openai/gpt-image-2` at `quality=high`.
- Premium still variants: `openai/gpt-image-2`, then
  `fal-ai/nano-banana-pro`, then `fal-ai/nano-banana-2`.
- Edits from product, logo, UI, or lifestyle references:
  `fal-ai/nano-banana-pro/edit`, then `openai/gpt-image-2/edit`.
- Fast variant exploration: `fal-ai/flux-2/klein/9b`.
- Product reveal or social campaign video:
  `bytedance/seedance-2.0/image-to-video`.
- Text-to-video campaign concept: `bytedance/seedance-2.0/text-to-video`.

## UGC and creator ads

- Portrait plus audio talking head: `veed/fabric-1.0`.
- Portrait plus text talking head: `veed/fabric-1.0/text`.
- Avatar with visual direction: `fal-ai/creatify/aurora`.
- Existing footage with new speech: `fal-ai/sync-lipsync/v2`.
- Product b-roll: `bytedance/seedance-2.0/image-to-video`.
- Fast b-roll draft: `xai/grok-imagine-video/image-to-video`.
