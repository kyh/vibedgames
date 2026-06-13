# @repo/web

Main web app for vibedgames. Game hub, authentication, dashboard.

## Stack

- [TanStack Start](https://tanstack.com/start) + React 19
- [Cloudflare Workers](https://workers.cloudflare.com) via `@cloudflare/vite-plugin`
- [better-auth](https://better-auth.com) for authentication
- [tRPC](https://trpc.io) for API layer
- [Tailwind CSS 4](https://tailwindcss.com)

## Development

```sh
pnpm dev:web
```

Runs on `http://localhost:5173`. Uses Cloudflare D1 (local via miniflare) and R2 bindings.

For headless local setup (schema push + seeded dev identity), run `pnpm db:local` — see the root `CLAUDE.md` for the full local verification workflow.

## Environment

Worker secrets go in `apps/web/.dev.vars` for local dev. See `wrangler.jsonc` for bindings.
