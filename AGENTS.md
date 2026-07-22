# AGENTS.md

**vibedgames** is an infrastructure platform for deploying, hosting and adding multiplayer to browser games: build a game locally, `vg deploy` it, and it is served at `{slug}.vibedgames.com`. The stack is a pnpm/Turborepo monorepo — TanStack Start (React 19 + Vite SSR) on Cloudflare Workers, tRPC + Drizzle on D1, better-auth, PartyServer on Durable Objects, R2 for game bundles.

This is the tool-agnostic guide for coding agents, and it is meant to be **run**, not just read. Claude also reads `CLAUDE.md` (product context, architectural decisions, conventions); both point back here.

## Quickstart (headless)

```sh
pnpm install
cp .env.example .env                              # drizzle-kit + wrangler CLI creds
cp apps/web/.dev.vars.example apps/web/.dev.vars  # Worker secrets (see Environment)
pnpm dev:web                                      # ← run once, then stop it
pnpm db:local                                     # push schema + seed dev identities
pnpm dev:web                                      # http://localhost:5173
```

**The double `dev:web` is not a typo.** `packages/db/drizzle.config.local.ts` resolves the Miniflare SQLite file out of `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`, and that directory only exists after the dev Worker has booted once. Skip the first run and `pnpm db:local` dies with `Local D1 not found. Run 'pnpm dev:web' once to initialize it.`

