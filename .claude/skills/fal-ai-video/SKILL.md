---
name: fal-ai-video
description: "Use fal.ai for image to video generation, model comparison, queue-based inference, pricing and usage tracking, and portable multi-model experiment workflows with local prompt and cost logs."
metadata:
  short-description: "fal.ai video generation, comparison, and cost-aware experiment tooling."
---

# fal.ai Video

Use this skill when the user wants to generate media through `fal.ai`, compare multiple marketplace models, or build repeatable experiment workflows with prompts, inputs, outputs, and costs tracked in a consistent way.

## Philosophy: Standardize The Workflow, Not The Model

fal gives you one platform for many models, but it does not give you one truthful schema for all of them. The right abstraction is:

- standardize auth, queueing, file handling, output capture, and cost tracking
- keep model-specific knobs explicit
- compare models on the same task, not by pretending they expose identical controls

**Before generating, ask:**
- Is this a single run, or a comparison batch?
- What should stay constant across models: prompt, anchor image, duration target, background, camera, or framing?
- Which model-specific controls materially affect fairness and need to be frozen?
- Do we need exact per-run spend, pre-run estimates, or both?

**Core principles**:
1. **Queue-first for video**: long-running media generation should use fal’s queue workflow, not fragile synchronous assumptions.
2. **Prompt parity beats parameter parity**: hold the task steady, then document the model-specific compromises.
3. **Tracking is part of the run**: a generation is not complete until prompt, request metadata, outputs, and cost signals are recorded.

## What This Skill Provides

- A portable, repo-scoped fal workflow with no repo-wide Python packaging requirement.
- A generic image-to-video runner based on fal’s documented queue HTTP endpoints.
- Model presets for:
  - `seedance-pro-i2v`
  - `kling-v3-pro-i2v`
  - `hailuo-02-standard-i2v`
- Platform tooling for:
  - model lookup
  - pricing
  - estimate-cost
  - usage
  - request audit
- A batch runner that executes the same task across multiple fal models and appends a central ledger row per run.

## Working With fal In This Repo

### Core Execution Pattern

For video jobs, this skill uses fal’s queue API:

- submit: `POST https://queue.fal.run/{endpoint_id}`
- status: `GET https://queue.fal.run/{endpoint_id}/requests/{request_id}/status`
- result: `GET https://queue.fal.run/{endpoint_id}/requests/{request_id}`

Authentication uses:

- `Authorization: Key $FAL_KEY`
- in this repo, `FAL_API_KEY` is also accepted by the bundled scripts

Important platform headers for repeatable comparison runs:

- `X-Fal-Store-IO: 1`
- `x-app-fal-disable-fallback: true`

The runner also captures response headers such as:

- `x-fal-request-id`
- `x-fal-billable-units`

### Why This Skill Uses Raw HTTP First

The official `fal-client` SDK is valid and documented, but this repo’s first requirement is portability inside a Codex skill. The scripts therefore keep a deterministic raw-HTTP queue path and also use `fal-client` automatically when it is installed.

In this repo's retained live runs, some endpoints were most reliable when invoked with:

- `uv run --with fal-client python3 ...`

### Prompting Guidance For Video Comparison

Prompt like direction, not like marketing copy:

- subject identity
- action
- framing
- background
- motion constraints
- exclusions

For sprite-animation comparison:

- lock the facing
- lock the background
- lock the shot
- keep the action short and readable
- disable audio when the model supports it

Do not overload early comparison runs with cinematic flourishes. The first job is to test motion usefulness and identity preservation.

## Scripts

- `scripts/fal_queue_video_run.py`
  - one image-to-video run
  - writes request/result JSON
  - downloads output media
  - writes normalized run manifest
- `scripts/fal_platform_models.py`
  - query fal model metadata and cost surfaces
- `scripts/fal_video_experiment_matrix.py`
  - run the same task across multiple model presets
  - append central ledger rows

## Repo Workflow

Machine-readable tracking:

- `experiments/fal/ledger.jsonl`
- `experiments/fal/ledger.csv`
- `experiments/fal/<timestamp>-<slug>/batch.json`

Human-readable tracking:

- `prompts/<timestamp>-...-prompts.md`
- `learnings/<timestamp>-...-learnings.md`

Generated media should still live under the appropriate `public/assets/.../concepts/...` path for the asset family being tested.

## Anti-Patterns To Avoid

❌ **Anti-pattern: flattening all fal models into one fake schema**
Why bad: you lose the knobs that actually matter and comparisons become misleading.
Better: use shared runner behavior plus explicit per-model presets.

❌ **Anti-pattern: recording only prompts and outputs**
Why bad: you cannot audit request IDs, retries, or costs later.
Better: always save raw JSON, normalized manifests, and ledger rows.

❌ **Anti-pattern: comparing models with hidden fallback routing**
Why bad: you may think you tested one endpoint but actually hit another route.
Better: set `x-app-fal-disable-fallback: true` on strict comparison runs.

❌ **Anti-pattern: forcing every model to pretend it supports the same size and duration controls**
Why bad: it creates fake parity and bad assumptions.
Better: normalize the task, then document the actual resolved arguments used per model.

❌ **Anti-pattern: waiting until the end to think about spend**
Why bad: expensive comparison batches get hard to control.
Better: estimate before the run and reconcile after the run.

## References

- Platform notes: `references/fal-platform-notes.md`
- Queue and inference notes: `references/fal-queue-and-inference.md`
- Initial video model notes: `references/fal-video-models.md`
- Model presets: `assets/model-presets.json`

## Remember

A good fal workflow is not just “can it generate.” It is:

- reproducible
- comparable
- cost-visible
- honest about model differences
