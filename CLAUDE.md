# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

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
  nextjs/      # Main web app (@repo/nextjs)
  party/       # PartyServer for multiplayer (@repo/party)
  flappy-bird/ # Flappy Bird game
  pacman/      # Pac-Man game
  tetris/      # Tetris game
  pong/        # Pong game
  astroid/     # Asteroid game
packages/
  api/         # tRPC routers (@repo/api)
  db/          # Drizzle schema + migrations (@repo/db)
  multiplayer/ # Shared multiplayer logic (@repo/multiplayer)
  ui/          # Shared UI components (@repo/ui)
```

### Common Commands
```bash
pnpm dev              # Run all (nextjs + party + db studio)
pnpm dev-nextjs       # Run nextjs only
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

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

