# @repo/api

tRPC API layer. Routers, auth configuration, and procedure helpers shared by the web app and consumed (type-only) by the CLI.

## Routers

| Router     | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| `auth`     | Session info, device-code flow for CLI login, invite claiming       |
| `waitlist` | Waitlist signup                                                     |
| `deploy`   | Game deploys: create (presigned R2 upload URLs) + finalize          |
| `generate` | Asset generation proxy for `vg generate` (server holds the API key) |
| `admin`    | Admin-only operations                                               |

`AppRouter` is the exported type — the CLI imports it for end-to-end type safety without bundling any server code.

## Stack

- [tRPC](https://trpc.io) with [superjson](https://github.com/blitz-js/superjson) + [Zod](https://zod.dev)
- [better-auth](https://better-auth.com) — config lives in `src/auth/auth.ts`
- `@repo/db` for data access (Drizzle + D1)
- `aws4fetch` for presigning R2 upload URLs (`src/deploy/r2-presign.ts`)

## Notes

- Runs inside the web app's Cloudflare Worker — context carries D1, R2, and auth bindings.
- R2 types are declared structurally (`R2BucketLike` in `src/trpc.ts`) so `AppRouter` doesn't leak a `@cloudflare/workers-types` dependency to consumers.

## Tests

```sh
pnpm --filter @repo/api test:generate
```
