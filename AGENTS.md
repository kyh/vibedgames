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

Keep `RESEND_API_KEY` empty in `.env`, as `.env.example` ships it (an empty value counts as unset, and every other optional key is read the same way): without it the dev server writes each email, sign-in code included, to its own log instead of sending it, so a sign-in can be followed headlessly and seeded addresses never receive mail. Only a request to `localhost` logs (`mailerOf` in `packages/service/src/email/mailer.ts`): a deployed Worker without the key sends and logs nothing, since a logged code is a live login, warns once per isolate that it sends no email, refuses to send a code (`EMAIL_DISABLED`) and skips the confirmed-address check on credit codes.

Do not reintroduce `apps/web/.dev.vars`. The dev server prefers it and stops reading `.env`/`process.env` the moment it exists, so the root file goes quietly dead. In production the same names are set with `cf workers secrets update`.

## Seeded logins

`pnpm db:seed-local` applies `packages/db/seed.sql` to the local D1. It creates:

| Identity                             | Use                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `user@vibedgames.com`                | browser login, regular user                                               |
| `admin@vibedgames.com`               | browser login, admin (`/admin`: users and credit codes)                   |
| `dev-local-session-token-0000000000` | long-lived bearer token for the CLI and raw HTTP                          |
| `DEV123`                             | credit code, $20, unlimited uses — redeem once per account in `/settings` |

Sign-in is a six-digit code emailed to the address (better-auth `emailOTP`), never a password, and the same form signs a new address up. `pnpm sign-in-code [email]` (default `user@vibedgames.com`) writes a fresh code for it into the local D1 and prints it, so no inbox or log is needed; it never touches a remote database.

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
curl -s -i -X POST http://localhost:5173/api/auth/sign-in/email-otp \
  -H 'content-type: application/json' -H 'Origin: http://localhost:5173' \
  -d "{\"email\":\"user@vibedgames.com\",\"otp\":\"$(pnpm --silent sign-in-code)\"}" | grep -i set-cookie
