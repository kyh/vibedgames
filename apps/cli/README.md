# vibedgames (CLI)

CLI tool for deploying games to vibedgames.

## Install

```sh
npm i -g vibedgames
```

## Commands

```sh
vg login              # authenticate via browser
vg logout             # clear credentials
vg whoami             # show current user
vg deploy [dir]       # deploy a game directory
vg deploy ./dist --slug my-game
```

## How deploy works

1. Walks the directory, hashes files, validates `index.html` exists
2. Calls `deploy.create` API — gets presigned R2 upload URLs
3. Uploads files to R2 with bounded concurrency
4. Calls `deploy.finalize` — game goes live at `{slug}.vibedgames.com`

## Auth

Uses a polling flow: CLI generates a code, opens the browser, polls until the user confirms. Token stored at `~/.config/vg/auth.json`.
