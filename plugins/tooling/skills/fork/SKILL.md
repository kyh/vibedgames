---
name: fork
description: "Fork another vibedgames project's source to build on it, and ship your own source so others can fork you. Use when the user wants to remix, fork, clone, or build on top of an existing deployed game, or asks how source-on-deploy works. Triggers: 'fork <slug>', 'remix this game', 'build on <slug>', 'start from an existing project', 'clone a deployed game', 'make source forkable'."
---

# Forking vibedgames projects

Every `vg deploy` ships the project **source** alongside the built bundle, and
that source is **forkable by default** — any logged-in user can pull it down,
re-slug it, and build on it. This is the remix loop.

## Fork an existing project

```sh
vg fork <source-slug> [new-slug]
```

- `<source-slug>` — the project to fork (e.g. `bomberman`).
- `[new-slug]` — directory + slug for your copy. Defaults to `<source-slug>-fork`.
- Downloads the source archive, extracts it into `./<new-slug>/`, and rewrites
  `vibedgames.json` + `package.json` to the new slug (clean slate — no link
  back to the original).
- `--json` emits `{ slug, dir, forkedFrom }` for agent parsing.
- `--force` overwrites an existing target directory.

Then build on it and redeploy under your own slug:

```sh
vg fork bomberman my-bomberman
cd my-bomberman
npm install
npm run dev          # iterate
npm run build
vg deploy ./dist     # ships to my-bomberman.vibedgames.com (with source, forkable)
```

`vg fork` requires login (`vg login`, or `VG_TOKEN` for headless/agent use).
If a project shipped without source (`vg deploy --no-source`), fork fails with
a clear NOT_FOUND — there's nothing to fork.

## Ship source so others can fork you

Source upload is **on by default** — `vg deploy` packs and uploads it every
time. Nothing extra to do. To opt out (proprietary / private code):

```sh
vg deploy ./dist --no-source
```

### What's in the source archive

The archive is the **project root** (the directory containing
`vibedgames.json`), gzipped, respecting `.gitignore` and a hard exclude list:

- always excluded: `node_modules`, `.git`, `dist`/`build`/`.next`/`.turbo`/`.cache`, logs
- **secrets always excluded**: `.env*`, `*.key`, `*.pem`, `id_*`, `.npmrc`, `.git-credentials`
- plus anything your `.gitignore` (or a `.vibedgames­ignore`) lists

`vg deploy` prints the file count + size of the source it's about to ship.

> **Source is a publish.** It's forkable by anyone, so never hardcode secrets,
> API keys, or tokens in committed source — read them from env at runtime and
> document the required vars in the README. The exclude list is a safety net,
> not a substitute for not committing secrets.

## Gotchas

- **Globally-unique slugs.** Your fork can't reuse the source's slug; `vg fork`
  re-slugs for you. Pick a fresh, available slug.
- **Workspace/catalog deps.** A forked project keeps its `package.json` as-is.
  If you fork one of the bundled monorepo example games, its deps may use
  `workspace:^` / `catalog:` (monorepo-only) — replace those with concrete npm
  versions (e.g. `@vibedgames/multiplayer: ^<latest>`) before `npm install`.
  Normal standalone projects fork and install cleanly.
- **Source size cap** is 25 MB (archived). Keep large generated assets in
  `.gitignore` if they blow past it; regenerate them via `vg media`.

## Deploy

See the `deploy` skill for the full deploy flow. The short version:

```sh
vg deploy ./dist --slug <slug>   # source uploaded by default → live + forkable
```
