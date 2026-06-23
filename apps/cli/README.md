# vibedgames (CLI)

The `vg` CLI is designed to be driven by a coding agent, not a human. A human
prompts their agent ("build me a bomberman game"); the agent runs `vg` + the
bundled skills to scaffold, generate assets, add multiplayer, and deploy.
Machine-readable output (`--json`), deterministic exit codes, and self-describing
errors are first-class — optimised so an agent never gets stuck on friction a
human would tolerate.

## Install

```sh
npm i -g vibedgames
```

## Commands

```sh
vg new <slug>                    # scaffold a Phaser 4 + Vite + TS game (official template)
vg new <slug> --engine threejs   # scaffold a Three.js + Vite + TS starter
vg new <slug> --engine react-r3f # scaffold a React + R3F + drei + Vite + TS starter
vg new <slug> --engine none      # minimal Vite + TS + canvas (offline; inline)
vg new <slug> --template owner/repo  # any github degit spec
vg new <slug> --here             # scaffold into the current directory
vg init [dir]         # install Claude Code skills into ./.claude/skills
vg login              # authenticate via browser
vg logout             # clear credentials
vg whoami             # show current user
vg deploy [dir]       # deploy a game directory (reads vibedgames.json or --slug)

vg generate run <model> [params]   # run a generative model (waits for result)
vg generate models [query]        # search/list available models
vg generate schema <model>        # fetch a model's input/output schema
vg generate pricing <model>       # fetch pricing for a model
vg generate status <model> <id>   # check an async request
vg generate upload <file>         # upload an asset, get a URL
vg generate docs <query>          # search generative-model documentation
```

`vg skills install` is an alias for `vg init`. Most commands support `--json` for machine-readable output.

`vg generate` calls the `generate.forward` tRPC proc — the server holds the
provider API key, so generation works for any logged-in user with no local keys.

## Using with Claude Code

Run `vg init` in your project to drop the full set of game-building skills
(Phaser, Three.js, Aseprite, asset generation, deploy, etc.) into `./.claude/skills/`.
Claude picks them up automatically on next session.

## How deploy works

1. Walks the directory, hashes files, validates `index.html` exists
2. Calls `deploy.create` API — gets presigned R2 upload URLs
3. Uploads files to R2 with bounded concurrency
4. Calls `deploy.finalize` — game goes live at `{slug}.vibedgames.com`

## Auth

Uses a polling flow: CLI generates a code, opens the browser, polls until the user confirms. Token stored at `~/.config/vg/auth.json`.
