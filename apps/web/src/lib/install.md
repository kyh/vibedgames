# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the step below.

## Install skills and the CLI

```
npx vibedgames init
```

One command does two things:

1. Installs skills for Claude Code, Cursor, and Codex — wraps `npx
   skills add kyh/vibedgames` from
   [vercel-labs/skills](https://github.com/vercel-labs/skills). Skills
   live once in `./.agents/skills/` and are symlinked into
   `.claude/skills/`, `.cursor/skills/`, and `.codex/skills/`. Windows
   without symlink support falls back to copies.
2. Tries to globally install the `vibedgames` npm package so `vg` is on
   PATH for subsequent commands (`vg deploy`, `vg login`, `vg whoami`).
   This step can fail on systems where global `npm install` needs sudo
   — init will warn but won't abort. If `vg` isn't on PATH afterward,
   fall back to `npx vibedgames <cmd>` or tell the user to run
   `npm install -g vibedgames` (or `sudo npm install -g vibedgames`).

If you're a different agent, pass `--agent <name>` (supports 45+ agents
— see vercel-labs/skills).

## You're done

The skills you just installed tell you how to handle prompts like *"add
multiplayer"*, *"generate pixel art for the player"*, or *"deploy this
game"*. The `deploy` skill will prompt the user to authenticate
(`vg login`, device-code flow) the first time they ship something — no
need to log in now.

Docs: https://vibedgames.com/docs
