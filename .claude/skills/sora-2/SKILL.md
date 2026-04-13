---
name: sora-2
description: "Use OpenAI sora-2 for prompt design, text-to-video generation, image-guided video generation, and API-backed video job handling with polling and download via the Videos API."
---

# Sora 2

Use this skill when the user wants actual video generation with OpenAI `sora-2`, or when the task requires strong prompting, shot planning, and API parameter selection for that model. This skill should unlock operational video work, not just prompt suggestions.

## Philosophy: Direct A Scene, Not A Buzzword Stack

Video generation works best when the request reads like direction, not decoration. The job is to translate a vague idea into a concrete scene with clear subject, motion, camera, timing, and constraints.

**Before generating, ask:**
- What is the deliverable: concept clip, shot test, motion study, image-to-video continuation, or edit/remix?
- What must stay stable: subject identity, framing, shot type, duration, motion tempo, lighting, or style?
- What is the real priority: cinematic mood, product clarity, character continuity, motion readability, or iteration speed?
- Is the user asking for one clip, or a system of related clips with shared continuity?

**Core principles**:
1. **Scene clarity beats adjective piles**: subject, environment, action, and camera matter more than long style-word lists.
2. **Timing is part of the prompt**: duration, beat structure, and camera movement change the usefulness of the clip.
3. **Asynchronous generation is part of the workflow**: a video job is not done when created; it is done when the job completes and the file is downloaded.

## Working With Sora 2

OpenAI documents `sora-2` as the current frontier video generation model. The model page and Videos API guide describe text-to-video generation, image-guided generation, and async job retrieval via the Videos API. See `references/openai-sora-2.md`.

### When To Use This Skill

- The user asks you to generate a video with OpenAI.
- The user wants a prompt for `sora-2`.
- The user wants text-to-video concept shots, motion tests, or short cinematic clips.
- The user wants image-guided video generation from a reference image URL.
- The user needs a runnable API wrapper for creating, polling, and downloading video jobs.

### Video Generation Workflow

1. Clarify the target deliverable and continuity constraints.
2. Write the prompt like shot direction:
   - subject
   - environment
   - action
   - camera / framing / movement
   - style / materials / era
   - lighting / mood
   - constraints and exclusions
3. Choose API settings deliberately:
   - `size`: `1280x720` or `720x1280`
   - `seconds`: `4`, `8`, or `12`
4. If the request is image-guided, use an `image_url` reference and state what must stay fixed versus what should change.
5. Use `scripts/sora_video_generate.py` to create the job, poll until terminal status, and download the video.

### Image-Guided Pixel Animation Learnings

For sprite-animation experiments, the most reliable path in this repo has been:

1. Start from the currently shipped in-game frame, not an older concept frame.
2. Place that frame on a simple padded canvas instead of sending a tiny raw sprite by itself.
3. Keep the character large enough on the canvas that identity remains legible.
4. Request a locked camera and black background so extracted frames are easy to normalize later.
5. Treat the Sora result as motion source material, not as a final spritesheet export.

Important practical notes from live runs:

- `input_reference` via local file upload worked for this repo's image-guided runs.
- `image_reference` by URL was not the successful path here.
- The uploaded reference image needed to match the requested video size exactly.
- A tiny sprite on a very large canvas weakened identity preservation.
- A larger anchor with just enough padding improved likeness materially.

For walk and run tests, there was a clear tradeoff:

- stronger motion prompting improved the action read
- stronger identity preservation reduced redesign drift
- pushing too hard on identity sometimes collapsed the motion

So the right pattern is usually:

- keep the prompt direct and concrete
- explicitly state that the character must match the source image's pixel-art style, palette family, proportions, and silhouette
- then expect to curate and normalize the resulting frames afterward

### Prompt Construction

Prefer compact scene-direction prompts:

```text
Create a 10-second side-view pirate platformer concept shot. A compact pirate hero climbs from a sea cave toward wooden platforms while surf rises below. Camera stays locked in side view with gentle parallax only. Bright 16-bit-inspired colors, readable silhouette, no HUD, no text, no extra characters.
```

When motion matters, specify the beat structure:

- opening pose or situation
- key action or transition
- ending beat

When camera matters, say exactly what it should do:

- locked side view
- slow push-in
- static close-up
- low-angle tracking shot

For image-guided work, label references explicitly:

- `image 1 = subject identity and style anchor`
- `image 2 = environment or motion reference`

State both:

- what should change
- what must remain unchanged

For pixel-art character work, make the "must remain unchanged" section explicit:

