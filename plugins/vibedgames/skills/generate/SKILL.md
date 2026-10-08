---
name: generate
description: "Run the `vg generate` CLI: search models, inspect schemas and pricing, run endpoints, upload inputs, track async jobs. The base every media skill here builds on."
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

> `vg generate` is a model-call surface only. Install/update the CLI with `npm install -g vibedgames`; skills live in this repo under `plugins/vibedgames/skills/` and sync via `pnpm dogfood`.

> **Images can run through your own Codex plan.** Opt in once with `vg config set generate.provider codex`: OpenAI image runs (`openai/gpt-image-*`) then go to the local `codex` CLI on the user's own Codex plan, with no vibedgames auth or credits, while every other endpoint (Flux, video, audio, 3D) stays on the vibedgames catalog. A run Codex can't serve (`--async`, a URL reference) uses vibedgames and says so on stderr. `--provider codex|vibedgames` decides a single run, and the literal endpoint `codex` always uses Codex. On the codex path: images only, synchronous, local reference files only, and output is saved straight to disk — read `downloaded_files[]` from the `--json` result (there are no URLs). If `codex` is missing the run exits non-zero; rerun with `--provider vibedgames`. Full contract (recognized inputs, JSON shape, failure semantics): [full-reference.md](references/full-reference.md#provider-codex-use-your-own-codex-plan-for-images).

## Credits

Every `vg generate run` debits the account's credit balance: an estimated hold at submit, corrected to the actual cost when the result is fetched. Failed or cancelled jobs are refunded automatically. New accounts start at $0.00 — credit is bought by card or added with a code.

- **Check balance:** `vg credits` (or `vg credits --json` for agents). `vg generate pricing <id> --json` estimates cost before running.
- **Add credit:** `vg credits redeem <CODE>` if the human gave you a code. Otherwise `vg credits buy <usd> --json` (whole dollars, 5–500) returns a checkout `url`: hand it to the human — paying takes a person at a browser — then re-check `vg credits --json` until `balance_micro` rises. Never open or pay it yourself.
- **If a submit fails with a FORBIDDEN error whose message starts with `insufficient_credits:`, STOP.** Retries cannot succeed — the balance is exhausted, and switching endpoints or re-queueing will fail the same way. Tell the human the balance and offer the two ways to add credit above (a code, or a `vg credits buy` link for them to pay); resume once `vg credits` shows a positive balance.
- **If a submit fails with a BAD_REQUEST error whose message starts with `unknown_endpoint:`, the endpoint id has no published price, so it cannot be billed or run.** Retrying the same id fails the same way. Check it with `vg generate models --endpoint_id <id> --json` (usually a typo or a retired id), or find another with `vg generate models "<task>" --json`.

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
REQ=$(vg generate run fal-ai/veo3.1 --prompt "a dog running" --async --field request_id)
vg generate status fal-ai/veo3.1 "$REQ" \
 --download "./out/{request_id}_{index}.{ext}" \
 --json
```

**If a job's outcome is ever ambiguous, recover — don't resubmit.**

- Capture `request_id` the moment a submit returns (`--field request_id`, or `request_id` in the `--json` result) and resume with `vg generate status <endpoint_id> <request_id>`.
- Never re-`run` after an ambiguous failure (connection lost, unclear response). Reconcile the request id or job history first; if none can be recovered, say so and get authorization before a potentially duplicate paid request.
- Retry only idempotent reads (`status`, `--download`) with backoff. A single transient error is not a completed recovery — exhausting bounded retries leaves the job pending, not permission to submit again.

### Upload then run

```bash
URL=$(vg generate upload ./photo.jpg --field url)
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
