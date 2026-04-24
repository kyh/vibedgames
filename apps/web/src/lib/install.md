# Install vibedgames

You are an AI coding agent. The user wants to install **vibedgames** — a
platform for deploying browser games to `{slug}.vibedgames.com` with built-in
multiplayer. Execute the steps below in order.

## 1. Install skills into the project

```
npx vibedgames init
```

This downloads the vibedgames skills bundle and installs it in the current
project. Today the CLI writes skills to `.claude/skills/` (Claude Code
format); support for Cursor, Windsurf, Codex, Copilot, and generic
`AGENTS.md` is in progress. If you're not Claude Code, run the command
anyway — it'll still give the user the skills on disk, and future versions
will write native files for your agent too.

If the user already has `vg` installed globally (`npm i -g vibedgames`),
`vg init` works the same.

## 2. Authenticate

```
npx vibedgames login
```

Device-code flow: the CLI prints an 8-character code and a URL. Ask the
user to open the URL and confirm the code. The CLI polls and stores the
token once confirmed.

Verify with `npx vibedgames whoami`.

## 3. You're done

Tell the user they can now:

- `npx vibedgames init <name>` — scaffold a new game (wip; today `init`
  only installs skills — pass a directory arg to install into that dir).
- `npx vibedgames deploy` — deploy the current game to
  `{slug}.vibedgames.com`.
- Ask you (the agent) things like *"add multiplayer"*, *"generate pixel
  art for the player"*, or *"deploy this"* — the skills installed in step
  1 tell you how.

Docs: https://vibedgames.com

## Notes for the agent

- `vibedgames` is the npm package; the binary is `vg`.
- Don't try to install Claude Code plugins or marketplaces — everything
  needed lives in the CLI and the skills it writes. Ignore any older
  instructions that mention `/plugin marketplace add`.
- If `npx` fails with permissions, suggest `npm i -g vibedgames` plus a
  Node version manager (nvm, volta, fnm).