- same character identity
- same face and head shape
- same bandana / clothing colors
- same pixel-art rendering style as the source image
- same sprite scale relative to the frame
- black or empty background only if the goal is later frame extraction

### Cookbook Prompting Pointers

The Sora 2 prompting guide reinforces a few patterns that matter for practical use:

- Use natural language scene direction instead of keyword soup.
- Be explicit about subject, scene, action, and camera behavior.
- Treat the prompt like direction for a shot, not a tag cloud.
- For image-guided requests, explain what the reference image provides and what new motion or change should happen.
- When the clip has multiple beats, describe them in order so the model has a temporal structure to follow.
- Keep prompts concrete enough to guide motion, but not overloaded with contradictory cinematic vocabulary.

## Using The Bundled Script

Create and download a text-to-video clip:

```bash
OPENAI_API_KEY=... \
python3 .claude/skills/sora-2/scripts/sora_video_generate.py \
  --prompt "A brass astrolabe turns slowly on a captain's desk by lantern light." \
  --out-dir tmp/sora-clip --size 1280x720 --seconds 4
```

Create and download an image-guided clip:

```bash
OPENAI_API_KEY=... \
python3 .claude/skills/sora-2/scripts/sora_video_generate.py \
  --prompt "Animate this pixel-art pirate into a short run cycle while preserving the exact character style from the source image." \
  --image-file ./pirate-anchor-canvas-720x1280.png \
  --out-dir tmp/sora-clip --size 720x1280 --seconds 4
```

Useful flags:

- `--image-url https://...`
- `--image-file ./local-reference.png`
- `--poll-interval 10`
- `--timeout 900`
- `--no-wait`
- `--no-download`
- `--filename-prefix shot-01`

The script calls `POST /v1/videos`, polls `GET /v1/videos/{id}`, and downloads the file from `GET /v1/videos/{id}/content`.

## Anti-Patterns To Avoid

❌ **Anti-pattern: prompting with cinematic synonyms instead of scene logic**
Why bad: the model gets atmosphere but weak action and continuity.
Better: specify subject, environment, action, camera, duration, and exclusions.

❌ **Anti-pattern: treating create response as final output**
Why bad: video generation is asynchronous.
Better: poll until completion and download the finished file.

❌ **Anti-pattern: under-specifying the camera**
Why bad: the clip may invent movement or framing that breaks the intent.
Better: say whether the camera is locked, tracking, pushing in, or static.

❌ **Anti-pattern: overloading one short clip with too many story beats**
Why bad: 5-20 second clips cannot carry a whole trailer worth of events cleanly.
Better: focus each clip on one shot or a short, ordered beat sequence.

❌ **Anti-pattern: vague image-guided edits**
Why bad: the model may drift identity, style, or composition.
Better: say what the reference image contributes and what should remain unchanged.

❌ **Anti-pattern: assuming still-image continuity transfers automatically**
Why bad: a clip can keep the scene idea while redesigning the subject.
Better: treat identity preservation as an explicit requirement and don't assume the model will infer it from a loose reference.

❌ **Anti-pattern: using a tiny sprite as the only identity signal on a huge canvas**
Why bad: the model gets too little information about the real character.
Better: use a larger, size-matched reference canvas with enough padding for motion, but keep the subject prominent.

❌ **Anti-pattern: shipping the raw Sora frames as the final game animation**
Why bad: the clip may contain repeated cycles, soft transitional poses, or drifting registration.
Better: use Sora to generate motion reference, then normalize and curate a single runtime loop afterward.

## Variation Guidance

**IMPORTANT**: Do not converge on one house-video pattern for every request.

- Vary prompts by clip type: product demo, motion study, character shot, landscape plate, or cinematic concept.
- Vary camera language by the brief: locked gameplay-style shot, handheld-feel motion, clean product orbit, or static portrait.
- Vary prompt density based on the goal: sparse for exploratory motion tests, more specific for continuity-critical shots.
- Prefer context-fit over ornamental "cinematic" wording.

## References

- API/model notes: `references/openai-sora-2.md`
- Runnable generator: `scripts/sora_video_generate.py`
- OpenAI Sora 2 prompting guide: https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide/
- OpenAI Sora 2 model page: https://developers.openai.com/api/docs/models/sora-2

## Remember

This skill should make video generation operational, not theoretical, and should enable real video jobs instead of hypothetical workflow talk.

Turn the request into a concrete shot, choose the duration and size intentionally, create the job, wait for completion, download the result, and report the real output path back to the user.
