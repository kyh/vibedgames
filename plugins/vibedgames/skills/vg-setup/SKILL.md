---
name: vg-setup
description: "Get the `vg` CLI running and signed in to vibedgames. Use before the first `vg` command in a session, when `vg` is not found, or when a command says not logged in."
---

# vg setup

Skills that run commands use the `vg` CLI. This gets it working with no global
install. Signing in is optional. Scaffolding, coding and local playtesting work
without an account. Only the commands that reach vibedgames need one (step 2).
When the user will need one, ask early, so the one human step doesn't interrupt
a build later.

## 0. MCP tools instead of the CLI

The plugin also connects the vibedgames MCP server (`https://vibedgames.com/mcp`).
Its tools match the CLI's server commands: `whoami`, `credits`, `deploy`,
`deployments`, `fork`, `generate`, `generate_image`, `generate_video`, `skills`
and more. The first call asks the user to sign in through the browser (OAuth),
so it needs no token and no install.

- **No shell** (ChatGPT, claude.ai): use the tools. They're the only route.
- **With a shell:** either works. The CLI is still needed for local work:
  `vg new`, `vg playtest`, and `vg deploy` of a build directory.

## 1. Find the CLI

```sh
command -v vg
```

- **Found:** use `vg` as written in the skills.
- **Not found:** don't stop to install it. Run every `vg …` command as
  `npx -y vibedgames@latest …` instead: same flags, same output, same exit
  codes. Each shell call starts fresh, so write the full `npx` form every
  time; an alias won't carry over.

`npm install -g vibedgames` puts a real `vg` on PATH. Only run it if the user
wants that. `vg init` also adds the skills to a project for Cursor, Codex and
other agents.

## 2. Check sign-in

Only commands that reach vibedgames need an account: `deploy`, `fork`,
`generate`, `credits`, `playtest run`, `whoami`. `vg new` and plain
`vg playtest` work offline.

```sh
vg whoami --json   # {"email","id","name"} when signed in; exits 1 when not
```

## 3. Sign in (only when needed; the human does it once)

Choose one:

- **API key (best for headless or CI):** the user creates a key at
  https://vibedgames.com/settings and sets `VG_TOKEN` in the environment.
  `VG_TOKEN` overrides any saved login. You can't create the key for them.
- **Device code:** run `vg login` **in the background**, since it waits up to
  10 minutes for approval. It prints an 8-character code and an approval URL
  (`https://vibedgames.com/device?user_code=…`), and tries to open a browser.
  Give the user the code and that URL; the browser won't open in a remote or
  headless shell. Continue once it prints `Logged in successfully`. If it says
  `Code expired`, run it again. `Login was denied` means the user said no, so
  ask before you try again. A `vg` older than this flow can't log in, so if
  `vg login` fails, run `npx -y vibedgames@latest login`.

Then re-run `vg whoami --json` to confirm.

Never ask the user to paste a token into the chat, and never write one into
game code. A deployed game is public, so anyone could copy a token from it.

## 4. Credit (generation only)

`vg generate run` spends account credit, and new accounts start at $0.
`vg deploy`, hosting and multiplayer are free. To check or add credit, see the
`generate` skill's Credits section: `vg credits --json`, or
`vg credits redeem <CODE>`.
