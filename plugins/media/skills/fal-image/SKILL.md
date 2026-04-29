---
name: fal-image
description: "Use fal.ai for text-to-image and image-edit generation, model comparison, queue-based image workflows, and cost-aware experiment tracking with Nano Banana and GPT Image endpoints."
metadata:
  short-description: "fal.ai image generation, editing, and comparison."
---

# fal.ai Image

Use this skill when the user wants to generate or edit images through `fal.ai`, compare multiple marketplace image models, or build repeatable experiment workflows with prompts, references, outputs, and costs tracked in a consistent way.

## Philosophy: Standardize The Harness, Not The Image Model

fal gives one platform surface for many image models, but the useful controls still differ by model family. The right abstraction is:

- standardize auth, queueing, file handling, output capture, and cost tracking
- keep model-specific knobs explicit
- compare models on the same task, not by pretending they all expose the same schema

**Before generating, ask:**
- Is this a fresh generation or an edit run?
- What must stay constant across models: prompt intent, reference images, size target, transparency, or output count?
- Which model-specific controls materially affect fairness and need to be frozen?
- Do we need pre-run cost estimates, per-run request IDs, or both?

**Core principles**:
1. **Queue-first for tracked experiments**: image calls can be synchronous, but queue mode gives request IDs, polling, and consistent logging.
2. **Reference discipline matters**: editing runs should pass only the images the model actually needs; too many references dilute control.
3. **Prompt parity beats fake parity**: keep the task stable, then document the real model-specific compromises.
4. **Tracking is part of the run**: a generation is not complete until prompt, request metadata, outputs, and cost signals are recorded.

## What This Skill Provides

- A portable, repo-scoped fal image workflow with no repo-wide Python packaging requirement.
- A generic queue-based image runner for both text-to-image and edit endpoints.
- Model presets for:
  - `grok-imagine-image-t2i`
  - `grok-imagine-image-edit`
  - `nano-banana-2-t2i`
  - `nano-banana-2-edit`
  - `nano-banana-pro-t2i`
  - `nano-banana-pro-edit`
  - `gpt-image-1.5-t2i`
  - `gpt-image-1.5-edit`
- Platform tooling for:
  - model lookup
  - pricing
  - estimate-cost
  - usage
  - request audit
- A batch runner that executes the same image task across multiple fal models and appends a central ledger row per run.

## How Image Calls Reach fal

This skill never calls the fal API directly for image generation. The
inference runner shells out to the vibedgames CLI (`vg image generate` /
`vg image edit --provider fal`), which proxies to fal server-side. The
FAL API key lives on the platform — users authenticate once with
`vg login` and never handle a key locally.

Server-side, the proxy uses fal's queue API:

- submit: `POST https://queue.fal.run/{endpoint_id}`
- status: `GET https://queue.fal.run/{endpoint_id}/requests/{request_id}/status`
- result: `GET https://queue.fal.run/{endpoint_id}/requests/{request_id}`

with these headers:

- `X-Fal-Store-IO: 1`
- `x-app-fal-disable-fallback: true`

`x-fal-billable-units` and `request_id` are surfaced back to the script as
part of the run metadata.

Prerequisites:

- `vg` CLI installed (`npm i -g vibedgames`)
- `vg login` to authenticate

### Caveats After Proxying

- Pre-run cost estimates and the `fal_platform_models.py` tooling are
  **not** routed through `vg`; they remain direct fal calls and require a
  `FAL_KEY`. They are maintainer-only and not needed for image runs.
- `output_urls` in run manifests are now empty — generated outputs are
  served via short-lived presigned URLs the CLI downloads to disk on the
  user's behalf.

### Prompting Guidance For Image Comparison

Prompt like art direction, not like marketing copy:

- subject identity
- composition
- camera/framing
- background
- rendering style
- edit constraints
- exclusions

For edit comparisons:

- explicitly say what must stay unchanged
- keep the edit localized in language even if the model edits holistically
- keep reference count low
- be specific about transparency or background removal if needed

Background handling matters more than the prompt wording suggests:

- `gpt-image-1.5` is the safest option here when you genuinely need transparent output.
- `nano-banana-2` and `nano-banana-pro` should be treated as chroma-key models for this workflow, not transparent-background models.
- In this repo's experiments, Grok behaved more like the Banana models than GPT for background handling, so prefer chroma there too unless a later run proves otherwise.
- For chroma-key runs, ask for an exact flat green background: `#00FF00`, with no gradients, no cast shadows on the background, no texture, and no green spill on the subject.
- Do not use magenta by default for this pirate workflow. `#FF00FF` sits too close to the warm red/purple bandana family and is more likely to contaminate edge colors.

For text-to-image comparisons:

- hold composition intent stable
- ask for one clear deliverable
- keep size/background expectations explicit

Do not overload first comparison runs with long prompt stacks. The first job is to test prompt adherence, identity preservation, and edit usefulness.

## Scripts

- `scripts/fal_queue_image_run.py`
  - one text-to-image or image-edit run via `vg image`
  - downloads image outputs
  - writes normalized run manifest
- `scripts/fal_image_experiment_matrix.py`
  - run the same task across multiple image presets via the queue runner
  - append central ledger rows
- `scripts/fal_platform_models.py`
  - **maintainer-only**: query fal platform APIs for model metadata and
    cost surfaces. Requires a direct `FAL_KEY` and is not part of the
    skill's user-facing image flow.

## Repo Workflow

Machine-readable tracking:

- `experiments/fal-image/ledger.jsonl`
- `experiments/fal-image/ledger.csv`
- `experiments/fal-image/<timestamp>-<slug>/batch.json`

Human-readable tracking:

- `prompts/<timestamp>-...-prompts.md`
- `learnings/<timestamp>-...-learnings.md`

Generated images should still live under the appropriate `public/assets/.../concepts/...` path for the asset family being tested.

## Anti-Patterns To Avoid

❌ **Anti-pattern: flattening all image models into one fake prompt schema**
Why bad: you hide the controls that actually affect quality and cost.
Better: use shared runner behavior plus explicit per-model presets and overrides.

❌ **Anti-pattern: treating edit and generate as the same task**
Why bad: edit runs depend on reference discipline and preservation constraints that text-to-image runs do not.
Better: keep separate presets and separate experiment configs for generation and editing.

❌ **Anti-pattern: recording only prompts and final PNGs**
Why bad: you cannot audit request IDs, retries, or cost later.
Better: always save raw JSON, normalized manifests, and ledger rows.

❌ **Anti-pattern: comparing models with hidden fallback routing**
Why bad: you may think you tested one endpoint but actually hit another route.
Better: set `x-app-fal-disable-fallback: true` on strict comparison runs.

❌ **Anti-pattern: stuffing many reference images into every edit**
Why bad: it weakens edit control and makes failure analysis harder.
Better: pass only the minimum reference images the edit actually needs.

❌ **Anti-pattern: asking Banana-family models for transparency and trusting the result**
Why bad: you may get a faux-transparent dark backdrop instead of a clean extraction surface.
Better: use an explicit chroma-key background and key it out later.

## References

- Platform notes: `references/fal-platform-notes.md`
- Queue and inference notes: `references/fal-queue-and-inference.md`
- Image model notes: `references/fal-image-models.md`
- Model presets: `assets/model-presets.json`

## Remember

A good fal image workflow is not just "can it render." It is:

- reproducible
- comparable
- cost-visible
- honest about model differences
