import type { Doc } from "@/lib/doc";
import { featuredGames, gameUrl } from "@/components/game/data";
import { siteConfig } from "@/lib/site-config";

export const discoverDoc: Doc = {
  path: "/discover",
  title: `Discover games on ${siteConfig.name}`,
  description: `Browser games built and shipped on ${siteConfig.name}, each playable in one click at its own subdomain.`,
  lead: [
    {
      kind: "p",
      text: "Every game below was built by a coding agent and deployed with a single command. They run in the browser with nothing to install, and each lives at its own `{slug}.vibedgames.com` subdomain.",
    },
  ],
  sections: [
    {
      heading: "Games",
      blocks: [
        {
          kind: "ul",
          items: featuredGames.map(
            (game) => `[${game.name}](${gameUrl(game.slug)}) — play at ${game.slug}.vibedgames.com`,
          ),
        },
      ],
    },
    {
      heading: "Ship your own",
      blocks: [
        {
          kind: "p",
          text: "Point your coding agent at [/build](/build) for the install prompt, or read [/docs](/docs) for the CLI and API surface. Deploys and hosting are free.",
        },
      ],
    },
  ],
};
