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
npx vibedgames init                                # install the skills into your project
npx vibedgames new my-game                         # scaffold a Phaser 4 + Vite + TS game
npx vibedgames login
npx vibedgames deploy ./dist --slug my-game        # live at my-game.vibedgames.com
```

Full command list: [`apps/cli/README.md`](./apps/cli/README.md).

## Repo layout

```
apps/
  web/           TanStack Start web app — game hub, auth, dashboard
  party/         PartyServer — real-time multiplayer backend
  games/         Cloudflare Worker — serves deployed games
  cli/           CLI tool (vg) — login, deploy, generate assets, manage games
  factory/       Autonomous agent that builds a game and runs it like a studio
games/           Example games, all deployed and playable
packages/
  api/           oRPC routers + better-auth
  db/            Drizzle ORM schema + Cloudflare D1
  multiplayer/   Multiplayer client + React hooks (npm: @vibedgames/multiplayer)
  gamepad/       Touch + physical controller input (npm: @vibedgames/gamepad)
  embed/         postMessage bridge between an embedded game and its wrapper
  ui/            Shared UI components (Base UI + Tailwind)
plugins/         Claude Code plugins — the game-building skills the CLI installs
```

Every app and package has its own README. Start with [`games/`](./games) for the
example games, [`plugins/`](./plugins) for the skills, and
[`apps/factory/`](./apps/factory) for the autonomous build loop.

## Local development

```sh
pnpm install
cp .env.example .env  # every credential, CLI and Worker alike
pnpm dev:web          # run once, then stop — creates the local D1
pnpm db:local         # push schema + seed dev logins
pnpm dev              # http://localhost:5173
```

The first `dev:web` is not a typo — the Miniflare D1 file has to exist before
`db:local` can push to it. Seeded login: `user@vibedgames.com` / `password123`.
Full agent-oriented guide, including headless auth: [AGENTS.md](./AGENTS.md).

## Common commands

```sh
pnpm dev              # all services (excludes example games)
pnpm dev:web          # web app only
pnpm dev:party        # multiplayer server only
pnpm dev:<game>       # one example game (see games/README.md)
pnpm build            # build everything
pnpm typecheck        # type check all packages
pnpm verify           # typecheck + lint + format + test (run before every commit)
pnpm db:local         # push schema to local D1 + seed dev identity
pnpm db:push-remote   # push schema to production
pnpm dogfood          # link the local vg CLI + sync plugin skills into .claude/skills
```

Platform workers deploy on push to `main` — never run `wrangler deploy`
locally. `pnpm format:fix` rewrites the **whole** repo, so format only the files
you touched.

## Acknowledgements

What this is built on and learned from.

- [phaserjs/template-vite-ts](https://github.com/phaserjs/template-vite-ts)
- [@chongdashu](https://x.com/chongdashu)
- [@majidmanzarpour](https://x.com/majidmanzarpour)
- [@Challacade](https://www.youtube.com/@Challacade)
- [@pixeqla](https://www.youtube.com/@pixeqla)

## License

[MIT](https://github.com/kyh/vibedgames/blob/main/LICENSE)
