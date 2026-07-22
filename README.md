# Vibedgames

**Seed your coding agent with the abilities of a full game studio.**

Describe what you want to your LLM and we handle the rest — infrastructure, assets, features, and shipping.

No engine to learn. No servers to rent. No art pipeline to assemble. Just chat.

## How it works

Three things, on demand:

- **Infrastructure** — Hosting, multiplayer, storage. Provisioned for you.
- **Assets** — Generated as you ask for them.
- **Features** — Prompted into your game.

Then ship it, anywhere.

## Get started

In your LLM of choice, paste:

```
Use vibedgames.com to help me build my game
```

Your agent picks up the vibedgames skills and CLI. From there, just keep prompting.

Or run it yourself:

```sh
npx vibedgames login
npx vibedgames deploy ./dist --slug my-game
```

## Repo layout

```
apps/
  web/           TanStack Start web app — game hub, auth, dashboard
  party/         PartyServer — real-time multiplayer backend
  games/         Cloudflare Worker — serves deployed games
  cli/           CLI tool (vg) — login, deploy, generate assets, manage games
games/           Example games
packages/
  api/           tRPC routers + better-auth
  db/            Drizzle ORM schema + Cloudflare D1
  multiplayer/   React hooks for multiplayer
  ui/            Shared UI components (Base UI + Tailwind)
plugins/         Claude Code plugins — game-building skills bundled with the CLI
```

## Local development

```sh
pnpm install
cp .env.example .env                              # drizzle-kit + wrangler CLI creds
cp apps/web/.dev.vars.example apps/web/.dev.vars  # Worker secrets (BETTER_AUTH_SECRET, R2, fal)
pnpm dev:web                                      # run once, then stop — creates the local D1
pnpm db:local                                     # push schema + seed dev logins
pnpm dev                                          # http://localhost:5173
```

The first `dev:web` is not a typo — the Miniflare D1 file has to exist before
`db:local` can push to it. Seeded login: `user@vibedgames.com` / `password123`.
Full agent-oriented guide, including headless auth: [AGENTS.md](./AGENTS.md).

## Common commands

```sh
pnpm dev              # all services
pnpm dev:web          # web app only
pnpm dev:party        # multiplayer server only
pnpm build            # build everything
pnpm typecheck        # type check all packages
pnpm verify           # typecheck + lint + format + test (run before every commit)
pnpm db:local         # push schema to local D1 + seed dev identity
pnpm db:push-remote   # push schema to production
```

## License

[MIT](https://github.com/kyh/vibedgames/blob/main/LICENSE)
