# Agent Instructions

## Project Overview

**vibedgames** - Multiplayer browser games monorepo

### Tech Stack

- **Monorepo**: pnpm workspaces + Turborepo
- **Frontend**: Next.js 16, React 19, Tailwind CSS 4
- **Backend**: tRPC, Drizzle ORM, Turso (SQLite)
- **Auth**: better-auth
- **Multiplayer**: PartyServer (Cloudflare Workers)
- **Game engines**: Vite-based standalone apps

### Structure

```
apps/
  web/         # Main web app (@repo/web)
  party/       # PartyServer for multiplayer (@repo/party)
  games/       # Cloudflare Worker serving user-uploaded games (@repo/games)
  cli/         # CLI tool (@repo/cli)
games/
  flappy-bird/ # Flappy Bird game (@repo/flappy-bird)
  pacman/      # Pac-Man game (@repo/pacman)
  tetris/      # Tetris game (@repo/tetris)
  pong/        # Pong game (@repo/pong)
  astroid/     # Asteroid game (@repo/astroid)
packages/
  api/         # tRPC routers (@repo/api)
  db/          # Drizzle schema + migrations (@repo/db)
  multiplayer/ # Shared multiplayer logic (@repo/multiplayer)
  ui/          # Shared UI components (@repo/ui)
```

### Common Commands

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

### Environment

- Copy `.env.example` to `.env`
- Required: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`
- Optional: `V0_API_KEY`
