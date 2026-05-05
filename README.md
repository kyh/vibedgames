# Vibedgames

**You bring the ideas. We bring the game studio.**

Vibedgames is a prompt-driven game studio. Describe what you want to your LLM and we handle the rest — infrastructure, assets, features, and shipping.

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
  cli/           CLI tool (vg) — login, deploy, manage games
games/           Example games
packages/
  api/           tRPC routers + better-auth
  db/            Drizzle ORM schema + Turso
  multiplayer/   React hooks for multiplayer
  ui/            Shared UI components (Radix + Tailwind)
```

## Local development

```sh
pnpm install
cp .env.example .env
pnpm dev
```

## Common commands

```sh
pnpm dev              # all services
pnpm dev:web          # web app only
pnpm dev:party        # multiplayer server only
pnpm build            # build everything
pnpm typecheck        # type check all packages
pnpm db:push          # push schema to local
pnpm db:push-remote   # push schema to production
```

## License

[MIT](https://github.com/kyh/vibedgames/blob/main/LICENSE)
