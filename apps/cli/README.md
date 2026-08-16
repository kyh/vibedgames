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
vg init [--global] [--agents …]  # install/update the vibedgames skills + CLI
vg update                        # update the CLI and installed skills to latest
vg login              # authenticate via browser
vg logout             # clear credentials
vg whoami             # show current user
vg deploy [dir]       # deploy a game directory (reads vibedgames.json or --slug)
vg fork <slug> [target]  # fork a project's shipped source under a new slug
vg credits            # credit balance + recent usage
vg factory [args…]    # autonomous game agent (optional plugin, installs on first use)
vg completions <bash|zsh|fish>   # print shell completions

vg generate run <model> [params]   # run a generative model (waits for result)
vg generate models [query]        # search/list available models
vg generate schema <model>        # fetch a model's input/output schema
vg generate pricing <model>       # fetch pricing for a model
vg generate status <model> <id>   # check an async request (--result, --cancel)
vg generate upload <file>         # upload an asset, get a URL
vg generate docs <query>          # search generative-model documentation
```

Most commands support `--json` for machine-readable output, and `--field <path>`
to print one value out of it — `vg generate upload x.png --field url` prints the
bare URL, ready for `$(...)` capture, so no JSON processor is needed. The path is
dotted, takes `images[0]` or `images.0`, and counts negative indices from the
end; a path that doesn't resolve is an error rather than an empty line.

`vg init` shells out to `npx skills add kyh/vibedgames` and installs for Claude
Code, Cursor and Codex by default (symlinked from a shared `.agents/skills/`);
`--agents` narrows or widens that, `--global` targets the user directory instead
of the project. `vg update` runs automatically once a day — disable with
`VG_NO_AUTO_UPDATE=1`.

Both self-update with whichever package manager installed the CLI, detected
from its install path (npm, pnpm, yarn or bun) — installing with a different
one would write a second copy into a prefix your shell may not be looking at.
If that manager isn't on PATH, the CLI prints the exact command to run instead
of failing with a bare exit code.

`vg factory` is a pure passthrough to the [factory](../factory) binary, which is
installed as a platform-specific optional package on first use — the CLI itself
carries none of it.

`vg generate` calls the `generate.forward` tRPC proc — the server holds the
provider API key, so generation works for any logged-in user with no local keys.

## Using with a coding agent

Run `vg init` in your project to install the full set of game-building skills
(design, Phaser, Three.js, asset generation, multiplayer, deploy — see
[`plugins/`](../../plugins)). The agent picks them up on its next session.

## How deploy works

1. Picks the build output (`dist`/`build`/`out`) when the directory is a project root
2. Walks the directory, hashes files, validates `index.html` exists
3. Calls `deploy.create` API — gets presigned R2 upload URLs
4. Uploads files to R2 with bounded concurrency
5. Calls `deploy.finalize` — game goes live at `{slug}.vibedgames.com`

Passing `--source` also uploads a forkable source archive, which is what
`vg fork <slug>` downloads. It is off by default: the archive is readable by
any logged-in user, so shipping it is a publish and should be a deliberate act.

## Auth

Uses a device-code polling flow: CLI generates a 6-char code, opens the browser,
polls until the user confirms. Token stored at `~/.config/vg/auth.json`.
`VG_TOKEN` overrides it (for CI and headless agents) and `VG_API_URL` points the
CLI at a non-production API.
