import type { Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

export const docsDoc: Doc = {
  path: "/docs",
  title: "Vibedgames developer docs",
  description:
    "Developer documentation for Vibedgames: the vg CLI, the tRPC API, authentication, the multiplayer and gamepad packages, and the machine-readable endpoints an agent can fetch.",
  lead: [
    {
      kind: "p",
      text: "Vibedgames is driven from a terminal by a coding agent. This page is the index of everything that agent can call: the CLI commands, the HTTP API behind them, the npm packages a game imports, and the machine-readable files published on this domain.",
    },
    {
      kind: "p",
      text: "If you are an agent reading this for the first time, start with [/llms.txt](/llms.txt) — it says when Vibedgames is the right tool and which command to run first.",
    },
  ],
  sections: [
    {
      heading: "Install",
      blocks: [
        {
          kind: "p",
          text: "One command installs the game-building skills into the project and puts the `vg` binary on PATH:",
        },
        { kind: "code", lang: "sh", code: "npx vibedgames init" },
        {
          kind: "p",
          text: "The full install guide, including what to do when a global npm install is not permitted, is served as markdown at [/install](/install).",
        },
      ],
    },
    {
      heading: "The vg CLI",
      blocks: [
        {
          kind: "p",
          text: "Every command takes `--json` for machine-readable output and `--field <path>` to print a single value out of it, and exits with deterministic codes. `vg <command> --help` is authoritative.",
        },
        {
          kind: "code",
          lang: "sh",
          code: [
            "vg new <slug>            # scaffold a Phaser 4 + Vite + TypeScript game",
            "vg new <slug> --engine threejs | react-r3f | none",
            "vg init                  # install the skills + CLI into a project",
            "vg update                # update the CLI and installed skills",
            "vg login | logout | whoami",
            "vg deploy [dir]          # ship a built game to {slug}.vibedgames.com",
            "vg fork <slug> [target]  # fork another project's shipped source",
            "vg credits               # generation credit balance and recent usage",
            "vg playtest <url>        # drive a real browser against a game",
            "",
            "vg generate models [query]      # search the model endpoint catalog",
            "vg generate schema <model>      # a model's input/output schema",
            "vg generate pricing <model>     # a model's pricing",
            "vg generate run <model> [args]  # run a model, wait for the result",
            "vg generate status <model> <id> # poll, fetch or cancel an async job",
            "vg generate upload <file>       # upload an asset, get a URL",
            "vg generate docs <query>        # search model documentation",
          ].join("\n"),
        },
        {
          kind: "p",
          text: `Command reference: [apps/cli/README.md](${siteConfig.repository}/blob/main/apps/cli/README.md). Package: [vibedgames on npm](${siteConfig.npm}).`,
        },
      ],
    },
    {
      heading: "API and authentication",
      blocks: [
        {
          kind: "p",
          text: "The platform API is [tRPC](https://trpc.io) over HTTP at `https://vibedgames.com/api/trpc/<router>.<procedure>`. There is no separate REST surface and no OpenAPI document; the `AppRouter` type exported from `@repo/api` is the contract, and the CLI is the reference client. The routers are `auth`, `apiKeys`, `waitlist`, `deploy`, `generate`, `credits` and `admin`.",
        },
        {
          kind: "p",
          text: "Authentication is [better-auth](https://better-auth.com). The CLI uses a device-code flow: it prints a six-character code, the person confirms it in a browser, and the CLI polls until a token is issued and saved to `~/.config/vg/auth.json`. For CI and headless agents, set `VG_TOKEN` to a token obtained that way, and `VG_API_URL` to point at a non-production API. Raw HTTP calls send it as `Authorization: Bearer <token>`.",
        },
        {
          kind: "code",
          lang: "sh",
          code: [
            "curl -s https://vibedgames.com/api/trpc/deploy.list \\",
            '  -H "Authorization: Bearer $VG_TOKEN"',
          ].join("\n"),
        },
        {
          kind: "p",
          text: "Auth endpoints live under `/api/auth/*` and are rate limited. Deploys and hosting are free; only `vg generate` is metered, against a per-account credit balance readable with `vg credits`.",
        },
      ],
    },
    {
      heading: "Packages a game imports",
      blocks: [
        {
          kind: "ul",
          items: [
            `[@vibedgames/multiplayer](https://www.npmjs.com/package/@vibedgames/multiplayer) — host-authoritative shared state and React hooks over WebSockets, backed by Cloudflare Durable Objects. Source: [packages/multiplayer](${siteConfig.repository}/tree/main/packages/multiplayer).`,
            `[@vibedgames/gamepad](https://www.npmjs.com/package/@vibedgames/gamepad) — on-screen joystick and buttons, plus physical controller input, so a desktop-built game works on a phone. Source: [packages/gamepad](${siteConfig.repository}/tree/main/packages/gamepad).`,
            `[vibedgames](${siteConfig.npm}) — the \`vg\` CLI itself.`,
          ],
        },
      ],
    },
    {
      heading: "Agent skills",
      blocks: [
        {
          kind: "p",
          text: "The game-studio skills — design critique, Phaser and Three.js, pixel art and spritesheets, VFX, game feel, level design, multiplayer, playtesting, deploy — are published under the Agent Skills discovery convention:",
        },
        {
          kind: "ul",
          items: [
            "[/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json) — the discovery index, with a SHA-256 digest per skill.",
            "`/.well-known/agent-skills/{name}/SKILL.md` — each skill served verbatim as markdown.",
          ],
        },
        {
          kind: "p",
          text: `Skill sources: [plugins/](${siteConfig.repository}/tree/main/plugins).`,
        },
      ],
    },
    {
      heading: "Machine-readable endpoints on this domain",
      blocks: [
        {
          kind: "ul",
          items: [
            "[/llms.txt](/llms.txt) — what Vibedgames is for, when an agent should use it, and the entry command.",
            "[/install](/install) — the install instructions, served as markdown.",
            "[/docs](/docs) — this page; also available as markdown via `Accept: text/markdown`.",
            "[/sitemap.xml](/sitemap.xml) — every crawlable page on the apex domain.",
            "[/robots.txt](/robots.txt) — crawler policy. AI crawlers are explicitly allowed.",
            "[/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json) — the skill index.",
          ],
        },
        {
          kind: "p",
          text: "Every prose page on this domain also answers `Accept: text/markdown` with a markdown representation of the same content, per the [acceptmarkdown.com](https://acceptmarkdown.com) convention:",
        },
        {
          kind: "code",
          lang: "sh",
          code: 'curl -s -H "Accept: text/markdown" https://vibedgames.com/docs',
        },
      ],
    },
    {
      heading: "Source and support",
      blocks: [
        {
          kind: "p",
          text: `The whole platform is MIT licensed at [${siteConfig.repository}](${siteConfig.repository}). Each app and package carries its own README, and \`AGENTS.md\` at the repository root is the runnable guide for working on it. Support channels are listed on [Contact](/contact).`,
        },
      ],
    },
  ],
};