Liveness: `curl -s -o /dev/null -w '%{http_code}' localhost:5173/auth/login` → `200`. (`/` answers `307` — it redirects to a featured game — so don't use it as a health check.)

There is no bootstrap script; the five commands above _are_ the provisioning steps. `pnpm db:local` is idempotent — re-run it any time, and after every schema change.

## Environment

Two files, two different runtimes. Getting this wrong is the most common way to end up with an app that boots but can't authenticate.

| File                 | Read by                                                | Holds                                                                 |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `.env` (repo root)   | anything reading `process.env` — drizzle-kit, wrangler | `CLOUDFLARE_ACCOUNT_ID` / `_DATABASE_ID` / `_D1_TOKEN` / `_API_TOKEN` |
| `apps/web/.dev.vars` | the dev Worker, via the Cloudflare `env` binding       | `BETTER_AUTH_SECRET`, `R2_*`, `FAL_API_KEY` (optional)                |

The Worker never sees `process.env` — putting `BETTER_AUTH_SECRET` in `.env` silently does nothing. In production the same names are `wrangler secret put`. Templates: `.env.example`, `apps/web/.dev.vars.example`.

## Seeded logins

`pnpm db:seed-local` applies `packages/db/seed.sql` to the local D1. It creates:

| Identity                               | Use                                                           |
| -------------------------------------- | ------------------------------------------------------------- |
| `user@vibedgames.com` / `password123`  | browser login, regular user                                   |
| `admin@vibedgames.com` / `password123` | browser login, admin (`/admin/users`, `/admin/invites`)       |
| `dev-local-session-token-0000000000`   | long-lived bearer token for the CLI and raw HTTP              |
| `DEV123`                               | invite code, unlimited uses — for exercising `/auth/register` |

Five sample games are seeded onto the admin account, so `/home` is non-empty when signed in as `admin@vibedgames.com`, and they show up in `/admin/users`. (The games themselves are served from the live prod subdomains; only the D1 rows are local.) `/` and `/discover` never read D1 — they render the hardcoded `featuredGames` array in `apps/web/src/components/game/data.ts`, so re-seeding cannot change them.

Headless auth without a browser:

```sh
# CLI — overrides the saved login without clobbering ~/.config/vg/auth.json
VG_API_URL=http://localhost:5173 VG_TOKEN=dev-local-session-token-0000000000 vg whoami

# raw tRPC
curl -s 'http://localhost:5173/api/trpc/deploy.list' \
  -H 'Authorization: Bearer dev-local-session-token-0000000000'

# a real session cookie, for handing to a browser context
curl -s -i -X POST http://localhost:5173/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"email":"user@vibedgames.com","password":"password123"}' | grep -i set-cookie
```

Note better-auth rate-limits to 10 requests / 60s per IP — a tight retry loop against `/api/auth/*` will start getting 429s.

## Verify a change end-to-end

Static gate — run before every commit:

```sh
pnpm verify   # typecheck · lint · format · test
```

`pnpm test` covers the `vg` CLI's unit suites plus the deterministic sim scripts in four example games. It does **not** run the Playwright e2e specs in `games/crazy-waymo` and `games/lunerfall` (`pnpm -F @repo/lunerfall test:e2e`), and there is no test for the web app or `packages/api` — so a green `verify` is a floor, not proof. Drive the change.

Runtime — the web app is the only surface a browser-driving agent can reach. With `pnpm dev:web` running:

```sh
agent-browser open http://localhost:5173/auth/login
agent-browser fill '[data-test="email-input"]' user@vibedgames.com
agent-browser fill '[data-test="password-input"]' password123
agent-browser press Enter                       # lands on /home
agent-browser open http://localhost:5173/settings
agent-browser snapshot                          # accessibility tree with @eN refs
agent-browser fill @e10 my-key                  # refs come from the snapshot above
agent-browser click @e12                        # "Create key" — the list should refresh
agent-browser screenshot /tmp/after.png
```

The auth form uses react-hook-form, so prefer the `data-test` attributes over positional refs for the two credential fields; everything else is reliable off `snapshot`.

Six flows cover all nine `useMutation` sites in the app: `/settings` (create + revoke an API key), `/admin/invites` (create + revoke a code), `/admin/users` (create a user, grant credits, then re-check `/settings`), `/home` (delete a game), `/auth/register` (type `DEV123` into the invite OTP field — that is the `auth.validateInvite` mutation), `/auth/cli?code=<code>` (confirm a CLI device code — fires on mount, and deliberately invalidates nothing).

## Platform matrix

| Surface       | Dev command                   | Where                      | Agent-verifiable at runtime?                         |
| ------------- | ----------------------------- | -------------------------- | ---------------------------------------------------- |
| Web app       | `pnpm dev:web`                | `:5173`                    | **Yes** — agent-browser, or curl for the API routes  |
| `vg` CLI      | `pnpm dogfood`                | `vg` on PATH               | **Yes** — `VG_API_URL` + `VG_TOKEN`, `--json` output |
| Party (DO)    | `pnpm dev:party`              | `:8787` (wrangler default) | Partly — WebSocket protocol, no UI                   |
| Games worker  | `pnpm dev:games`              | `:3002`                    | Partly — curl; serves R2 bundles, no local fixtures  |
| Example games | `pnpm dev:<game>`             | per-game vite port         | No — canvas/WebGL, needs eyes                        |
| Factory       | `pnpm -F @repo/factory start` | terminal                   | No — interactive Bun/OpenTUI app                     |

For the surfaces marked No, `pnpm typecheck` and `pnpm build` are the gate; a real check needs a human.

`pnpm dogfood` builds and `npm link`s the local CLI and re-syncs `.claude/skills/` against `plugins/*/skills/*`. The symlinks are committed, so a fresh clone already resolves skills — only the link step is per-machine. `pnpm dogfood:reset` undoes it.

## Rules that matter

- **Never `wrangler deploy` locally.** Deploys happen from GitHub Actions on push to `main`.
- **`vg deploy` against `localhost` is safe — but only `localhost`.** When the Host header is `localhost[:port]`, `presignPut`/`presignGet` hand back HMAC-signed `/api/r2-upload` and `/api/r2-download` proxy URLs, so bytes land in the Miniflare-simulated `GAMES_BUCKET`, not prod R2 (`packages/api/src/deploy/r2-presign.ts`); `deletePrefix` always goes through the binding. The `R2_*` values in `apps/web/.dev.vars` only need to be non-empty for the config to be constructed — dummies work. The check is on the literal host string, so pointing the CLI at `http://127.0.0.1:5173` bypasses the proxy and presigns against **production** R2.
- **Never push schema to remote.** `pnpm db:push` and `pnpm db:push-remote` both target production D1. Local work is `pnpm db:push-local` / `pnpm db:local`.
- **Every mutation invalidates exactly the query keys it touches**, in its own `onSuccess`. There is no blanket invalidation in the query client; if a write should refresh a list, say so at the call site.
- **No `any`, no non-null `!`, no `as` casts. Kebab-case filenames.** Make illegal states unrepresentable.
- **Render dates through `apps/web/src/lib/format.ts`.** The Worker renders in UTC and the browser doesn't; an unpinned `toLocaleDateString()` is a hydration mismatch.
- **Games are untrusted user code.** Session cookies stay scoped to the apex domain. Never weaken that boundary — see `CLAUDE.md`.

## Map

- `apps/web` — the platform app (routes, auth, tRPC handler) · `apps/party` — multiplayer DO · `apps/games` — R2 game server · `apps/cli` — the published `vg` CLI · `apps/factory` — Bun/OpenTUI orchestrator
- `packages/api` — tRPC routers, auth config, credits ledger · `packages/db` — Drizzle schema (source of truth for the data model) + `seed.sql` · `packages/ui`, `packages/multiplayer`, `packages/gamepad`, `packages/embed`
- `games/*` — bundled example games, not platform code
- `plugins/*/skills/*` — the skills shipped to end users; symlinked into `.claude/skills/` by `pnpm dogfood`
- `CLAUDE.md` — product context, architectural decisions, command list
- `/llms.txt`, `/.well-known/agent-skills/index.json` — machine-readable surfaces served by the web app
