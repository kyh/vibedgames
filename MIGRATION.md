# Cloudflare Migration

Migrates the stack from Vercel + Next.js + Turso → **Cloudflare Workers + TanStack Start + D1**.

## What changed

### `packages/db`
- `@libsql/client` removed; now uses `drizzle-orm/d1`.
- `drizzle-client.ts` exports `createDb(d1: D1Database)` (factory) instead of a module-level singleton — D1 is bound per-request via the Worker `env`.
- `drizzle.config.ts` switched to `dialect: "sqlite"` + `driver: "d1-http"`.

### `packages/api`
- `auth.ts` now exports `createAuth({ db, baseURL, secret, productionURL })` instead of a module-level `auth`. All `VERCEL_*` env logic removed; `baseURL` is derived from the request.
- `trpc.ts` `createTRPCContext` now requires `{ headers, db, auth, productionURL }` from the caller.
- `waitlist-router.ts` reads `productionURL` from ctx instead of `process.env.VERCEL_PROJECT_PRODUCTION_URL`.
- Removed `next` from devDependencies.
- Removed module-level `getSession`/`getOrganization` helpers (they relied on `next/headers`); call `ctx.auth.api.getSession({ headers })` from your route/loader instead.

### `apps/web`
- Next.js 16 → **TanStack Start** (Vite + `@tanstack/react-start` + `@cloudflare/vite-plugin`, target `cloudflare-module`).
- File-based routes under `src/routes/` mirror the previous Next routes 1:1:
  - `__root.tsx` (was `app/layout.tsx`)
  - `index.tsx` + `$gameId.tsx` (was `app/[[...gameId]]/page.tsx`)
  - `auth/route.tsx` + `auth/{login,register,password-reset,password-update}.tsx`
  - `api/trpc/$.ts`, `api/auth/$.ts`, `api/chat.ts` (server file routes)
- `src/server/context.ts` builds db + auth from the Cloudflare `env` per request.
- Components were patched to drop `next/link`, `next/image`, `next/navigation`, `next/font/local`. Existing component tree under `src/app/.../_components/` and `src/components/` is otherwise unchanged.
- `wrangler.jsonc` defines a Workers + Assets deploy with the D1 binding `DB`. **You must paste your real `database_id` after running `wrangler d1 create vibedgames`.**

### `apps/party`
- Added a `[[d1_databases]]` binding (`DB`) in `wrangler.toml` pointing at the same D1 database, plus `nodejs_compat`. Use `createDb(env.DB)` from `@repo/db/drizzle-client` if/when the party server needs DB access.

### Root
- `turbo.json` `globalEnv`: dropped `TURSO_*` and `VERCEL_*`; added `CLOUDFLARE_*`, `PRODUCTION_URL`.
- `.env.example` rewritten for the Cloudflare stack.
- `pnpm-workspace.yaml` catalog: removed `next`.
- `MIGRATION.md` (this file).

## First-time setup

```bash
# 1. Install
pnpm install

# 2. Create D1 database
pnpm wrangler d1 create vibedgames
#   → paste the printed database_id into:
#       apps/web/wrangler.jsonc
#       apps/party/wrangler.toml
#   → also set CLOUDFLARE_DATABASE_ID in .env for drizzle-kit

# 3. Generate + apply migrations
pnpm -F db generate
pnpm wrangler d1 migrations apply vibedgames --local   # local
pnpm wrangler d1 migrations apply vibedgames --remote  # production

# 4. Set secrets
pnpm wrangler secret put AUTH_SECRET     --config apps/web/wrangler.jsonc
pnpm wrangler secret put V0_API_KEY      --config apps/web/wrangler.jsonc
pnpm wrangler secret put AI_GATEWAY_API_KEY --config apps/web/wrangler.jsonc

# 5. Dev
pnpm dev-web      # vite dev with cloudflare plugin (D1 + assets locally)
pnpm dev-party    # wrangler dev for the partyserver

# 6. Deploy
pnpm -F @repo/web deploy
pnpm -F @repo/party deploy
```

## Known follow-ups

These were intentionally left as TODOs because they require a working install + D1 ID to validate end-to-end:

1. **`pnpm install`** — needs to run to resolve the new TanStack Start, `@cloudflare/vite-plugin`, and `drizzle-orm/d1` versions. If any peer-dep mismatches surface, pin them in `pnpm-workspace.yaml`.
2. **Drizzle migrations** — the existing `packages/db/drizzle/` folder (if any) was generated against the Turso/libsql journal format. Re-run `pnpm -F db generate` after install to produce a clean D1-compatible migration set.
3. **Server-side prefetch** — the old `app/[[...gameId]]/page.tsx` did `prefetch(trpc.localGame.getBuild...)` from a React Server Component. The new `routes/$gameId.tsx` has a `loader` stub; wire it to `appRouter.createCaller(...)` once you confirm how you want to thread the env through TanStack Start loaders (`getRequest()` from `@tanstack/react-start/server`).
4. **Custom font** — `next/font/local` (vg5000.woff2) was dropped from `__root.tsx`. Add an `@font-face` declaration in `src/app/styles/globals.css` (the file still exists at `src/app/styles/vg5000.woff2`) and reference `--font-mono` from there.
5. **Image domains** — `next.config.js` `images.remotePatterns` is gone (TanStack/Vite serves plain `<img>`). The Supabase background URL is now hard-coded in `__root.tsx`.
6. **`globalThis.__env` shim** — the API route handlers read the Cloudflare env via `globalThis.__env`. Depending on the exact `@cloudflare/vite-plugin` version, you may need to use `getRequest()` + `getEvent().context.cloudflare.env` from `@tanstack/react-start/server` instead. Adjust in `src/routes/api/*` once installed.
7. **Auth client baseURL** — `apps/web/src/lib/auth-client.ts` uses better-auth's default (relative). Confirm it still resolves correctly under TanStack Start SSR.
