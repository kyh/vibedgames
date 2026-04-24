# Install vibedgames

You are Claude Code helping a user install **vibedgames** — a platform for
deploying browser games to `{slug}.vibedgames.com` with built-in multiplayer.

Follow these steps in order. Tell the user what you're doing at each step and
ask for confirmation before running commands that modify their system.

## 1. Add the plugin marketplace

Run this slash command:

```
/plugin marketplace add kyh/vibedgames
```

This registers the vibedgames marketplace, which contains these plugins:

- `game-engines` — Phaser 3, Three.js, Capacitor (iOS)
- `game-art` — Retro Diffusion pixel art, Aseprite, asset pipeline
- `game-features` — real-time multiplayer, co-op, PvP
- `media` — fal.ai, OpenAI GPT Image, Sora, ElevenLabs
- `tooling` — deploy, frontend testing, skill authoring

## 2. Install the plugins

Ask the user which ones they want. If they say "all" or don't specify, install
all five:

```
/plugin install game-engines@vibedgames
/plugin install game-art@vibedgames
/plugin install game-features@vibedgames
/plugin install media@vibedgames
/plugin install tooling@vibedgames
```

If they only want the essentials to ship a game, install `game-engines` and
`tooling`.

## 3. Install the CLI

Run:

```
npm install -g vibedgames
```

The binary is `vg`. Verify it installed with `vg --version`.

## 4. Authenticate

Run:

```
vg login
```

This starts a device-code flow:

1. The CLI prints an 8-character code and a URL.
2. Open the URL in the user's browser and have them confirm the code.
3. The CLI polls and stores the token once confirmed.

Verify with `vg whoami`.

## 5. Confirm install

Tell the user they're ready. Share these next steps:

- `vg init <name>` — scaffold a new game in the current directory
- `vg deploy` — deploy the current game to `{slug}.vibedgames.com`
- In any game repo, ask Claude things like "add multiplayer", "generate pixel
  art for the player sprite", or "deploy this" — the installed plugins will
  handle it.

Docs and discovery: https://vibedgames.com

## Troubleshooting

- If `/plugin marketplace add` prompts for confirmation, that's expected — the
  user should approve it.
- If `npm install -g vibedgames` fails with EACCES, suggest `sudo` or a Node
  version manager (nvm, volta, fnm).
- If `vg login` hangs, the user probably hasn't confirmed the code in their
  browser yet — wait or re-run.