```

Note better-auth rate-limits to 10 requests / 60s per IP, and sending or checking a code to 3 / 60s — a tight retry loop against `/api/auth/*` will start getting 429s.

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

Runtime smoke — with `pnpm dev:web` running on a bootstrapped D1:

```sh
pnpm smoke    # sign-in by a code (and a foreign origin's refused), auth.me, credits.me, the seeded token, /mcp, sign-out
```

CI's `smoke` job runs the same against `pnpm -F @repo/web dev` on a fresh `pnpm bootstrap --yes`. `SMOKE_URL` points it elsewhere, but its code is minted in the local D1, so the signed-in steps run locally only.

Runtime — the web app and the example games are both browser-reachable. `vg playtest` is the one browser driver (a passthrough to agent-browser; it installs itself and its browser on first use, so there is nothing to set up beyond `pnpm dogfood`). With `pnpm dev:web` running:

```sh
vg playtest open http://localhost:5173/auth/login
vg playtest fill '[data-test="email-input"]' user@vibedgames.com
vg playtest press Enter                       # sends a code; the form asks for it
vg playtest fill '[data-test="code-input"]' "$(pnpm --silent sign-in-code)"   # a full code submits; lands on /home
vg playtest open http://localhost:5173/settings
vg playtest snapshot                          # accessibility tree with @eN refs
vg playtest fill @e10 my-key                  # refs come from the snapshot above
vg playtest click @e12                        # "Create key" — the list should refresh
vg playtest screenshot /tmp/after.png
```

Each session gets its own browser: the SessionStart hook sets `AGENT_BROWSER_SESSION` to the session's id, and the SessionEnd hook closes every browser named after it. The SubagentStart hook tells each subagent a `--session` of its own, named after the session's, so SessionEnd closes those too. Locate by `snapshot -i` refs or `find role … --name`, never `find text`, which can match a hidden duplicate label. A background tab gets no animation frames, so menus won't open: `vg playtest tab keep live` fixes it.

The auth form uses react-hook-form, so prefer the `data-test` attributes over positional refs for the email and code fields; everything else is reliable off `snapshot`.

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

- **Never `cf deploy` (or `wrangler deploy`) locally.** A push to `main` deploys, through Cloudflare Workers Builds (below).
- **`vg deploy` against the dev Worker stays local.** Upload and download URLs are signed `/api/upload` / `/api/download` URLs on the request's own host, streamed through the `GAMES_BUCKET` binding (`packages/service/src/storage/signed-urls.ts`), so bytes land in the Miniflare bucket whether you address it as `localhost` or `127.0.0.1`.
- **Never push schema to remote.** `pnpm db:push-remote` is the only command that touches production D1; it is the only one that reads `.env.production.local`. `pnpm db:push`, `db:studio` and `db:local` are local-only.
- **Every mutation invalidates exactly the query keys it touches**, in its own `onSuccess`. There is no blanket invalidation in the query client; if a write should refresh a list, say so at the call site.
- **No `any`, no non-null `!`, no `as` casts. Kebab-case filenames.** Make illegal states unrepresentable.
- **Render dates through `apps/web/src/lib/format.ts`.** The Worker renders in UTC and the browser doesn't; an unpinned `toLocaleDateString()` is a hydration mismatch.
- **Games are untrusted user code.** Session cookies stay scoped to the apex domain. Never weaken that boundary — see `CLAUDE.md`.

## Deploys

Each platform Worker is connected to this repo with Cloudflare Workers Builds (the Worker → **Settings** → **Builds**). A push to `main` builds and deploys production; a push to any other branch builds a Worker Preview named for the branch, whose URLs Cloudflare posts on the PR, beside a check run per Worker. All three use Worker Previews (the one-way switch from the old branch builds is done). Nothing deploys a Worker from GitHub Actions; production runs package scripts, and the Preview command calls `npx cf previews deploy` directly because Workers Builds accepts only a command that invokes it or `npx wrangler preview` (there is no Wrangler file, so not the latter). The dashboard holds only these:

| Setting                     | `vibedgames-web`                                                                                                | `vibedgames-party`                                              | `vibedgames-games`                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Root directory              | `/`                                                                                                             | `/`                                                             | `/`                                                                                        |
| Build command               | `pnpm turbo run build --filter=@repo/web^...`                                                                   | `pnpm turbo run build --filter=@repo/party^...`                 | `pnpm turbo run build --filter=@repo/games^...`                                            |
| Deploy command              | `pnpm -F @repo/web run deploy`                                                                                  | `pnpm -F @repo/party run deploy`                                | `pnpm -F @repo/games run deploy`                                                           |
| Preview command             | `pnpm -F @repo/db push:preview && cd apps/web && npx cf previews deploy`                                        | `cd apps/party && npx cf previews deploy`                       | off: it routes by `{slug}.vibedgames.com`, so a Preview URL has no slug and serves nothing |
| Build watch paths (include) | `apps/web/*`, `packages/contract/*`, `packages/db/*`, `packages/embed/*`, `packages/service/*`, `packages/ui/*` | `apps/party/*`, `packages/contract/*`, `packages/multiplayer/*` | `apps/games/*`, `packages/contract/*`, `packages/db/*`                                     |

Every Worker also watches `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `turbo.json`: the watch paths are each Worker's workspace dependencies (`pnpm turbo ls --filter=@repo/<app>...`), so a package added to one is added there too. `run` matters: `pnpm deploy` is pnpm's own command. The build command builds the workspace packages only; `cf deploy` and `cf previews deploy` build the Worker itself (a Preview with `isPreview`, which binds `vibedgames-preview` and `vibedgames-games-preview`). Node and pnpm come from `engines` and `packageManager`.

- **API token**: one for all three, with Workers Scripts, Workers Routes, D1 and Workers R2 Storage, each Edit. The one Workers Builds creates lacks D1, which a Preview binding its database by name needs; the token the old `CLOUDFLARE_API_TOKEN` repo secret held has all four.
- **Build variables, web's Previews only** (Builds → **Previews Base**): `CLOUDFLARE_ACCOUNT_ID` (a variable) and `CLOUDFLARE_D1_TOKEN` (an encrypted secret, D1 Edit), for `pnpm -F @repo/db push:preview`, which pushes the branch's schema to `vibedgames-preview` with `--force` before the Preview deploys. Production needs none: its schema is `pnpm db:push-remote`'s, by hand.
- **Runtime secrets** stay on each Worker, not in Builds: production's in **Settings** → **Variables & Secrets** (or `cf workers secrets update`), every name web's `cloudflare.config.ts` declares with `bindings.secret()`; a Preview's in the Previews base config (`pnpm -F @repo/web exec wrangler preview base-config secret put <NAME> --worker-name vibedgames-web`), the same names, with `OAUTH_PROXY_SECRET` equal to production's.
- **Web's production deploy also applies the R2 lifecycle** (`apps/web/infra/r2/vibedgames-games.lifecycle.json`) after `cf deploy`: it replaces the bucket's rules whole, so applying it every deploy is applying it when it changes.
- **A Preview goes with its branch** once GitHub deletes the merged head branch (the repo's "Automatically delete head branches"), and it builds on every push, red or green: it never reaches the production database or bucket.

The example games are not Workers: `.github/workflows/example-games.yml` runs `vg deploy` for each one a push to `main` changed, with the `VG_TOKEN` repo secret, after every Workers Build of the same commit when the party Worker changed too (a check run's name is Cloudflare's, so it waits on all of them).

## Map

- `apps/web` — the platform app (routes, auth, oRPC handler) · `apps/party` — multiplayer DO · `apps/games` — R2 game server · `apps/cli` — the published `vg` CLI · `apps/factory` — Node/Ink orchestrator
- `packages/contract` — the oRPC contract: inputs, outputs, OpenAPI meta · `packages/service` — its implementation: routers, auth config, credits ledger · `packages/db` — Drizzle schema (source of truth for the data model) + `seed.sql` · `packages/ui`, `packages/multiplayer`, `packages/gamepad`, `packages/playtest`, `packages/embed`, `packages/asset-tools` (the image logic bundled into the skills' scripts)
- `games/*` — bundled example games, not platform code
- `plugins/*/skills/*` — the skills shipped to end users; symlinked into `.claude/skills/` by `pnpm dogfood`
- `CLAUDE.md` — product context, architectural decisions, command list
- `/llms.txt`, `/.well-known/agent-skills/index.json` — machine-readable surfaces served by the web app
