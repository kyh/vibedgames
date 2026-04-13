# Agent Instructions

## What This Is

**vibedgames** — infrastructure platform for deploying, hosting, and adding multiplayer to browser games. Users build games locally, deploy via CLI (`vg deploy`), and their game is served at `{slug}.vibedgames.com`. The web app is the central hub for discovering and playing games.

## Key Architectural Decisions

- **Games are untrusted user code.** Session cookies are scoped to apex domain only (`vibedgames.com`). Games on `{slug}.vibedgames.com` subdomains cannot access auth cookies. CSP `frame-ancestors` restricts embedding. Never weaken these boundaries.
- **Single active deployment per game.** No version history, no rollback. New deploy replaces old. R2 keys are `games/{gameId}/{deploymentId}/{path}` — immutable per deployment, enabling long cache (1yr) for assets and short cache (60s) for index.html.
- **CLI auth uses device-code flow.** CLI shows 8-char code → user confirms in browser → CLI polls for token. Not OAuth.
- **Multiplayer is host-authoritative, last-write-wins.** No conflict resolution. First player becomes host; if host leaves, reassigns. Good for turn-based and host-controlled games.
- **Deploy on push to main.** GitHub Actions detects changed apps and deploys via wrangler. Never run `wrangler deploy` locally.

## Tech Stack

- **Monorepo**: pnpm workspaces + Turborepo
- **Web app**: TanStack Start (React 19, Vite SSR) on Cloudflare Workers
- **Styling**: Tailwind CSS 4 + Radix UI primitives
- **Backend**: tRPC, Drizzle ORM, Turso (SQLite)
- **Auth**: better-auth (manages user/session/account tables — don't modify directly)
- **Multiplayer**: PartyServer (Cloudflare Durable Objects)
- **Game hosting**: Cloudflare Worker + R2

## Structure

```
apps/
  web/         # Main web app (@repo/web)
  party/       # PartyServer for multiplayer (@repo/party)
  games/       # Cloudflare Worker serving user-uploaded games (@repo/games)
  cli/         # CLI tool (@repo/cli)
games/         # Bundled example games (not platform code)
  flappy-bird/ # (@repo/flappy-bird)
  pacman/      # (@repo/pacman)
  tetris/      # (@repo/tetris)
  pong/        # (@repo/pong)
  astroid/     # (@repo/astroid)
packages/
  api/         # tRPC routers (@repo/api)
  db/          # Drizzle schema + migrations (@repo/db) — source of truth for data model
  multiplayer/ # Shared multiplayer hooks (@vibedgames/multiplayer) — published to npm
  ui/          # Shared UI components (@repo/ui)
```

`@repo/*` = internal workspace packages. `@vibedgames/*` = published to npm.

## Common Commands

```bash
pnpm dev              # Run all (web + party + db studio)
pnpm dev-web          # Run web only
pnpm dev-party        # Run party server only
pnpm dev-<game>       # Run specific game (flappy-bird, pacman, etc)
pnpm build            # Build all packages
pnpm typecheck        # Type check all
pnpm lint             # Lint all
pnpm lint-fix         # Lint + fix
pnpm db-push          # Push db schema (local)
pnpm db-push-remote   # Push db schema (production)
```

## Environment

- Copy `.env.example` to `.env`
- Required: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`
- Optional: `V0_API_KEY`
