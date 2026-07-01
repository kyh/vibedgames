# vg generate: Full CLI Reference

Complete command surface. SKILL.md has the trigger surface and quick patterns; this file is the manual.

## Install

```bash
npm install -g vibedgames
```

In this repo, `pnpm dogfood` links a local build of `vg`. The vibedgames server holds the API key, so there is no per-machine API-key configuration step.

## models: search and inspect

```bash
vg generate models "text to video"
vg generate models "flux" --category text-to-image
vg generate models --category text-to-speech --limit 5
vg generate models --status all # include deprecated
vg generate models --endpoint_id fal-ai/flux/dev,fal-ai/flux/schnell # specific models
vg generate models --endpoint_id fal-ai/flux/dev --expand openapi-3.0
vg generate models "flux" --cursor <token> # pagination
```

| Option          | Description                                               |
| --------------- | --------------------------------------------------------- |
| `--category`    | `text-to-image`, `image-to-video`, `text-to-speech`, etc. |
| `--status`      | `active` (default), `deprecated`, `all`                   |
| `--limit`       | Max results (default 20)                                  |
| `--cursor`      | Pagination token from a previous response                 |
| `--endpoint_id` | Fetch specific model(s), comma-separated or repeated      |
| `--expand`      | `openapi-3.0`, `enterprise_status`                        |

## schema: inspect inputs/outputs

```bash
vg generate schema fal-ai/flux/dev
vg generate schema fal-ai/flux/dev --format openapi
```

| Option     | Description                                          |
| ---------- | ---------------------------------------------------- |
| `--format` | `compact` (default) or `openapi` (full OpenAPI JSON) |

Always run `schema` before `run` for an unfamiliar endpoint. The exact field names matter, guessed flags fail with 422.

## run: execute a model

```bash
vg generate run fal-ai/flux/dev --prompt "a cat on the moon"
vg generate run fal-ai/flux/dev --prompt "a cat" --num_images 2
vg generate run fal-ai/flux/dev --prompt "a cat" --logs
vg generate run fal-ai/veo3.1 --prompt "a dog running" --async
vg generate run fal-ai/flux/dev --prompt "a cat" --download
vg generate run fal-ai/flux/dev --prompt "a cat" --num_images 3 \
 --download "./out/{index}.{ext}"
vg generate run fal-ai/flux/dev --help # introspect parameters as CLI flags
```

Any model input parameter can be passed as `--<param> <value>`. Run `vg generate run <endpoint_id> --help` to see a model's accepted parameters as CLI flags, or `vg generate schema <endpoint_id>` for the same as JSON.

| Option                  | Description                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--<param>`             | Any model input parameter                                                                                                                                                                                                                                                                                                                   |
| `--logs`                | Stream logs while the model runs (pretty mode only)                                                                                                                                                                                                                                                                                         |
| `--async`               | Submit to queue without waiting, returns a `request_id`                                                                                                                                                                                                                                                                                     |
| `--provider <name>`     | Execution backend. `vibedgames` (default) runs the model catalog. `codex` delegates **image generation** to a locally-installed Codex CLI (see below). Also settable via `VG_GENERATE_PROVIDER`.                                                                                                                                             |
| `--download [template]` | Save every media URL in the result. Optional template uses `{index}`, `{name}`, `{ext}`, `{request_id}` placeholders. Omitted → cwd with source file names. Trailing `/` or existing dir → dir + source names. Plain filename + multiple outputs → `_1`, `_2` collision suffixes. Downloaded paths appear under `downloaded_files` in JSON. |

### Provider: codex (use your own Codex plan for images)

If you have a Codex plan that includes image generation, `--provider codex` generates images locally through the `codex` CLI instead of the vibedgames catalog — nothing hits the vibedgames backend.

```bash
# Text-to-image via your Codex plan. The endpoint_id is required by the
# command but ignored for codex (Codex uses its own built-in image model).
vg generate run codex --provider codex --prompt "a fox in a hat" --json

# Multiple images + a download template (same {index}/{ext}/{request_id} syntax).
vg generate run codex --provider codex --prompt "a fox" --num_images 2 \
  --download "./out/{request_id}_{index}.{ext}" --json

# Image edit: pass a LOCAL file path as the reference (no upload needed).
vg generate run codex --provider codex --image_url ./cat.png \
  --prompt "make the sky stormy" --download ./out/ --json

