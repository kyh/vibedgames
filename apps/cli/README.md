# vibedgames (CLI)

CLI tool for deploying games to vibedgames.

## Install

```sh
npm i -g vibedgames
```

## Commands

```sh
vg init [dir]         # install Claude Code skills into ./.claude/skills
vg login              # authenticate via browser
vg logout             # clear credentials
vg whoami             # show current user
vg deploy [dir]       # deploy a game directory
vg deploy ./dist --slug my-game
vg asset sprite ...   # turn animation video into game-ready sprites
```

`vg skills install` is an alias for `vg init`.

## Using with Claude Code

Run `vg init` in your project to drop the full set of game-building skills
(Phaser, Three.js, Aseprite, fal.ai, deploy, etc.) into `./.claude/skills/`.
Claude picks them up automatically on next session.

## How deploy works

1. Walks the directory, hashes files, validates `index.html` exists
2. Calls `deploy.create` API — gets presigned R2 upload URLs
3. Uploads files to R2 with bounded concurrency
4. Calls `deploy.finalize` — game goes live at `{slug}.vibedgames.com`

## Sprite asset pipeline

`vg asset sprite` wraps the deterministic local cleanup pipeline. Use
image/video models for raw material, then one command turns a video into
reviewed game-ready sheets.

Requirements: Python 3, Pillow (`python3 -m pip install Pillow`), and FFmpeg
for video extraction.

```sh
vg asset sprite --video run.mp4 --character hero --animation run
# inspect the printed contact sheet
vg asset sprite --video run.mp4 --character hero --animation run \
  --run-dir .vibedgames/asset-runs/<printed-run> \
  --indices "1,6,11,17,22,27,32,38,43,49,54,60"
```

## Auth

Uses a polling flow: CLI generates a code, opens the browser, polls until the user confirms. Token stored at `~/.config/vg/auth.json`.
