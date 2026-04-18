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

Runs on `http://localhost:3000`. Uses Cloudflare D1 (local via miniflare) and R2 bindings.

## Environment

Worker secrets go in `apps/web/.dev.vars` for local dev. See `wrangler.jsonc` for bindings.
