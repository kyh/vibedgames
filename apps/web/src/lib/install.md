# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the steps below.

## 1. Install skills

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

## 2. Authenticate

```
npx vibedgames login
```

Device-code flow: the CLI prints an 8-char code and a URL. Ask the user
to open the URL in their browser and confirm the code.

Verify with `npx vibedgames whoami`.

## 3. You're done

The skills you just installed tell you how to handle prompts like *"add
multiplayer"*, *"generate pixel art for the player"*, or *"deploy this
game"*. Tell the user.

Next commands they can run:

- `npx vibedgames deploy` — deploy the current game to
  `{slug}.vibedgames.com`
- `npx skills update` — refresh the vibedgames skills later

Docs: https://vibedgames.com
