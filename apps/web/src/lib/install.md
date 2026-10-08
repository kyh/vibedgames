# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the step below.

## Install skills and the CLI

```
npx vibedgames init
```

One command does two things:

1. Installs the skills for Claude Code, Cursor, and Codex from
   [kyh/vibedgames-plugins](https://github.com/kyh/vibedgames-plugins).
   Skills live once in `./.agents/skills/`, which Cursor and Codex read
   directly, and are symlinked into `.claude/skills/` for Claude Code.
   Windows without symlink support falls back to copies.
2. Tries to globally install the `vibedgames` npm package so `vg` is on
   PATH for subsequent commands (`vg deploy`, `vg login`, `vg whoami`).
   This step can fail on systems where global `npm install` needs sudo
   — init will warn but won't abort. If `vg` isn't on PATH afterward,
   fall back to `npx vibedgames <cmd>` or tell the user to run
   `npm install -g vibedgames` (or `sudo npm install -g vibedgames`).

If you're a different agent, pass `--agent <name>` (`vg init --help`
lists the supported ones). Any agent that reads `.agents/skills/` works
with the default install.

## You're done

The skills you just installed tell you how to handle prompts like _"add
multiplayer"_, _"generate pixel art for the player"_, or _"deploy this
game"_. The `deploy` skill will prompt the user to authenticate
(`vg login`, device-code flow) the first time they ship something — no
need to log in now.

Docs: https://vibedgames.com/docs — the full CLI, API and package
reference. https://vibedgames.com/llms.txt says when to reach for
vibedgames and what to run first. Every page on the apex domain also
answers `Accept: text/markdown`.
