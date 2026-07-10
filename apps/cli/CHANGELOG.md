# Changelog

## 0.3.0 — 2026-07-09

- `vg factory` — the autonomous game factory as an optional plugin: installs the `@vibedgames/factory-<platform>` binary on first use and passes all args through (full TUI dashboard, claude/codex runners)
- `vg deploy` prefers `dist/` from a project root and warns on unbuilt roots (checks dist/build/out)
- `vg generate --provider codex` — delegate image generation to the Codex CLI; hardened codex output matching/failure handling
- dropped `vg keys` commands — API keys are provisioned via the web UI
- tightened error handling for revoke, whoami, and apikey index

## 0.2.0 — 2026-06-12

- `vg` auto-update — CLI checks for and applies newer published versions
- game-craft skill suite (gamedev canon: game-feel, level-design, vfx, balance, etc.)
- tRPC media router renamed to `generate` (matches `vg generate`)
- bundled example games rebuilt idiomatically, signature controls intact

## 0.1.0 — 2026-06-04

- **`vg media` is now `vg generate`** — the asset-generation surface (run/status/models/schema/pricing/docs/upload) moved under `vg generate`. Update any scripts/skills calling `vg media`.
- Model endpoint IDs are passed through verbatim (e.g. `fal-ai/flux/dev`); the CLI does no id rewriting.

## 0.0.6 — 2026-06-03

- Source archives now rewrite `workspace:`/`catalog:` dependency specs to the concrete installed versions (like `pnpm publish`), so a forked monorepo project — including the bundled example games — `npm install`s standalone. No-op for normal projects.

## 0.0.5 — 2026-06-03

- `vg deploy` now uploads a forkable **source archive** by default (tar.gz of the project root, respecting `.gitignore` + a hard exclude list that always drops `node_modules`, build output, and secrets like `.env*`/`*.key`/`id_*`). Use `--no-source` to skip.
- `vg fork <slug> [target]` — download another project's source, extract it, and re-slug it to build on top. `--json` for agents, `--force` to replace a target dir.

## 0.0.4 — 2026-06-03

- `vg new` scaffolder — pull an official engine template (phaser, threejs) or a minimal canvas starter
- one-command local DB setup + headless dev auth (`VG_TOKEN` overrides the saved login)
- `vg media` surface (run/status/models/schema/pricing/docs/upload) hardened: prints result URLs, exits non-zero on download failure, collision-safe `--download`, path-traversal + HTTPS guards on fal CDN, POSIX `--` terminator and `--key=value` argv support
- local R2 isolation so local deploys don't depend on prod bucket state
