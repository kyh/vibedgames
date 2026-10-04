# @repo/contract

The oRPC API's single source of truth: every procedure's input, output and OpenAPI description, and no server code. [`@repo/service`](../service) implements it; the web app's browser code and the `vg` CLI type their clients against it (`ContractClient`, `RouterInputs`, `RouterOutputs`) without importing anything server-side.

## Routers

| Router     | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| `auth`     | Session info, device-code flow for CLI login, invite claiming       |
| `apiKeys`  | Long-lived API keys for headless/CI clients                         |
| `waitlist` | Waitlist signup                                                     |
| `deploy`   | Game deploys: create (presigned R2 upload URLs) + finalize          |
| `generate` | Asset generation proxy for `vg generate` (server holds the API key) |
| `playtest` | Decision-model proxy for `vg playtest run`, and the in-page token   |
| `credits`  | Credit balance + usage over the micro-USD ledger                    |
| `admin`    | Admin-only operations                                               |

## Layout

- `src/base.ts` — `publicBase`, `protectedBase`, `sessionOnlyBase`, `adminBase`: the credentials and error statuses each kind of procedure documents. The service's middleware enforces them.
- `src/<feature>/<feature>-schema.ts` — zod inputs, and the wire constants clients share (`INVITE_CODE_LENGTH`, the deploy caps).
- `src/<feature>/<feature>-contract.ts` — each procedure: base, OpenAPI meta, input, output.
- `src/openapi.ts` — the shared error body, security schemes and `documented()`; `apps/web` feeds `openAPIComponents` into `/openapi.json`.

Browsers and the published CLI build against this package, so it must stay free of server code: no database client, auth instance, Worker bindings or secrets.
