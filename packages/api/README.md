# @repo/api

oRPC API layer. Routers, auth configuration, and procedure helpers shared by the web app and consumed (type-only) by the CLI.

## Routers

| Router     | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| `auth`     | Session info, device-code flow for CLI login, invite claiming       |
| `apiKeys`  | Long-lived API keys for headless/CI clients                         |
| `waitlist` | Waitlist signup                                                     |
| `deploy`   | Game deploys: create (presigned R2 upload URLs) + finalize          |
| `generate` | Asset generation proxy for `vg generate` (server holds the API key) |
| `credits`  | Credit balance + usage over the micro-USD ledger                    |
| `admin`    | Admin-only operations                                               |

`AppRouter` is the exported type — the CLI imports it for end-to-end type safety without bundling any server code.

## Stack

- [oRPC](https://orpc.unnoq.com) with [Zod](https://zod.dev)
- [better-auth](https://better-auth.com) — config lives in `src/auth/auth.ts`
- `@repo/db` for data access (Drizzle + D1)
- `aws4fetch` for presigning R2 upload URLs (`src/deploy/r2-presign.ts`)

## Credits

Generation is metered; deploys and hosting are free. `src/credits/` owns the
append-only micro-USD ledger — balance is `SUM(delta_micro)`, there is no cached
balance column, and idempotency lives in deterministic entry ids
(`signup:{userId}`, `hold:{requestId}`, …). `generate.forward` blocks submits at
balance ≤ 0, debits an estimated hold, settles to actual provider cost, and
refunds the hold on a failed/cancelled job. Never write ledger rows from outside
this directory.

## Notes

- Runs inside the web app's Cloudflare Worker — context carries D1, R2, and auth bindings.
- R2 types are declared structurally (`R2BucketLike` in `src/orpc.ts`) so `AppRouter` doesn't leak a `@cloudflare/workers-types` dependency to consumers.
- Local dev presigns through the Worker's R2 binding instead of S3 when the Host header is `localhost` — so `vg deploy` against `http://localhost:5173` never touches production R2. `127.0.0.1` misses that check.
