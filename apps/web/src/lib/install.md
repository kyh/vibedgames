# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with
built-in multiplayer. Execute the steps below.

## 1. Install skills

```
npx skills add kyh/vibedgames --agent <your-agent> --yes
```

Replace `<your-agent>` with the value matching you:

- Claude Code → `claude-code`
- Cursor → `cursor`
- Codex (OpenAI) → `codex`

If you're a different agent or unsure, run
`npx skills add kyh/vibedgames --yes` — it supports 45+ agents and will
pick a sensible default based on what's configured in the project.

This uses [vercel-labs/skills](https://github.com/vercel-labs/skills) to
copy the skills to a canonical `./.agents/skills/` dir and symlink them
into your agent's skills dir (e.g. `.claude/skills/`, `.cursor/skills/`,
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

- The `skills` CLI is published by Vercel Labs; `vibedgames` is our own
  CLI on npm (binary `vg`). You need both: `skills` to install the
  rules/skills on disk, `vibedgames` to deploy and auth.
- Older docs may mention `vg init` or Claude-Code-specific `/plugin`
  commands — ignore those, they're superseded by the flow above.
