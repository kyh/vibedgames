import type { Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

export const docsDoc: Doc = {
  description:
    "Developer documentation for Vibedgames: the vg CLI, the oRPC API, authentication, the multiplayer and gamepad packages, and the machine-readable endpoints an agent can fetch.",
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
  path: "/docs",
  sections: [
    {
      blocks: [
        {
          kind: "p",
          text: "One command installs the game-building skills into the project and puts the `vg` binary on PATH:",
        },
        { code: "npx vibedgames init", kind: "code", lang: "sh" },
        {
          kind: "p",
          text: "The full install guide, including what to do when a global npm install is not permitted, is served as markdown at [/install](/install).",
        },
      ],
      heading: "Install",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "Every command takes `--json` for machine-readable output and `--field <path>` to print a single value out of it, and exits with deterministic codes. `vg <command> --help` is authoritative.",
        },
        {
          code: [
            "vg new <slug>            # scaffold a Phaser 4 + Vite + TypeScript game",
            "vg new <slug> --engine threejs | react-r3f | none",
            "vg init                  # install the skills + CLI into a project",
            "vg update                # update the CLI and installed skills",
            "vg config                # saved settings (generate.provider, update.auto, …)",
            "vg login | logout | whoami",
            "vg deploy [dir]          # ship a built game to {slug}.vibedgames.com",
            "vg deployments           # your games; `delete <slug> --yes` removes one",
            "vg fork <slug> [target]  # fork another project's shipped source",
            "vg skills [name]         # list the game-studio skills, or print one",
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
          kind: "code",
          lang: "sh",
        },
        {
          kind: "p",
          text: `Command reference: [apps/cli/README.md](${siteConfig.repository}/blob/main/apps/cli/README.md). Package: [vibedgames on npm](${siteConfig.npm}).`,
        },
      ],
      heading: "The vg CLI",
    },
    {
      blocks: [
        {
          kind: "p",
          text: 'The platform API is one [oRPC](https://orpc.unnoq.com) router served two ways. `POST https://vibedgames.com/api/v1/<router>/<procedure>` takes and returns plain JSON and is described by the OpenAPI 3.1 document at [/openapi.json](/openapi.json) — every operation with its input, response and error schemas and the credentials it needs. `POST /api/orpc/<router>/<procedure>` is oRPC\'s own wire format (body wrapped as `{"json": …}`), used by the CLI and the web app. Both are POST-only. Errors are JSON with a stable `code` (`UNAUTHORIZED`, `BAD_REQUEST`, …) and a `message`. The routers are `auth`, `apiKeys`, `waitlist`, `deploy`, `generate`, `playtest`, `credits` and `admin`.',
        },
        {
          kind: "p",
          text: "Authentication is [better-auth](https://better-auth.com). The CLI uses a device-code flow: it prints a six-character code, the person confirms it in a browser, and the CLI polls until a token is issued and saved to `~/.config/vg/auth.json`. For CI and headless agents, set `VG_TOKEN` to a token obtained that way or to an API key (`vg_…`), and `VG_API_URL` to point at a non-production API. Raw HTTP calls send it as `Authorization: Bearer <token>`.",
        },
        {
          code: [
            "curl -s -X POST https://vibedgames.com/api/v1/deploy/list \\",
            '  -H "Authorization: Bearer $VG_TOKEN"',
          ].join("\n"),
          kind: "code",
          lang: "sh",
        },
        {
          kind: "p",
          text: "Auth endpoints live under `/api/auth/*` and are rate limited. Deploys and hosting are free; only `vg generate` is metered, against a per-account credit balance readable with `vg credits`.",
        },
        {
          kind: "p",
          text: "Agents that speak MCP get the same platform as tools at `https://vibedgames.com/mcp` (Streamable HTTP, stateless), one per `vg` command that reaches the server, named for it with `_` for spaces: `whoami`, `credits` (`credits_redeem`, `credits_buy`), `deploy`, `deployments` (`deployments_delete`), `fork`, `generate` (`generate_status`, `generate_models`, `generate_schema`, `generate_pricing`, `generate_docs`, `generate_upload`), the dedicated asset tools `generate_image`, `generate_video`, `generate_speech`, `generate_music`, `generate_sound`, `generate_3d` and `remove_background` (each on the default model the model-catalog skill names, with that model's main inputs typed) and `skills`, which serves the bundled game-studio skills; the same skills, supporting files included, are `skill://` resources under the MCP Skills extension (`skills/list`, `skills/get`). An agent with a shell deploys with `npx vibedgames deploy ./dist`, the same API key in `VG_TOKEN`. The `deploy` tool is the same procedure: call it with `bundle: true`, PUT the build as one `.tgz` (`tar -czf game.tgz -C dist .`) to the `bundleUpload` URL it returns, then call it with the `deploymentId` and `publish: true`, which unpacks it and goes live. With no shell, text files ride the call and URLs of assets `generate` made are fetched by the server. `source: true` keeps the deployed files as the game's forkable source. Large bytes never ride a tool call: `generate_upload` returns an `/api/upload` URL to PUT a model input to, and `fork` an `/api/download` URL for source: an agent's shell only ever needs to reach vibedgames.com. Connectors such as claude.ai and ChatGPT sign in with OAuth: add the URL, approve the app on vibedgames, and it gets a token for `/mcp` alone. Anything else sends an API key (`vg_…`, from [Settings](/settings)) as `Authorization: Bearer`; browser cookies are ignored.",
        },
        {
          code: [
            "# OAuth: the client identifies itself and opens the consent page",
            "claude mcp add --transport http vibedgames https://vibedgames.com/mcp",
            "",
            "# or an API key",
            "claude mcp add --transport http vibedgames https://vibedgames.com/mcp \\",
            '  --header "Authorization: Bearer $VG_API_KEY"',
          ].join("\n"),
          kind: "code",
          lang: "sh",
        },
        {
          kind: "p",
          text: "vibedgames is also an OAuth 2.1 authorization server for apps acting for a person (issuer `https://vibedgames.com/api/auth`, metadata at `/.well-known/oauth-authorization-server/api/auth`). A client identifies itself with a Client ID Metadata Document (its `client_id` is the HTTPS URL of its metadata) or registers itself (RFC 7591), then uses the authorization-code flow with PKCE, naming the resource it wants as `resource`: `https://vibedgames.com/mcp` or `https://vibedgames.com/api`. A token works only on the resource it was issued for, lasts an hour, and refreshes with `offline_access`. What it may do is its scopes: `games:read`, `games:write`, `generate`, `credits:read`, `credits:write`, `playtest`, plus OpenID's `profile` for who it acts for. A call outside them answers 403 `insufficient_scope` naming the scope to ask for (on `/mcp`, as a `WWW-Authenticate` challenge). Neither a token nor an API key reaches account settings such as API keys. People see and disconnect the apps they approved in [Settings](/settings#connected-apps).",
        },
      ],
      heading: "API and authentication",
    },
    {
      blocks: [
        {
          items: [
            `[@vibedgames/multiplayer](https://www.npmjs.com/package/@vibedgames/multiplayer) — host-authoritative shared state and React hooks over WebSockets, backed by Cloudflare Durable Objects. Source: [packages/multiplayer](${siteConfig.repository}/tree/main/packages/multiplayer).`,
            `[@vibedgames/gamepad](https://www.npmjs.com/package/@vibedgames/gamepad) — on-screen joystick and buttons, plus physical controller input, so a desktop-built game works on a phone. Source: [packages/gamepad](${siteConfig.repository}/tree/main/packages/gamepad).`,
            `[vibedgames](${siteConfig.npm}) — the \`vg\` CLI itself.`,
          ],
          kind: "ul",
        },
      ],
      heading: "Packages a game imports",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "The game-studio skills — design critique, Phaser and Three.js, pixel art and spritesheets, VFX, game feel, level design, multiplayer, playtesting, deploy — are published under the Agent Skills discovery convention:",
        },
        {
          items: [
            "[/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json) — the discovery index, with a SHA-256 digest per skill.",
            "`/.well-known/agent-skills/{name}/SKILL.md` — each skill served verbatim as markdown.",
          ],
          kind: "ul",
        },
        {
          kind: "p",
          text: `Skill sources: [plugins/](${siteConfig.repository}/tree/main/plugins).`,
        },
      ],
      heading: "Agent skills",
    },
    {
      blocks: [
        {
          items: [
            "[/llms.txt](/llms.txt) — what Vibedgames is for, when an agent should use it, and the entry command.",
            "[/openapi.json](/openapi.json) — the OpenAPI 3.1 description of the HTTP API.",
            "[/mcp](/mcp) — the API as MCP tools, for agents that speak MCP; authenticated by OAuth or an API key.",
            "[/.well-known/api-catalog](/.well-known/api-catalog) — the API catalog (RFC 9727) pointing at the OpenAPI document and these docs.",
            "[/install](/install) — the install instructions, served as markdown.",
            "[/docs](/docs) — this page; also available as markdown via `Accept: text/markdown`.",
            "[/sitemap.xml](/sitemap.xml) — every crawlable page on the apex domain.",
            "[/robots.txt](/robots.txt) — crawler policy: open to every crawler, AI included.",
            "[/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json) — the skill index.",
          ],
          kind: "ul",
        },
        {
          kind: "p",
          text: "Every prose page on this domain also answers `Accept: text/markdown` with a markdown representation of the same content, per the [acceptmarkdown.com](https://acceptmarkdown.com) convention:",
        },
        {
          code: 'curl -s -H "Accept: text/markdown" https://vibedgames.com/docs',
          kind: "code",
          lang: "sh",
        },
      ],
      heading: "Machine-readable endpoints on this domain",
    },
    {
      blocks: [
        {
          kind: "p",
          text: `The whole platform is MIT licensed at [${siteConfig.repository}](${siteConfig.repository}). Each app and package carries its own README, and \`AGENTS.md\` at the repository root is the runnable guide for working on it. Support channels are listed on [Contact](/contact).`,
        },
      ],
      heading: "Source and support",
    },
  ],
  title: "Vibedgames developer docs",
};
