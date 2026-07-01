---
name: generate
description: >
  Use the `vg generate` CLI to search, inspect, run, and manage 1200+ generative
  model endpoints. Trigger when the user asks to "generate an image", "make a
  video", "search models", "run a model", "fetch schema", "check pricing",
  "upload an asset", "queue async job", "track request", or any direct
  interaction with the model endpoint catalog. This is the foundational skill.
  Every other media skill in this repo executes its work through `vg generate`
  commands. Use `--json` whenever the output will be parsed by an agent.
---

# vg generate: model endpoint runner

`vg generate` is the agent-first CLI for generating images, video, and audio. It works in a terminal for humans (pretty output) and equally well for agents (structured JSON when piped or with `--json`). All other skills in this repo call `vg generate` for execution; they do not wrap any model HTTP API directly. Every call is forwarded through a single vibedgames server proc that attaches the credentials and proxies the request.

> **Vibedgames runtime.** Install with `npm install -g vibedgames` (or `pnpm dogfood` in this repo). The vibedgames server holds the API key, so there is no per-machine setup. The CLI exposes `run`, `status`, `models`, `schema`, `upload`, `pricing`, and `docs` — the read/write surface that maps to the queue, platform, storage, and docs APIs.

For the full command surface (every flag, every option, every example), see [references/full-reference.md](references/full-reference.md). For setup details, see the [Setup](#setup) section below.

## Critical rules

1. **Always use `--json` when an agent will read the output.** Pretty mode is for humans only.
2. **Never invent endpoint IDs.** Use `vg generate models "<query>"` to discover, `vg generate models --endpoint_id <id>` to verify.
3. **Inspect schema before running.** `vg generate schema <endpoint_id> --json` shows the exact field names. Guessed flags fail with 422.
4. **Save files with `--download`, not curl.** The CLI handles authentication, naming, and file format detection.
5. **Use `--async` for long-running generation.** Image work usually completes inline; video/audio/3D usually need queue + status polling.

## Command index

| Command                                           | Purpose                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `vg generate models <query>`                      | Search the catalog (or `--category`, or `--endpoint_id`)      |
| `vg generate schema <endpoint_id>`                | Inspect inputs/outputs (compact or `--format openapi`)        |
| `vg generate run <endpoint_id> --<param> <value>` | Execute a model                                               |
| `vg generate status <endpoint_id> <request_id>`   | Poll an async job (with `--result`, `--cancel`, `--download`) |
| `vg generate upload <path>`                       | Upload a local file (returns a URL usable as a model input)   |
| `vg generate pricing <endpoint_id>`               | Check cost per call                                           |
| `vg generate docs <query>`                        | Search generative-model documentation                         |

> `vg generate` is a model-call surface only. Install/update the CLI with `npm install -g vibedgames`; skills live in this repo under `plugins/generate/skills/` and sync via `pnpm dogfood`.

> **Own a Codex plan with image generation?** Add `--provider codex` to `vg generate run` (or set `VG_GENERATE_PROVIDER=codex`) to generate **images** through your local `codex` CLI instead of the vibedgames catalog — nothing hits the vibedgames backend, and it needs no vibedgames auth (`vg login`/`VG_TOKEN` not required; only your signed-in Codex plan). Constraints an agent must respect: images only (no video/audio/3D — use the default provider), synchronous (no `--async`), and output is saved straight to disk — read `downloaded_files[]` from the `--json` result (there are no URLs). Requires the `codex` CLI on `PATH` and a signed-in Codex plan; if it's missing the command exits non-zero, so fall back to the default provider. Full contract (recognized inputs, JSON shape, failure semantics): [full-reference.md](references/full-reference.md#provider-codex-use-your-own-codex-plan-for-images).

## Standard workflow

The canonical genmedia loop that every domain skill (character-design, cinematography, storytelling, …) runs:

1. **Resolve the endpoint.** Verify a known ID with `vg generate models --endpoint_id <id> --json`; fall back to `vg generate models "<task>" --json` / `vg generate docs "<topic>" --json` only when no routed endpoint covers the role.
2. **Inspect before running.** `vg generate schema <id> --json` for exact fields, `vg generate pricing <id> --json` when cost matters. Use only schema-supported fields (seed, reference image, image strength, negative prompt) and record what you used.
3. **Upload references** with `vg generate upload <path> --json`; reuse the returned URL.
4. **Run.** Stills usually complete inline; video/audio/3D need `--async` then `vg generate status <id> <request_id> --json` to poll.
5. **Download** via `--download "./outputs/<dir>/{request_id}_{index}.{ext}"`, reading paths from `downloaded_files[]` — never curl URLs.

## Quick patterns

### Run a model and download the result

```bash
vg generate run fal-ai/flux/dev \
 --prompt "a cat on the moon" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Async + poll

```bash
SUBMIT=$(vg generate run fal-ai/veo3.1 --prompt "a dog running" --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')
vg generate status fal-ai/veo3.1 "$REQ" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Upload then run

```bash
URL=$(vg generate upload ./photo.jpg --json | jq -r '.url')
vg generate run fal-ai/nano-banana-pro/edit \
 --image_urls "$URL" \
 --prompt "make the sky stormy" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

### Discover when the user names a fuzzy task

```bash
vg generate models "background removal product image" --json
vg generate models --category text-to-video --limit 5 --json
vg generate docs "webhook callbacks" --json
```

## Setup

```bash
npm install -g vibedgames # global install
vg --help                 # confirm the CLI is on PATH
```

In this repo, run `pnpm dogfood` instead — it links the local CLI build and syncs `.claude/skills/`. The vibedgames server holds the API key, so there is no per-machine API-key step. See [full-reference.md](references/full-reference.md) for output modes and JSON conventions.

**Auth is just-in-time — don't log in at install.** `vg generate` proxies through the vibedgames backend (which attaches the credentials), so it needs a session. Run a `vg generate` command unauthenticated and the CLI stops with `Not logged in. Run vg login` (device-code flow); for headless/agent use set `VG_TOKEN` instead. Nothing needs authenticating until you actually generate. (The `--provider codex` path is the exception — it runs locally and needs no vibedgames auth at all.)
