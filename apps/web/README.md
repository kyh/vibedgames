# @repo/web

Main web app for vibedgames. Game hub, authentication, dashboard — and the host
Worker for the tRPC API.

## Stack

- [TanStack Start](https://tanstack.com/start) + React 19
- [Cloudflare Workers](https://workers.cloudflare.com) via `@cloudflare/vite-plugin`
- [better-auth](https://better-auth.com) for authentication
- [tRPC](https://trpc.io) for API layer ([`@repo/api`](../../packages/api) runs inside this Worker)
- [Tailwind CSS 4](https://tailwindcss.com) + [`@repo/ui`](../../packages/ui)

## Surfaces

| Route                                      | What                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `/`, `/discover`                           | landing + game hub — renders the hardcoded `featuredGames`       |
| `/build`, `/install`                       | how to build with an agent; CLI install                          |
| `/home`, `/settings`                       | signed-in dashboard: your games, account, credits                |
| `/admin`                                   | admin-only: users, invites                                       |
| `/auth/*`                                  | login, register, password reset, and `cli` (device-code confirm) |
| `/api/trpc/*`, `/api/auth/*`               | tRPC + better-auth handlers                                      |
| `/api/r2-upload`, `/api/r2-download`       | local-dev R2 proxy (HMAC-signed, `localhost` Host only)          |
| `/.well-known/agent-skills/*`              | the vibedgames skills, served for agents to fetch                |
| `/llms.txt`, `/robots.txt`, `/sitemap.xml` | machine-readable site descriptions                               |

Games themselves are **not** served here — they live on
`{slug}.vibedgames.com` via [`@repo/games`](../games). Session cookies are
scoped to the apex domain so untrusted game code on a subdomain can never read
them.

## Development

```sh
pnpm dev:web   # once, to create the local D1, then stop it
pnpm db:local  # push schema + seed dev logins
pnpm dev:web   # http://localhost:5173
```

The local Miniflare D1 and R2 are isolated from production and start empty.
Address the dev worker as `localhost`, never `127.0.0.1`: the local R2 upload
proxy keys off the literal Host header, and `127.0.0.1` presigns against
**production** R2.

Liveness check: `/auth/login` returns 200 — `/` answers 307 (it redirects to a
featured game). Seeded logins and headless auth recipes:
[AGENTS.md](../../AGENTS.md).

## Environment

Worker secrets (`BETTER_AUTH_SECRET`, `R2_*`, `FAL_API_KEY`) go in
`apps/web/.dev.vars` — the Worker never reads `process.env`, so putting them in
the root `.env` silently does nothing. Bindings are declared in `wrangler.jsonc`.
