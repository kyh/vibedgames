# Changelog

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
