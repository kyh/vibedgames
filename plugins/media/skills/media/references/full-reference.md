# vg media: Full CLI Reference

Complete command surface. SKILL.md has the trigger surface and quick patterns; this file is the manual.

## Install

```bash
npm install -g vibedgames
```

In this repo, `pnpm dogfood` links a local build of `vg`. The vibedgames server holds the API key, so there is no per-machine API-key configuration step.

## models: search and inspect

```bash
vg media models "text to video"
vg media models "flux" --category text-to-image
vg media models --category text-to-speech --limit 5
vg media models --status all # include deprecated
vg media models --endpoint_id flux/dev,flux/schnell # specific models
vg media models --endpoint_id flux/dev --expand openapi-3.0
vg media models "flux" --cursor <token> # pagination
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
vg media schema flux/dev
vg media schema flux/dev --format openapi
```

| Option     | Description                                          |
| ---------- | ---------------------------------------------------- |
| `--format` | `compact` (default) or `openapi` (full OpenAPI JSON) |

Always run `schema` before `run` for an unfamiliar endpoint. The exact field names matter, guessed flags fail with 422.

## run: execute a model

```bash
vg media run flux/dev --prompt "a cat on the moon"
vg media run flux/dev --prompt "a cat" --num_images 2
vg media run flux/dev --prompt "a cat" --logs
vg media run veo3.1 --prompt "a dog running" --async
vg media run flux/dev --prompt "a cat" --download
vg media run flux/dev --prompt "a cat" --num_images 3 \
 --download "./out/{index}.{ext}"
vg media run flux/dev --help # introspect parameters as CLI flags
```

Any model input parameter can be passed as `--<param> <value>`. Run `vg media run <endpoint_id> --help` to see a model's accepted parameters as CLI flags, or `vg media schema <endpoint_id>` for the same as JSON.

| Option                  | Description                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--<param>`             | Any model input parameter                                                                                                                                                                                                                                                                                                                   |
| `--logs`                | Stream logs while the model runs (pretty mode only)                                                                                                                                                                                                                                                                                         |
| `--async`               | Submit to queue without waiting, returns a `request_id`                                                                                                                                                                                                                                                                                     |
| `--download [template]` | Save every media URL in the result. Optional template uses `{index}`, `{name}`, `{ext}`, `{request_id}` placeholders. Omitted → cwd with source file names. Trailing `/` or existing dir → dir + source names. Plain filename + multiple outputs → `_1`, `_2` collision suffixes. Downloaded paths appear under `downloaded_files` in JSON. |

## status: async job

```bash
vg media status veo3.1 <request_id>
vg media status veo3.1 <request_id> --result
vg media status veo3.1 <request_id> --logs
vg media status veo3.1 <request_id> --cancel
vg media status veo3.1 <request_id> --download ./out/ # implies --result
```

| Option                  | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `--result`              | Fetch the completed result                            |
| `--logs`                | Show logs verbosely                                   |
| `--cancel`              | Cancel the queued job                                 |
| `--download [template]` | Same template syntax as on `run`. Implies `--result`. |

## upload: file to hosted CDN

```bash
vg media upload ./photo.jpg
vg media upload https://example.com/image.png
```

Accepts a local path or a remote URL. Returns a CDN URL usable as model input.

## pricing: cost per call

```bash
vg media pricing flux/dev
```

Use before running an unfamiliar premium endpoint. Some endpoints (GPT Image 2 at `quality=high`, Seedance Pro at long durations) are an order of magnitude more expensive than alternatives.

## docs: documentation search

```bash
vg media docs "how to use LoRA"
vg media docs "webhook callbacks"
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
vg media run flux/dev --prompt "a cat" --json
vg media models "text to video" --json | jq '.models[]'
```

For a machine-readable description of every command, argument, and option:

```bash
vg media --help --json
```

Useful when bootstrapping an agent's context with the full CLI surface.

## Common patterns

### Run + download in one go

```bash
vg media run flux/dev \
 --prompt "..." \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Async submission, then poll until done

```bash
SUBMIT=$(vg media run <endpoint_id> --prompt "..." --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')

# Poll until status is COMPLETED
while true; do
 RES=$(vg media status <endpoint_id> "$REQ" --json)
 STATUS=$(echo "$RES" | jq -r '.status')
 [ "$STATUS" = "COMPLETED" ] && break
 [ "$STATUS" = "FAILED" ] && { echo "$RES" | jq '.error'; exit 1; }
 sleep 5
done

vg media status <endpoint_id> "$REQ" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Upload then reference

```bash
URL=$(vg media upload ./input.png --json | jq -r '.url')
vg media run nano-banana-pro/edit \
 --image_urls "$URL" \
 --prompt "..." \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Inspect before run (always)

```bash
vg media schema <endpoint_id> --json
vg media pricing <endpoint_id> --json
```

## Errors

| Symptom                    | Likely cause                                            | Fix                                                                                |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `422 Unprocessable Entity` | Wrong field name or missing required field              | `vg media schema <endpoint_id> --json` and read `validation_errors`                |
| `401 Unauthorized`         | The vibedgames server is missing its generation API key | The platform operator must configure the server credentials and redeploy / restart |
| `Endpoint not found`       | Wrong endpoint ID, deprecated, or typo                  | `vg media models "<task>" --json` to discover                                      |
| Slow / timeout             | Long-running generation                                 | Use `--async`, then `vg media status … --result`                                   |

## Environment

The CLI itself takes no required env vars — it talks to the vibedgames proxy, which holds the generation credentials server-side. Override the proxy URL with `VIBEDGAMES_API_URL` if pointing at a non-default deployment.
