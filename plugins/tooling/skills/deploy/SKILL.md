---
name: deploy
description: "Deploy browser games to vibedgames. Use when the user wants to deploy, publish, ship, or host a game — especially static HTML/JS games built with Vite, Phaser, Three.js, or plain HTML. Triggers on: 'deploy this game', 'publish my game', 'ship it', 'host this', 'put this online', 'make it playable'. Routing: ship phase (capability)."
---

# Vibedgames Deploy

Deploy static browser games to `{slug}.vibedgames.com` using the vibedgames CLI.

> **`vg` not on PATH?** The global install from `vibedgames init` is
> best-effort. If any `vg <cmd>` below fails with "command not found",
> substitute `npx vibedgames <cmd>` — it works identically.

## Starting a new game

If the user has no project yet, scaffold one in a single command. `vg new` pulls the official engine template (or a minimal inline starter) and drops a `vibedgames.json` in place so deploy works without further config:

```sh
vg new my-game                     # Phaser 4 + Vite + TS (official phaserjs template)
vg new my-game --engine threejs    # Three.js + Vite + TS starter
vg new my-game --engine react-r3f  # React + R3F + drei + Vite + TS starter
vg new my-game --engine none       # minimal Vite + TS + canvas (offline; no engine)
vg new my-game --template foo/bar  # any github degit spec
```

Pick the engine that matches the game the user described:

- **2D / pixel-art / arcade / platformer** → `phaser` (the default)
- **3D / first-person / camera-driven, imperative scene code** → `threejs`
- **3D with React component model, declarative scenes, lots of UI overlay** → `react-r3f`
- **Custom engine, plain canvas, or "I'll wire the deps myself"** → `none`

After scaffold:

```sh
cd my-game
npm install
npm run dev        # local preview
```

The matching skill (`phaser`, `threejs`, etc.) will load automatically in Claude Code based on the deps in `package.json`. Pass `--here` to scaffold into the current directory.

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
login _before_ anything else:

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

> **Playable on mobile?** Deployed games are shared by link and frequently
> opened on phones. If the game is mouse/keyboard-only, add on-screen touch
> controls (a virtual joystick + buttons) so the link works on a phone — see
> the `gamepad` skill (`@vibedgames/gamepad`). One prompt: "add touch controls".

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

Then just: `vg deploy ./dist`

## Troubleshooting

- **"Not logged in"** → Run `vg login` first
- **"No index.html"** → You're deploying the wrong directory. Use the build output.
- **"Slug taken"** → Someone else owns that slug. Pick a different one.
- **Build fails** → Fix build errors before deploying. Check for missing dependencies.
