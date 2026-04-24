---
name: deploy
description: "Deploy browser games to vibedgames. Use when the user wants to deploy, publish, ship, or host a game — especially static HTML/JS games built with Vite, Phaser, Three.js, or plain HTML. Triggers on: 'deploy this game', 'publish my game', 'ship it', 'host this', 'put this online', 'make it playable'."
---

# Vibedgames Deploy

Deploy static browser games to `{slug}.vibedgames.com` using the vibedgames CLI.

## Prerequisites

The game directory must contain an `index.html` at the root. Typically this is the `dist/` output from a build tool (Vite, webpack, etc.).

## Deploy flow

### 1. Make sure the user is logged in

Always check auth before building or deploying. `whoami` exits non-zero
when unauthenticated:

```sh
vg whoami
```

If it prints `Not logged in` (or similar) or exits with an error, run
login *before* anything else:

```sh
vg login
```

This auto-opens the user's browser to a device-code confirmation page
and prints an 8-character code in the terminal. Tell the user:
"I opened a browser — confirm code `XXXXXXXX`." Wait for the CLI to
print `Logged in successfully` before continuing. If the browser
didn't open (remote shell, headless env), read the URL from the CLI
output and give it to the user to open manually.

Only skip this step if `whoami` succeeded with a `name (email)` line.

### 2. Build the game (if needed)

If the project has a build step, run it first:

```sh
npm run build
# or: pnpm build, vite build, etc.
```

The build output directory (usually `dist/`) is what gets deployed.

### 3. Deploy

```sh
vg deploy ./dist --slug my-game
```

- `./dist` — the directory containing `index.html` and all assets
- `--slug my-game` — the subdomain name (lowercase, hyphens allowed). The game will be live at `https://my-game.vibedgames.com`

### 4. Verify

After deploy, the CLI prints the live URL. Open it to verify.

## Rules

- **Check auth first** with `vg whoami`; run `vg login` if not authenticated
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

Then just: `vg deploy ./dist`

## Troubleshooting

- **"Not logged in"** → Run `vg login` first
- **"No index.html"** → You're deploying the wrong directory. Use the build output.
- **"Slug taken"** → Someone else owns that slug. Pick a different one.
- **Build fails** → Fix build errors before deploying. Check for missing dependencies.
