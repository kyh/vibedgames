# @repo/db

Drizzle ORM schema + client for Cloudflare D1 (SQLite). **Source of truth for the data model.**

## Schema

- `src/drizzle-schema.ts` — platform tables: `inviteCode`, `waitlist`, `game`, `deployment`, `deploymentFile`, `creditEntry` (append-only micro-USD ledger), `generation` (per-request generation lifecycle)
- `src/drizzle-schema-auth.ts` — better-auth tables (user/session/account) — **generated, don't edit by hand**; regenerate with `pnpm --filter @repo/db generate:auth-schema`
- `src/drizzle-client.ts` — `Db` client factory bound to a D1 instance

## Workflow

No SQL migration files — the TS schema is pushed directly with `drizzle-kit push`:

```sh
pnpm db:push         # push schema to the local Miniflare D1 (dev:web's D1)
pnpm db:seed-local   # seed dev identity (seed.sql, idempotent)
pnpm db:local        # both of the above
pnpm db:push-remote  # push schema to prod D1 (.env.production.local)
```

Edit schema → `pnpm db:push` → restart `dev:web` if the change doesn't show.

## Seed data (`seed.sql`)

- `user@vibedgames.com` / `password123` — regular user (browser login)
- `admin@vibedgames.com` / `password123` — admin, owns the sample games
- `dev@vibedgames.local` — bearer-token identity (role `admin`)
- long-lived session token `dev-local-session-token-0000000000`
- invite code `DEV123`, unlimited uses
- five sample games on the admin account so `/home` and `/admin/users` aren't empty

Re-running the seed replaces rows, which invalidates existing browser sessions —
sign in again after seeding. `/` and `/discover` never read D1; they render the
hardcoded `featuredGames` array in the web app.

## Studio

```sh
pnpm --filter @repo/db studio  # drizzle-kit studio against remote D1
```
