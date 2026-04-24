# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the steps below.

## 1. Install skills

```
npx vibedgames init --agent <your-agent> --yes
```

Replace `<your-agent>` with the value matching you:

- Claude Code → `claude-code`
- Cursor → `cursor`
- Codex (OpenAI) → `codex`

If you're a different agent or unsure, run `npx vibedgames init --yes`
and let it pick interactively. The init command supports 45+ coding
agents.

Under the hood, `vibedgames init` delegates to
[vercel-labs/skills](https://github.com/vercel-labs/skills): it copies
the skills to `./.agents/skills/` and symlinks them into your agent's
skills dir (e.g. `.claude/skills/`, `.cursor/skills/`,
`.codex/skills/`). Windows without symlink support falls back to copies
automatically.

## 2. Authenticate

```
npx vibedgames login
```

Device-code flow: the CLI prints an 8-character code and a URL. Ask the
user to open the URL in their browser and confirm the code. The CLI
polls and stores the token once confirmed.

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

## Notes

- `vibedgames` is our CLI on npm (binary `vg`). `npx vibedgames init`
  and `vg init` are the same command. It wraps `npx skills add
  kyh/vibedgames` from Vercel Labs.
- Older docs may mention Claude-Code-specific `/plugin` commands —
  ignore those, they're superseded by the flow above.
