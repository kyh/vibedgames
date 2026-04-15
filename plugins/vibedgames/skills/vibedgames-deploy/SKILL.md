---
name: vibedgames-deploy
description: "Deploy browser games to vibedgames. Use when the user wants to deploy, publish, ship, or host a game — especially static HTML/JS games built with Vite, Phaser, Three.js, or plain HTML. Triggers on: 'deploy this game', 'publish my game', 'ship it', 'host this', 'put this online', 'make it playable'."
---

# Vibedgames Deploy

Deploy static browser games to `{slug}.vibedgames.com` using the vibedgames CLI.

## Prerequisites

The game directory must contain an `index.html` at the root. Typically this is the `dist/` output from a build tool (Vite, webpack, etc.).

## Deploy flow

### 1. Build the game (if needed)

If the project has a build step, run it first:

```sh
npm run build
# or: pnpm build, vite build, etc.
```

The build output directory (usually `dist/`) is what gets deployed.

### 2. Deploy

```sh
npx vibedgames deploy ./dist --slug my-game
```

- `./dist` — the directory containing `index.html` and all assets
- `--slug my-game` — the subdomain name (lowercase, hyphens allowed). The game will be live at `https://my-game.vibedgames.com`

If the user hasn't logged in yet:

```sh
npx vibedgames login
```

This opens a browser for authentication, then saves the token locally.

### 3. Verify

After deploy, the CLI prints the live URL. Open it to verify.

## Rules

- **Always build before deploying** if the project uses a build tool
- **Deploy the build output**, not the source directory (e.g. `dist/`, `build/`, `out/`)
- **Slug must be lowercase** with hyphens, 3-40 characters (e.g. `space-invaders`, `my-cool-game`)
- **index.html is required** at the root of the deployed directory
- **Max 50 MB total**, 10 MB per file, 500 files max
- If the user doesn't specify a slug, ask them for one or derive it from the project name
- If `vibedgames.json` exists in the deploy directory, the slug is read from there automatically

## Config file (optional)

Create `vibedgames.json` in the project root to skip the `--slug` flag:

```json
{
  "slug": "my-game",
  "name": "My Cool Game"
}
```

Then just: `npx vibedgames deploy ./dist`

## Troubleshooting

- **"Not logged in"** → Run `npx vibedgames login` first
- **"No index.html"** → You're deploying the wrong directory. Use the build output.
- **"Slug taken"** → Someone else owns that slug. Pick a different one.
- **Build fails** → Fix build errors before deploying. Check for missing dependencies.