# Set it globally so skills that call `vg generate run` route to Codex.
export VG_GENERATE_PROVIDER=codex
```

Notes:

- **Requirements:** the `codex` CLI on `PATH` (`npm install -g @openai/codex`) and a signed-in Codex plan with image generation (`codex login`). Point `VG_CODEX_BIN` at a specific binary if it isn't on `PATH`.
- **Images only.** Codex has no video/audio/3D generation; use the default provider for those.
- **Always synchronous.** `--async` is rejected — Codex writes files directly, so there is no queue or `request_id` to poll.
- Recognized inputs: `--prompt` (required), `--num_images` (1–8), size hints (`--image_size` / `--aspect_ratio` / `--width` + `--height`), and local reference files (`--image_url` / `--image_urls`). Other model params are ignored.
- Output always lands on disk (there are no remote URLs). Without `--download`, files are written to the cwd as `codex-image-<request_id>-<index>.png`; paths appear under `downloaded_files` in JSON.

**JSON output shape** (agents: read `downloaded_files` for the on-disk paths — there are no URLs to fetch):

```jsonc
{
  "status": "completed",
  "provider": "codex", // present only on the codex path; absent for vibedgames
  "endpoint_id": "codex", // echoes the positional arg; not meaningful for codex
  "request_id": "8455b74a", // locally-generated id (not a queue id — cannot be polled)
  "result": { "provider": "codex", "prompt": "<expanded prompt>", "images": [{ "path": "…png" }] },
  "downloaded_files": ["/abs/out/8455b74a.png"], // ← the deliverable
  "download_failures": [{ "url": "<source path>", "error": "…" }] // only if a copy failed
}
```

**Failure semantics** (deterministic, for agent control flow):

- Success → exit `0`, `downloaded_files` non-empty.
- `codex` not on `PATH`, exec non-zero, or zero images produced → the command throws and exits **non-zero**; the message on stderr says which (missing binary / declined request / no image access). Fall back to the default provider or surface the message.
- Every copy failed → exit `1` with `download_failures` populated and `downloaded_files` empty.

## status: async job

```bash
vg generate status fal-ai/veo3.1 <request_id>
vg generate status fal-ai/veo3.1 <request_id> --result
vg generate status fal-ai/veo3.1 <request_id> --logs
vg generate status fal-ai/veo3.1 <request_id> --cancel
vg generate status fal-ai/veo3.1 <request_id> --download ./out/ # implies --result
```

| Option                  | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `--result`              | Fetch the completed result                            |
| `--logs`                | Show logs verbosely                                   |
| `--cancel`              | Cancel the queued job                                 |
| `--download [template]` | Same template syntax as on `run`. Implies `--result`. |

## upload: file to hosted CDN

```bash
vg generate upload ./photo.jpg
vg generate upload https://example.com/image.png
```

Accepts a local path or a remote URL. Returns a CDN URL usable as model input.

## pricing: cost per call

```bash
vg generate pricing fal-ai/flux/dev
```

Use before running an unfamiliar premium endpoint. Some endpoints (GPT Image 2 at `quality=high`, Seedance Pro at long durations) are an order of magnitude more expensive than alternatives.

## docs: documentation search

```bash
vg generate docs "how to use LoRA"
vg generate docs "webhook callbacks"
```

Searches generative-model documentation, guides, and API references.

## Updating

```bash
npm install -g vibedgames@latest
```

Inside this repo, `pnpm dogfood` rebuilds and re-links the local CLI.

## Skills

Skills live in this repo under `plugins/*/skills/` and are symlinked into `.claude/skills/` by `pnpm dogfood`. Add or remove a skill, re-run `pnpm dogfood`, and commit the resulting symlink change.

## Agent-first design

All commands emit structured JSON when piped or called with `--json`:

```bash
vg generate run fal-ai/flux/dev --prompt "a cat" --json
vg generate models "text to video" --json | jq '.models[]'
```

For a machine-readable description of every command, argument, and option:

```bash
vg generate --help --json
```

Useful when bootstrapping an agent's context with the full CLI surface.

## Common patterns

### Run + download in one go

```bash
vg generate run fal-ai/flux/dev \
 --prompt "..." \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Async submission, then poll until done

```bash
SUBMIT=$(vg generate run <endpoint_id> --prompt "..." --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')

# Poll until status is COMPLETED
while true; do
 RES=$(vg generate status <endpoint_id> "$REQ" --json)
 STATUS=$(echo "$RES" | jq -r '.status')
 [ "$STATUS" = "COMPLETED" ] && break
 [ "$STATUS" = "FAILED" ] && { echo "$RES" | jq '.error'; exit 1; }
 sleep 5
done

vg generate status <endpoint_id> "$REQ" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Upload then reference

```bash
URL=$(vg generate upload ./input.png --json | jq -r '.url')
vg generate run fal-ai/nano-banana-pro/edit \
 --image_urls "$URL" \
 --prompt "..." \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Inspect before run (always)

```bash
vg generate schema <endpoint_id> --json
vg generate pricing <endpoint_id> --json
```

## Errors

| Symptom                    | Likely cause                                            | Fix                                                                                |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `422 Unprocessable Entity` | Wrong field name or missing required field              | `vg generate schema <endpoint_id> --json` and read `validation_errors`             |
| `401 Unauthorized`         | The vibedgames server is missing its generation API key | The platform operator must configure the server credentials and redeploy / restart |
| `Endpoint not found`       | Wrong endpoint ID, deprecated, or typo                  | `vg generate models "<task>" --json` to discover                                   |
| Slow / timeout             | Long-running generation                                 | Use `--async`, then `vg generate status … --result`                                |

## Environment

The CLI itself takes no required env vars — it talks to the vibedgames proxy, which holds the generation credentials server-side. Override the proxy URL with `VIBEDGAMES_API_URL` if pointing at a non-default deployment.

| Env var                | Effect                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `VG_GENERATE_PROVIDER` | Default execution backend for `vg generate run` (`vibedgames` or `codex`). The `--provider` flag wins over it. |
| `VG_CODEX_BIN`         | Path to the `codex` binary when using `--provider codex` and `codex` isn't on `PATH` (default `codex`). |
