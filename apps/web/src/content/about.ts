import type { Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

export const aboutDoc: Doc = {
  path: "/about",
  title: "About Vibedgames",
  description:
    "Vibedgames is an agent-native platform for building, hosting and shipping browser games — the CLI, skills and infrastructure a coding agent needs to work like a game studio.",
  lead: [
    {
      kind: "p",
      text: "Vibedgames seeds a coding agent with the abilities of a full game studio. A person describes the game they want; their agent installs the `vg` CLI and the bundled skills, scaffolds the project, generates the art and audio, wires up real-time multiplayer, and ships the result to a public URL. There is no engine to learn, no server to rent, and no art pipeline to assemble.",
    },
    {
      kind: "p",
      text: 'The platform is built for that agent, not for a dashboard. Every command speaks `--json`, exits with deterministic codes, and returns errors that describe their own fix, because friction a person would shrug off — "now open this URL and click confirm" — stops an agent cold.',
    },
  ],
  sections: [
    {
      heading: "What the platform provides",
      blocks: [
        {
          kind: "ul",
          items: [
            "**Hosting** — `vg deploy` uploads a built game directory and serves it at `{slug}.vibedgames.com` on Cloudflare's edge, backed by R2 object storage. Deploys and hosting are free.",
            "**Multiplayer** — `@vibedgames/multiplayer` gives a game shared, host-authoritative state over WebSockets, backed by Cloudflare Durable Objects. Adding it is a hook and a room name.",
            "**Asset generation** — `vg generate` reaches a catalog of more than a thousand image, video, audio and 3D model endpoints, so sprites, tilesets, music and sound effects come out of the same terminal the game is built in.",
            "**Skills** — the game-design, engine, art-pipeline and shipping playbooks an agent loads to do the work well, installed with `npx vibedgames init` and published at [/.well-known/agent-skills/index.json](/.well-known/agent-skills/index.json).",
            "**Touch controls** — `@vibedgames/gamepad` adds an on-screen joystick and buttons so a desktop-built game is playable on a phone.",
          ],
        },
      ],
    },
    {
      heading: "How it is built",
      blocks: [
        {
          kind: "p",
          text: "The web app is a TanStack Start (React 19, Vite SSR) application running on Cloudflare Workers, with tRPC and Drizzle over a Cloudflare D1 database, better-auth for identity, PartyServer on Durable Objects for multiplayer, and R2 for deployed game bundles. Deployed games are treated as untrusted code: they run on their own subdomain, and session cookies are scoped to the apex domain so a game can never read them.",
        },
        {
          kind: "p",
          text: `The whole stack — web app, CLI, multiplayer package, example games and agent skills — is open source under the MIT license at [${siteConfig.repository}](${siteConfig.repository}).`,
        },
      ],
    },
    {
      heading: "Who runs it",
      blocks: [
        {
          kind: "p",
          text: `Vibedgames is built and maintained by ${siteConfig.author.name} and the open-source contributors to the repository. Questions, bug reports and feature requests are handled in public on GitHub — see [Contact](/contact).`,
        },
      ],
    },
    {
      heading: "Where to go next",
      blocks: [
        {
          kind: "ul",
          items: [
            "[Developer docs](/docs) — the CLI, the packages, the machine-readable endpoints.",
            "[Install guide](/install) — the one command that installs the skills and the CLI.",
            "[llms.txt](/llms.txt) — when an agent should reach for Vibedgames, and how to call it.",
            "[Discover](/discover) — games already shipped on the platform.",
          ],
        },
      ],
    },
  ],
};
