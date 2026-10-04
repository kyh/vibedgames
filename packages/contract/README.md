# @repo/contract

The oRPC API's single source of truth: every procedure's input, output and OpenAPI description, and no server code. [`@repo/service`](../service) implements it; the web app's browser code and the `vg` CLI type their clients against it (`ContractClient`, `RouterInputs`, `RouterOutputs`) without importing anything server-side.

## Routers

| Router     | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| `auth`     | Session info, device-code flow for CLI login, invite claiming       |
| `apiKeys`  | Long-lived API keys for headless/CI clients                         |
| `waitlist` | Waitlist signup                                                     |
| `deploy`   | Game deploys: create (presigned R2 upload URLs) + finalize          |
| `generate` | Asset generation for `vg generate` + MCP (server holds the API key) |
| `playtest` | Decision-model proxy for `vg playtest run`, and the in-page token   |
| `credits`  | Credit balance + usage over the micro-USD ledger                    |
| `admin`    | Admin-only operations                                               |

## Layout

- `src/base.ts` — `publicBase`, `protectedBase`, `sessionOnlyBase`, `adminBase`: the credentials and error statuses each kind of procedure documents, with the credential also recorded as meta (`getRequiredCredential`) because the OpenAPI document cannot say "admin". The service's middleware enforces them, and its `root-router.test.ts` checks every procedure against that meta.
- `src/<feature>/<feature>-schema.ts` — zod inputs, and the wire constants clients share (the deploy caps). A constant the browser needs without the schemas sits in a zod-free file beside them: `src/auth/auth-limits.ts` (`INVITE_CODE_LENGTH`), so the signup form pulls no validators into every page.
- `src/<feature>/<feature>-contract.ts` — each procedure: base, OpenAPI and MCP meta, input, output.
- `src/openapi.ts` — the shared error body, security schemes and `documented()`; `apps/web` feeds `openAPIComponents` into `/openapi.json`.
- `src/mcp.ts` — `mcpTool(...)` / `notMcpTool(reason)`: whether a procedure is a tool on the web app's `/mcp` server. Every procedure declares one; `sessionOnlyBase` and up declare `notMcpTool`.

Browsers and the published CLI build against this package, so it must stay free of server code: no database client, auth instance, Worker bindings or secrets.
