# Vibedgames

Infrastructure for vibe coding multiplayer browser games. Deploy games to `{slug}.vibedgames.com`, add multiplayer with a few React hooks, and generate assets with AI skills.

## What's in the box

| | |
|---|---|
| **Deployment platform** | `vg deploy` ships static games to Cloudflare R2, served from `{slug}.vibedgames.com` |
| **Multiplayer hooks** | `useMultiplayerRoom`, `usePlayerState`, `useMultiplayerState` — drop-in React hooks backed by Durable Objects |
| **AI skills** | Claude Code skills for asset generation, game design, and more |
| **Example games** | Asteroids, Flappy Bird, Pac-Man, Tetris, Pong |

## Structure

```
apps/
  web/           Next.js web app — game hub, auth, dashboard
  party/         PartyServer — real-time multiplayer backend
  games/         Cloudflare Worker — serves deployed games from R2
  cli/           CLI tool (vg) — login, deploy, manage games
games/
  astroid/       Multiplayer Asteroids with PvP
  flappy-bird/   Flappy Bird
  pacman/        Pac-Man
  tetris/        Tetris
  pong/          Motion-controlled Pong
packages/
  api/           tRPC routers + better-auth
  db/            Drizzle ORM schema + Turso/D1
  multiplayer/   React hooks for multiplayer
  ui/            Shared UI components (Radix + Tailwind)
```

## Getting started

```sh
pnpm install
cp .env.example .env
pnpm dev
```

## Common commands

```sh
pnpm dev              # all services
pnpm dev:web          # web app only
pnpm dev:party        # multiplayer server only
pnpm dev:astroid      # asteroids game
pnpm build            # build everything
pnpm typecheck        # type check all packages
pnpm db:push          # push schema to local D1
pnpm db:push-remote   # push schema to production
```

## Deploy a game

```sh
npx vibedgames login
npx vibedgames deploy ./dist --slug my-game
# → https://my-game.vibedgames.com
```

## License

[MIT](https://github.com/kyh/vibedgames/blob/main/LICENSE)
