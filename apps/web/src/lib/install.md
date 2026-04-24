# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the step below.

## Install skills

```
npx vibedgames init
```

Installs skills for Claude Code, Cursor, and Codex in one shot. Under
the hood this wraps `npx skills add kyh/vibedgames` from
[vercel-labs/skills](https://github.com/vercel-labs/skills): the skills
live once in `./.agents/skills/` and are symlinked into `.claude/skills/`,
`.cursor/skills/`, and `.codex/skills/`. Windows without symlink support
falls back to copies.

If you're a different agent, pass `--agent <name>` (supports 45+ agents
— see vercel-labs/skills).

## You're done

The skills you just installed tell you how to handle prompts like *"add
multiplayer"*, *"generate pixel art for the player"*, or *"deploy this
game"*. The `deploy` skill will prompt the user to authenticate
(`npx vibedgames login`, device-code flow) the first time they ship
something — no need to log in now.

Docs: https://vibedgames.com
