import type { Doc } from "@/lib/doc";
import { featuredGames, gameUrl } from "@/components/game/data";
import { siteConfig } from "@/lib/site-config";

/**
 * The text representation of `/`.
 *
 * `/` is a full-bleed game canvas — with JavaScript off it is an empty
 * document, and with JavaScript on it announces nothing to a screen reader.
 * This doc is what fills that gap: rendered into the SSR HTML by
 * `components/site/site-summary`, and served verbatim as markdown to a client
 * that negotiates `Accept: text/markdown`.
 */
export const homeDoc: Doc = {
  path: "/",
  title: `${siteConfig.name} — a game studio for your agent`,
  description: siteConfig.summary,
  lead: [
    {
      kind: "p",
      text: "A person describes the game they want; their coding agent installs the `vg` CLI and the bundled game-studio skills, scaffolds the project, generates the sprites, music and sound effects, adds real-time multiplayer, and deploys the result to its own subdomain. There is no engine to learn, no server to rent, and no art pipeline to assemble. Deploys, hosting and multiplayer are free; only asset generation is metered.",
    },
    {
      kind: "p",
      text: "This page embeds one of the games already shipped on the platform. Use the game switcher to change which one, Discover to browse them all, and Build to copy the prompt that installs everything into your agent.",
    },
  ],
  sections: [
    {
      heading: "Get started",
      blocks: [
        {
          kind: "p",
          text: "Paste this into your coding agent, or run the install directly:",
        },
        { kind: "code", lang: "sh", code: "npx vibedgames init" },
        {
          kind: "p",
          text: "Agents: read [/llms.txt](/llms.txt) for when to reach for this platform and which command to run first, and [/docs](/docs) for the full command and API surface.",
        },
      ],
    },
    {
      heading: `Games on ${siteConfig.name}`,
      blocks: [
        {
          kind: "ul",
          items: featuredGames.map((game) => `[${game.name}](${gameUrl(game.slug)})`),
        },
      ],
    },
    {
      heading: "Elsewhere on this site",
      blocks: [
        {
          kind: "ul",
          items: [
            "[Discover](/discover) — every game shipped on the platform.",
            "[Build](/build) — the prompt that installs the CLI and skills into your agent.",
            "[Developer docs](/docs) — the CLI, the API, the packages, the endpoints.",
            "[About](/about) — what Vibedgames is and how it is built.",
            "[Contact](/contact) — support, security and press channels.",
            "[Privacy](/privacy) — what is stored and how to have it deleted.",
          ],
        },
      ],
    },
  ],
};
