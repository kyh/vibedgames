# AGENTS.md

**vibedgames** is an infrastructure platform for deploying, hosting and adding multiplayer to browser games: build a game locally, `vg deploy` it, and it is served at `{slug}.vibedgames.com`. The stack is a pnpm/Turborepo monorepo — TanStack Start (React 19 + Vite SSR) on Cloudflare Workers, oRPC + Drizzle on D1, better-auth, PartyServer on Durable Objects, R2 for game bundles.

This is the tool-agnostic guide for coding agents, and it is meant to be **run**, not just read. Claude also reads `CLAUDE.md` (product context, architectural decisions, conventions); both point back here.

## Quickstart (headless)

```sh
pnpm install && pnpm bootstrap --yes   # .env, local D1 schema, seeded logins
pnpm dev:web                           # http://localhost:5173
```

`pnpm bootstrap` (`scripts/bootstrap.ts`) copies `.env.example` to `.env` if there is none, boots the dev Worker once if the local Miniflare D1 does not exist yet (`packages/db/drizzle.config.local.ts` resolves the SQLite file out of `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`, which only the dev Worker creates) and stops it again, then runs `pnpm db:push` and `pnpm db:seed-local`. Everything it touches is local: it never reads `.env.production*` and never reaches the remote D1. It is idempotent — re-run it any time, and after every schema change. Without `--yes` it asks once before starting, unless stdin or stdout is not a TTY.

