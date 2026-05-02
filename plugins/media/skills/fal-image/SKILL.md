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

**Core principles**:
1. **Reference discipline matters**: editing runs should pass only the images the model actually needs; too many references dilute control.
2. **Prompt parity beats fake parity**: keep the task stable, then document the real model-specific compromises.
3. **Tracking is part of the run**: a generation is not complete until prompt, request metadata, outputs, and cost signals are recorded.

## How Image Calls Reach fal

This skill never calls the fal API directly for image generation. All
generation goes through the vibedgames CLI (`vg image generate` /
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

`x-fal-billable-units` and `request_id` are surfaced back to the caller
in the run JSON metadata (`vg image ... --json`).

Prerequisites:

- `vg` CLI installed (`npm i -g vibedgames`)
- `vg login` to authenticate

### Model Aliases

The CLI accepts these aliases (resolve via `vg models`):

- `nano-banana-2`, `nano-banana-2-edit`
- `nano-banana-pro`, `nano-banana-pro-edit`
- `grok-imagine-image`, `grok-imagine-image-edit`

Or pass a fully-qualified `provider:model` spec, e.g.
`fal:fal-ai/nano-banana-pro/edit`.

### Caveats

- Pre-run cost estimates and the `fal_platform_models.py` tooling are
  **not** routed through `vg`; they remain direct fal calls and require a
  `FAL_KEY`. They are maintainer-only and not needed for image runs.
- Outputs are downloaded to `--output` from short-lived presigned URLs the
  CLI fetches on the user's behalf.

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

## Calling vg image

### Generate

```bash
vg image generate \
  --model nano-banana-pro \
  --prompt "Side-view 16-bit pirate hero on a dock, flat green background #00FF00" \
  --output tmp/pirate \
  --filename-prefix pirate
```

### Edit

```bash
vg image edit \
  --model nano-banana-pro-edit \
  --image anchor.png \
  --prompt "Keep the same character. Pose: idle facing right." \
  --output tmp/edit
```

### Cross-model comparison (replaces the experiment matrix)

`--model` accepts a comma-separated list of aliases or `provider:model`
specs, and `-n` repeats each model. The CLI fans jobs out in parallel
(`-p` controls concurrency) and emits a structured JSON result with
per-run `runId` and `metadata`:

```bash
vg image generate \
  --model nano-banana-pro,nano-banana-2,grok-imagine-image,openai:gpt-image-1.5 \
  --prompt "Side-view 16-bit pirate hero, flat green background #00FF00" \
  --output experiments/fal-image/pirate-compare \
  --filename-prefix pirate \
  -n 2 -p 4 \
  --json > experiments/fal-image/pirate-compare/runs.json
```

For edits across multiple endpoints, pass the same `--image` to each:

```bash
vg image edit \
  --model nano-banana-pro-edit,nano-banana-2-edit,grok-imagine-image-edit \
  --image anchor.png \
  --prompt "Same character. Pose: walking right." \
  --output experiments/fal-image/walk-compare \
  --json > experiments/fal-image/walk-compare/runs.json
```

### Per-model params

Pass arbitrary endpoint-specific params with `--params` (JSON) or
`--params-file` (path). `--params-file` is the right choice when params
contain large fields like base64 references:

```bash
vg image edit --model nano-banana-pro-edit \
  --image anchor.png --prompt "..." --output tmp/edit \
  --params '{"image_size":{"width":1024,"height":1024},"num_images":2}'
```

## Repo Workflow

Machine-readable tracking:

- `experiments/fal-image/<timestamp>-<slug>/runs.json` — the `--json`
  fan-out output (per-run `runId`, `metadata`, file paths)
- per-run images written by `vg image` directly into the run output
  directory

Human-readable tracking:

- `prompts/<timestamp>-...-prompts.md`
- `learnings/<timestamp>-...-learnings.md`

Generated images should still live under the appropriate `public/assets/.../concepts/...` path for the asset family being tested.

## Maintainer Tooling

`scripts/fal_platform_models.py` is **maintainer-only** and queries
fal's platform APIs (model lookup, pricing, estimates, usage, request
audit). It requires a direct `FAL_KEY` and is not part of the
user-facing image flow. End users should not need it.

## Anti-Patterns To Avoid

❌ **Anti-pattern: flattening all image models into one fake prompt schema**
Why bad: you hide the controls that actually affect quality and cost.
Better: pass shared `--prompt` and `--image` arguments, but drop per-model knobs through `--params`.

❌ **Anti-pattern: treating edit and generate as the same task**
Why bad: edit runs depend on reference discipline and preservation constraints that text-to-image runs do not.
Better: keep separate `vg image generate` and `vg image edit` invocations and prompt each task as itself.

❌ **Anti-pattern: recording only prompts and final PNGs**
Why bad: you cannot audit request IDs, retries, or cost later.
Better: pipe `vg image ... --json` to a runs file alongside the outputs.

❌ **Anti-pattern: comparing models with hidden fallback routing**
Why bad: you may think you tested one endpoint but actually hit another route.
Better: the proxy already sets `x-app-fal-disable-fallback: true`; verify the target route via `metadata.endpoint_id` (and `metadata.request_id`) in the JSON output. `runId` is a server-side UUID for the run record and won't tell you which fal endpoint actually served the request.

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
- CLI command reference: `vg image --help`, `vg models`

## Remember

A good fal image workflow is not just "can it render." It is:

- reproducible (capture `--json` runs)
- comparable (run the same prompt across multiple `--model` entries)
- cost-visible (read `metadata.timings` / billable units from the JSON)
- honest about model differences
