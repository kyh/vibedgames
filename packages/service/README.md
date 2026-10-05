# @repo/service

The server half of the oRPC API: implements [`@repo/contract`](../contract) — the routers, auth configuration, and everything that touches D1, R2 or a provider key. Runs inside the web app's Worker; only server code imports it.

## Implementing the contract

`src/orpc.ts` builds `os = implement(contract)` and the middlewares that keep each contract base's promise: `requireSession` (`protectedBase`), then `rejectApiKey` (`sessionOnlyBase`), then `requireAdmin` (`adminBase`). Routers apply them on the implementer (`os.<feature>.use(...)`), so they run before input validation, and are plain objects; `src/root-router.ts` mounts them with `os.router`, which fails to compile if a contract procedure is missing or mistyped. `src/root-router.test.ts` walks every procedure in the real router and checks it answers each kind of caller as its contract base's credential declares, before validation.

## MCP

`src/mcp/server.ts` builds the account half of the web app's `/mcp` server from the router: one tool per procedure whose contract declares `mcpTool(...)`, its input schema and description taken from the procedure and its call run in-process through the same middleware and credit gate as the HTTP API. `src/mcp/server.test.ts` fails on a procedure that declares neither `mcpTool` nor `notMcpTool`, or a tool not built on `protectedBase`; `src/mcp/auth-gate.ts` decides which anonymous requests the route answers with a 401.

## Stack

- [oRPC](https://orpc.unnoq.com) with [Zod](https://zod.dev)
- [better-auth](https://better-auth.com) — config lives in `src/auth/auth.ts`
- `@repo/db` for data access (Drizzle + D1)
- `aws4fetch` for presigning R2 upload URLs (`src/deploy/r2-presign.ts`)

## Credits

Generation is metered; deploys and hosting are free. `src/credits/` owns the
append-only micro-USD ledger — balance is `SUM(delta_micro)`, there is no cached
balance column, and idempotency lives in deterministic entry ids
(`signup:{userId}`, `hold:{requestId}`, …). Every generate proc goes through
`callFal` (`src/generate/fal-call.ts`), which blocks a non-admin's submits at
balance ≤ 0 or to an endpoint with no published price, debits an estimated hold,
settles to actual provider cost, and refunds the hold on a failed/cancelled job.
Pricing that cannot answer never blocks a submit: it goes ahead and settles at its hold
(`src/credits/endpoint-pricing.ts`). Never write ledger rows from outside this directory.

## Notes

- Runs inside the web app's Cloudflare Worker — context carries D1, R2, and auth bindings.
- R2 is declared structurally (`R2BucketLike` in `src/orpc.ts`): the context names only the binding methods the code calls, so any object with them stands in for the bucket.
- Local dev presigns through the Worker's R2 binding instead of S3 when the Host header is `localhost` — so `vg deploy` against `http://localhost:5173` never touches production R2. `127.0.0.1` misses that check.