Liveness: `curl -s -o /dev/null -w '%{http_code}' localhost:5173/auth/login` → `200`. (`/` answers `307` — it redirects to a featured game — so don't use it as a health check.)

## Environment

One file, two consumers. Everything lives in the repo-root `.env`; template is `.env.example`.

| Consumer                                         | Reaches it via                                                  | Holds                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| drizzle-kit, the cf CLI                          | `process.env`, loaded by each package's `with-env` (dotenv-cli) | `CLOUDFLARE_ACCOUNT_ID` / `_DATABASE_ID` / `_D1_TOKEN` / `_API_TOKEN`                                         |
| the dev Worker, via the Cloudflare `env` binding | `bindings.secret()` in `apps/web/cloudflare.config.ts`          | `BETTER_AUTH_SECRET`, `FAL_API_KEY`, `TYPESAFE_API_KEY`, `STRIPE_*`, `GITHUB_*`, `GOOGLE_*`, `RESEND_API_KEY` |

**The declared secrets are the whole mechanism.** Declaring a name with `bindings.secret()` makes the dev server fold `process.env` into the Worker binding and filter it down to exactly the declared names — so a secret that is in `.env` but not declared silently never reaches the Worker. Adding one means editing two places: `.env.example` and `cloudflare.config.ts` (the `Env` type is generated from it).

Keep `RESEND_API_KEY` empty in `.env`, as `.env.example` ships it (an empty value counts as unset, and every other optional key is read the same way): without it the dev server writes each email, password-reset link included, to its own log instead of sending it, so a reset can be followed headlessly and seeded addresses never receive mail. Only a request to `localhost` logs (`mailerOf` in `packages/service/src/email/mailer.ts`): a deployed Worker without the key sends and logs nothing, since a logged reset link is a live login, warns once per isolate that it sends no email, refuses a password reset up front and skips email verification.

Do not reintroduce `apps/web/.dev.vars`. The dev server prefers it and stops reading `.env`/`process.env` the moment it exists, so the root file goes quietly dead. In production the same names are set with `cf workers secrets update`.

## Seeded logins

`pnpm db:seed-local` applies `packages/db/seed.sql` to the local D1. It creates:

| Identity                               | Use                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `user@vibedgames.com` / `password123`  | browser login, regular user                                               |
| `admin@vibedgames.com` / `password123` | browser login, admin (`/admin`: users and credit codes)                   |
| `dev-local-session-token-0000000000`   | long-lived bearer token for the CLI and raw HTTP                          |
| `DEV123`                               | credit code, $20, unlimited uses — redeem once per account in `/settings` |

Five sample games are seeded onto the admin account, so `/home` is non-empty when signed in as `admin@vibedgames.com`, and they show up under Users in `/admin`. (The games themselves are served from the live prod subdomains; only the D1 rows are local.) `/` and `/discover` never read D1 — they render the hardcoded `featuredGames` array in `apps/web/src/components/game/data.ts`, so re-seeding cannot change them.

Headless auth without a browser:

```sh
# CLI — overrides the saved login without clobbering ~/.config/vg/auth.json
VG_API_URL=http://localhost:5173 VG_TOKEN=dev-local-session-token-0000000000 vg whoami

# raw oRPC — POST only; GET is not a supported method and 404s
curl -s -X POST 'http://localhost:5173/api/orpc/deploy/list' \
  -H 'Authorization: Bearer dev-local-session-token-0000000000' \
  -H 'content-type: application/json' \
  -d '{"json":{}}'

# the same procedure over REST (plain JSON, described by /openapi.json)
curl -s -X POST 'http://localhost:5173/api/v1/deploy/list' \
  -H 'Authorization: Bearer dev-local-session-token-0000000000'

# the same procedure as an MCP tool (Streamable HTTP; tools/list needs no credential)
curl -s http://localhost:5173/mcp \
  -H 'Authorization: Bearer dev-local-session-token-0000000000' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"deployments","arguments":{}}}'

# a real session cookie, for handing to a browser context
curl -s -i -X POST http://localhost:5173/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"email":"user@vibedgames.com","password":"password123"}' | grep -i set-cookie
```

Note better-auth rate-limits to 10 requests / 60s per IP — a tight retry loop against `/api/auth/*` will start getting 429s.

### A real `VG_TOKEN`, for a session with no browser

The token above is the seeded local one. Against **prod** — a cloud session, or CI
— `VG_TOKEN` has to be a real one, and `vg login` cannot produce it unattended: it
prints a code and waits for someone to approve it in a browser, and the access
token it saves lasts an hour (the CLI refreshes it, a copied one does not). Create
an API key instead, in Settings → API keys on vibedgames.com (a `vg_…` string),
and set that as the environment secret. `VG_TOKEN` alone is sufficient — it is read
before the saved config, so a session with no `~/.config/vg` authenticates from it:

```sh
VG_TOKEN=… vg whoami        # names the account the token belongs to
VG_TOKEN=… vg credits       # and it can see the balance
```

It is a live credential against a real balance, so keep it out of the repo and out
of a public repo's Actions secrets unless a workflow actually needs it — none
currently does.

## Verify a change end-to-end

Everything here is local and disposable — Miniflare D1/R2, seeded logins, headless browsers, no production access. Run it, fix failures your change caused, rerun what it touched, and do not stop to ask between steps. A change is done when this gate is green **and** the surface it touched has been driven once (a game via `vg playtest`, the web app via the recipe below); a first implementation that has not been run is not done.

Static gate — before a commit:

```sh
pnpm verify   # typecheck · lint · format · test
```

**Lint is a clean gate.** `oxlint.config.ts` extends the ultracite presets (`ultracite/oxlint/core`, `react`, `anti-slop`, `landmines`); every rule is an error, `lint` fails on the first one, and it is type-aware (`options.typeAware`), so a file outside every tsconfig lints as `any`. Landmines means no prose comments (TSDoc on exported API, directives and a one-line `// WARNING:` excepted), no annotated return types (type the variable or use `satisfies`), no test doubles or fixed sleeps, and tests beside the module they test. The few deliberate exceptions and why are listed in `CLAUDE.md`. Prefer fixing code over `oxlint-disable` comments; when a rule is genuinely wrong for a line, disable that line with a `-- reason`.

`pnpm test` runs each workspace's own suite: the `vg` CLI's units, the sims and smoke checks in all fourteen example games, `apps/web`'s content-negotiation / structured-data / page-content / OpenAPI / oRPC-handler units, the games and party workers under workerd, and the packages' units. Nothing in `verify` renders a web route, drives a browser or runs a procedure against a database (`packages/service`'s suites stop at middleware, auth config, and the generate and playtest proxies against a local stand-in upstream) — so a green `verify` is a floor, not proof. Drive the change: `vg playtest` for games (see the `playtest` skill), the recipe below for the web app.

Runtime — the web app and the example games are both browser-reachable. `vg playtest` is the one browser driver (a passthrough to agent-browser; it installs itself and its browser on first use, so there is nothing to set up beyond `pnpm dogfood`). With `pnpm dev:web` running:

```sh
vg playtest open http://localhost:5173/auth/login
vg playtest fill '[data-test="email-input"]' user@vibedgames.com
vg playtest fill '[data-test="password-input"]' password123
vg playtest press Enter                       # lands on /home
vg playtest open http://localhost:5173/settings
vg playtest snapshot                          # accessibility tree with @eN refs
vg playtest fill @e10 my-key                  # refs come from the snapshot above
vg playtest click @e12                        # "Create key" — the list should refresh
vg playtest screenshot /tmp/after.png
```

Each session gets its own browser: the SessionStart hook sets `AGENT_BROWSER_SESSION` to the session's id, so a subagent driving a browser beside another passes `--session <name>`. Locate by `snapshot -i` refs or `find role … --name`, never `find text`, which can match a hidden duplicate label. A background tab gets no animation frames, so menus won't open: `vg playtest tab keep live` fixes it.

The auth form uses react-hook-form, so prefer the `data-test` attributes over positional refs for the two credential fields; everything else is reliable off `snapshot`.

Six flows cover all ten `useMutation` sites in the app: `/settings` (create + revoke an API key), `/admin` → Credit codes (create + revoke a code), `/admin` → Users (create a user, grant credits, then re-check `/settings`), `/home` (delete a game), `/settings` again (click "Have a code? Redeem it" and type `DEV123` into the dialog — that is the `credits.redeem` mutation; a second redeem by the same account answers 409; the buy buttons, which fire `credits.checkout`, render only when both `STRIPE_*` keys are set — without them `credits.me` reports `purchasesEnabled: false` and the section offers a code button instead), `/settings` → Connected apps (Disconnect an app, after `vg login` against the dev server has connected the CLI). `/device` is not a `useMutation` site: `vg login` against the dev server prints a code, and its page approves or denies it through the auth client.

## Platform matrix

| Surface       | Dev command                   | Where                      | Agent-verifiable at runtime?                         |
| ------------- | ----------------------------- | -------------------------- | ---------------------------------------------------- |
| Web app       | `pnpm dev:web`                | `:5173`                    | **Yes** — `vg playtest`, or curl for the API routes  |
| `vg` CLI      | `pnpm dogfood`                | `vg` on PATH               | **Yes** — `VG_API_URL` + `VG_TOKEN`, `--json` output |
| Party (DO)    | `pnpm dev:party`              | `:8787` (`cf dev` default) | Partly — WebSocket protocol, no UI                   |
| Games worker  | `pnpm dev:games`              | `:3002`                    | Partly — curl; serves R2 bundles, no local fixtures  |
| Example games | `pnpm dev:<game>`             | per-game vite port         | **Yes** — `vg playtest`; see the `playtest` skill    |
| Factory       | `pnpm -F @repo/factory start` | terminal                   | No — interactive Ink app                             |

`dev:party` pins its inspector to `:9230`, so it runs beside `dev:games` or `dev:web`, which both take the default `:9229` first.

For the surfaces marked No, `pnpm typecheck` and `pnpm build` are the gate; a real check needs a human. Games are agent-verifiable for _correctness_ (loop alive, input alive, objective reachable, no errors) — whether one is **fun** still needs a human, and headless frame rates are meaningless.

`pnpm dogfood` builds and `npm link`s the local CLI and re-syncs `.claude/skills/` against `plugins/*/skills/*`. The symlinks are committed, so a fresh clone already resolves skills — only the link step is per-machine. `pnpm dogfood:reset` undoes it.

## Rules that matter

- **Never `cf deploy` (or `wrangler deploy`) locally.** Deploys happen from GitHub Actions on push to `main`.
- **`vg deploy` against the dev Worker stays local.** Upload and download URLs are signed `/api/upload` / `/api/download` URLs on the request's own host, streamed through the `GAMES_BUCKET` binding (`packages/service/src/storage/signed-urls.ts`), so bytes land in the Miniflare bucket whether you address it as `localhost` or `127.0.0.1`.
- **Never push schema to remote.** `pnpm db:push-remote` is the only command that touches production D1; it is the only one that reads `.env.production.local`. `pnpm db:push`, `db:studio` and `db:local` are local-only.
- **Every mutation invalidates exactly the query keys it touches**, in its own `onSuccess`. There is no blanket invalidation in the query client; if a write should refresh a list, say so at the call site.
- **No `any`, no non-null `!`, no `as` casts. Kebab-case filenames.** Make illegal states unrepresentable.
- **Render dates through `apps/web/src/lib/format.ts`.** The Worker renders in UTC and the browser doesn't; an unpinned `toLocaleDateString()` is a hydration mismatch.
- **Games are untrusted user code.** Session cookies stay scoped to the apex domain. Never weaken that boundary — see `CLAUDE.md`.

## Map

- `apps/web` — the platform app (routes, auth, oRPC handler) · `apps/party` — multiplayer DO · `apps/games` — R2 game server · `apps/cli` — the published `vg` CLI · `apps/factory` — Node/Ink orchestrator
- `packages/contract` — the oRPC contract: inputs, outputs, OpenAPI meta · `packages/service` — its implementation: routers, auth config, credits ledger · `packages/db` — Drizzle schema (source of truth for the data model) + `seed.sql` · `packages/ui`, `packages/multiplayer`, `packages/gamepad`, `packages/playtest`, `packages/embed`, `packages/asset-tools` (the image logic bundled into the skills' scripts)
- `games/*` — bundled example games, not platform code
- `plugins/*/skills/*` — the skills shipped to end users; symlinked into `.claude/skills/` by `pnpm dogfood`
- `CLAUDE.md` — product context, architectural decisions, command list
- `/llms.txt`, `/.well-known/agent-skills/index.json` — machine-readable surfaces served by the web app
