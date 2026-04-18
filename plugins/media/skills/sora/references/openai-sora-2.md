# OpenAI Sora 2 Notes

This reference is intentionally narrow: only the parts needed to use `sora-2` well inside Claude Code.

## Model Notes

From OpenAI's model page:

- `sora-2` is OpenAI's current frontier video generation model.
- The alias `sora-2` currently points to snapshot `sora-2-2025-12-16`.
- Inputs: text and images.
- Outputs: video.
- OpenAI documents the model as supporting both generate and edit-style workflows.

Model page:
- https://developers.openai.com/api/docs/models/sora-2

## Videos API Notes

From OpenAI's Videos API guide:

- Use `POST /v1/videos` to create a video job.
- Use `GET /v1/videos/{id}` to retrieve job status.
- Use `GET /v1/videos/{id}/content` to download the completed video bytes.
- Use `DELETE /v1/videos/{id}` to remove a stored video object.
- The guide also documents remix support at `POST /v1/videos/{id}/remix`, but the bundled repo script currently focuses on create, poll, and download.

Documented request controls in the guide:

- `size`: `1280x720`, `720x1280`
- `seconds`: `4`, `8`, `12`

Operational notes from the guide:

- Video generation is asynchronous.
- Rendering can take a few minutes.
- Download completed videos promptly because they expire 60 minutes after completion.

Videos guide:
- https://developers.openai.com/api/guides/video-generation

## Prompting Notes

From the Sora 2 prompting guide:

- Prompt in natural language, not keyword piles.
- Treat prompts as shot direction:
  - subject
  - scene
  - action
  - camera
  - lighting / mood
  - constraints
- When multiple beats matter, describe them in order.
- For image-guided video, make the role of the reference image explicit and state what should remain unchanged.
- Use camera language deliberately rather than implicitly.

Sora 2 prompting guide:
- https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide/

## Practical Guidance

- Use `1280x720` for landscape concept clips and broader cinematic framing.
- Use `720x1280` for portrait-first social or mobile compositions.
- Keep early exploration short: `5` or `10` seconds is easier to iterate on than `20`.
- When continuity matters, build the prompt around what must stay fixed before describing what should change.
- Treat image-guided clips as identity- or composition-anchored work, not unconstrained generation.
