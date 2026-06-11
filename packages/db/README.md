# @repo/db

Drizzle ORM schema + client for Cloudflare D1 (SQLite). **Source of truth for the data model.**

## Schema

- `src/drizzle-schema.ts` — platform tables: `inviteCode`, `waitlist`, `game`, `deployment`, `deploymentFile`
- `src/drizzle-schema-auth.ts` — better-auth tables (user/session/account) — **generated, don't edit by hand**; regenerate with `pnpm --filter @repo/db generate:auth-schema`
- `src/drizzle-client.ts` — `Db` client factory bound to a D1 instance

## Workflow

No SQL migration files — the TS schema is pushed directly with `drizzle-kit push`:

```sh
pnpm db:push-local   # push schema to the local Miniflare D1 (dev:web's D1)
pnpm db:seed-local   # seed dev identity (seed.sql, idempotent)
pnpm db:local        # both of the above
pnpm db:push-remote  # push schema to prod D1 (.env.production.local)
```

Edit schema → `pnpm db:push-local` → restart `dev:web` if the change doesn't show.

## Seed data (`seed.sql`)

- dev user `dev@vibedgames.local` (role `admin`)
- invite code `DEV123`
- long-lived session token `dev-local-session-token-0000000000`

## Studio

```sh
pnpm --filter @repo/db studio  # drizzle-kit studio against remote D1
```
