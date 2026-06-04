---
name: media
description: >
  Use the `vg media` CLI to search, inspect, run, and manage 1200+ generative
  model endpoints. Trigger when the user asks to "generate an image", "make a
  video", "search models", "run a model", "fetch schema", "check pricing",
  "upload an asset", "queue async job", "track request", or any direct
  interaction with the model endpoint catalog. This is the foundational skill.
  Every other media skill in this repo executes its work through `vg media`
  commands. Use `--json` whenever the output will be parsed by an agent.
---

# vg media: model endpoint runner

`vg media` is the agent-first CLI for generating images, video, and audio. It works in a terminal for humans (pretty output) and equally well for agents (structured JSON when piped or with `--json`). All other skills in this repo call `vg media` for execution; they do not wrap any model HTTP API directly. Every call is forwarded through a single vibedgames server proc that attaches the credentials and proxies the request.

> **Vibedgames runtime.** Install with `npm install -g vibedgames` (or `pnpm dogfood` in this repo). The vibedgames server holds the API key, so there is no per-machine setup. The CLI exposes `run`, `status`, `models`, `schema`, `upload`, `pricing`, and `docs` — the read/write surface that maps to the queue, platform, storage, and docs APIs.

For the full command surface (every flag, every option, every example), see [references/full-reference.md](references/full-reference.md). For setup details, see the [Setup](#setup) section below.

## Critical rules

1. **Always use `--json` when an agent will read the output.** Pretty mode is for humans only.
2. **Never invent endpoint IDs.** Use `vg media models "<query>"` to discover, `vg media models --endpoint_id <id>` to verify.
3. **Inspect schema before running.** `vg media schema <endpoint_id> --json` shows the exact field names. Guessed flags fail with 422.
4. **Save files with `--download`, not curl.** The CLI handles authentication, naming, and file format detection.
5. **Use `--async` for long-running generation.** Image work usually completes inline; video/audio/3D usually need queue + status polling.

## Command index

| Command                                        | Purpose                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `vg media models <query>`                      | Search the catalog (or `--category`, or `--endpoint_id`)      |
| `vg media schema <endpoint_id>`                | Inspect inputs/outputs (compact or `--format openapi`)        |
| `vg media run <endpoint_id> --<param> <value>` | Execute a model                                               |
| `vg media status <endpoint_id> <request_id>`   | Poll an async job (with `--result`, `--cancel`, `--download`) |
| `vg media upload <path>`                       | Upload a local file (returns a URL usable as a model input)   |
| `vg media pricing <endpoint_id>`               | Check cost per call                                           |
| `vg media docs <query>`                        | Search generative-model documentation                         |

> `vg media` is a model-call surface only. Install/update the CLI with `npm install -g vibedgames`; skills live in this repo under `plugins/media/skills/` and sync via `pnpm dogfood`.

## Quick patterns

### Run a model and download the result

```bash
vg media run flux/dev \
 --prompt "a cat on the moon" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Async + poll

```bash
SUBMIT=$(vg media run veo3.1 --prompt "a dog running" --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')
vg media status veo3.1 "$REQ" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Upload then run

```bash
URL=$(vg media upload ./photo.jpg --json | jq -r '.url')
vg media run nano-banana-pro/edit \
 --image_urls "$URL" \
 --prompt "make the sky stormy" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Discover when the user names a fuzzy task

```bash
vg media models "background removal product image" --json
vg media models --category text-to-video --limit 5 --json
vg media docs "webhook callbacks" --json
```

## Setup

```bash
npm install -g vibedgames # global install
vg --help                 # confirm the CLI is on PATH
```

In this repo, run `pnpm dogfood` instead — it links the local CLI build and syncs `.claude/skills/`. The vibedgames server holds the API key, so there is no per-machine API-key step. See [full-reference.md](references/full-reference.md) for output modes and JSON conventions.
