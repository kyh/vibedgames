# Changelog

## 0.4.0 — 2026-08-15

- **`vg playtest` — drive a real browser to prove a game actually plays.** Smoke checks, scripted bot playtests, softlock detection, canvas/WebGL determinism, screenshots and visual diffs, on top of `agent-browser`. Replaces the Playwright skill: the bot measures that the loop survived, input reaches the player, the objective is reachable and nothing wedged, and exits non-zero naming the check that failed.

- **`--field <path>` on every command that emits JSON** (`generate run/status/models/schema/pricing/docs/upload`, `credits`, `fork`). Prints one value from the result, bare, so `$(vg generate upload x.png --field url)` needs no JSON processor — `jq` is no longer a prerequisite for following the generate skill. Paths are dotted, accept `images[0]` or `images.0`, and count negative indices from the end; an unresolvable path exits non-zero instead of printing an empty line.
- Skill recipes that chained `vg generate run --json | jq -r '.audio.url'` now read `--field result.audio.url`. The old form was reading the wrong level: the CLI nests the model's output under `result`, so those examples returned nothing.
- `vg init` and `vg update` self-update with the package manager that installed the CLI — npm, pnpm, yarn or bun, detected from the install path — instead of always `npm install -g`. On a pnpm/bun/yarn install the old behaviour either failed outright or wrote a second copy into a different global prefix, so `vg --version` never moved. When the manager isn't on PATH, both now print the exact command to run.
- The tilemap editor is a browser UI (`asset_tilemap_editor.mjs --edit`) rather than a Tkinter window: same map format and keys, nothing to install. It serves one page over loopback behind a per-run token, and refuses to read or write outside the working directory.
- Skill scripts no longer need Python. The asset-pipeline, animated-spritesheets, pixel-snapper, aseprite and skill-creator skills run on `node` alone, against a bundled dependency-free `scripts/_lib/asset-tools.mjs`.
- **A misspelled option is an error, not a silent default.** The skill scripts used to accept any `--flag` and quietly ignore the ones they never read, so `pixel_snapper.mjs --k-colours 4` ran on the default palette and exited 0. Each script now declares its whole option surface and anything outside it exits 2 with `unrecognized arguments`, the way the Python originals did.
- `--help` and `-h` work on every skill script, printing what the script does. They were accepted and then ignored on all but one, so asking a script for help answered with whichever required argument was missing.
- Usage errors exit 2 and runtime failures exit 1 across the skill scripts, restoring the split the Python originals had.
- A corrupt PNG is refused rather than decoded into whatever the file implies: truncated pixel data used to produce an image nobody wrote, and a corrupt header could raise an allocation failure instead of a message.

## 0.3.1 — 2026-07-29

- **`vg deploy` no longer uploads a source archive by default.** The archive is readable by any logged-in user, so shipping it is a publish — it is now opt-in via `--source`. Deploys that relied on the old default stop being forkable; re-deploy with `--source` to restore it. `--no-source` still parses and is still a no-op against the new default.
- `vg` bin is now executable — `tsc` emitted `dist/index.js` at 0644 despite the shebang, so a linked/installed `vg` could fail with `permission denied`
- `tsbuildinfo` moved out of `dist/` to `.cache/` — it shipped inside the 0.3.0 tarball
- `vg init` docs corrected: it drives `npx skills add`, no longer writes `.claude/skills` directly
- per-user generation credit system behind `vg generate` / `vg credits`

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
