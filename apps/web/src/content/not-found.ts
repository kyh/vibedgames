import type { Doc } from "@/lib/doc";
import { docToMarkdown } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/**
 * The 404 body.
 *
 * A bare "Not Found" tells an agent nothing except that it failed. This one
 * says what the path was, and hands over the three files that let it recover
 * on its own — llms.txt for orientation, the sitemap for what exists, and the
 * docs index for the developer surface.
 */
export function notFoundDoc(pathname?: string): Doc {
  const requested = pathname && pathname !== "/" ? pathname : null;
  return {
    path: "/404",
    title: "404 — page not found",
    description: requested
      ? `There is no page at ${requested} on ${siteConfig.url}.`
      : `That page does not exist on ${siteConfig.url}.`,
    lead: [
      {
        kind: "p",
        text: "The URL is wrong, or the page has moved. Nothing on this domain is generated on demand, so a path that 404s here does not exist — retrying it will not help.",
      },
    ],
    sections: [
      {
        heading: "Where to look next",
        blocks: [
          {
            kind: "ul",
            items: [
              "[/llms.txt](/llms.txt) — what Vibedgames is for, when to use it, and the first command to run.",
              "[/sitemap.xml](/sitemap.xml) — every page on this domain.",
              "[/docs](/docs) — the CLI, the API, the packages and the machine-readable endpoints.",
              "[/install](/install) — install the CLI and the agent skills.",
              "[/discover](/discover) — games shipped on the platform.",
              "[/about](/about) · [/contact](/contact) · [/privacy](/privacy) — who runs this and how to reach them.",
            ],
          },
          {
            kind: "p",
            text: "Looking for a game? Games live on their own subdomains, at `{slug}.vibedgames.com` — not under a path on this one.",
          },
        ],
      },
    ],
  };
}

export const notFoundMarkdown = (pathname?: string) => docToMarkdown(notFoundDoc(pathname));
