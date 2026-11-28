import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import { featuredGames, gameUrl } from "@/components/game/data";
import type { BrowseInput, BrowseOutput } from "@/lib/mcp-gallery-schema";
import { GALLERY_URI } from "@/lib/mcp-gallery-schema";
import { siteConfig } from "@/lib/site-config";

const matches = (haystack: string, words: readonly string[]) => {
  const text = haystack.toLowerCase();

  return words.every((word) => text.includes(word));
};

/** The site's featured games, filtered by `query` words (all must match) and `tag`. */
export const browseGames = ({ query, tag }: BrowseInput) => {
  const words = (query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

  const games = featuredGames
    .filter((game) => tag === undefined || game.tags.includes(tag))
    .filter((game) => matches([game.name, game.description, ...game.tags].join(" "), words))
    .map((game) => ({
      coverUrl: `${siteConfig.url}${game.preview}`,
      description: game.description,
      name: game.name,
      playUrl: gameUrl(game.slug),
      portraitUrl:
        game.previewPortrait === undefined ? undefined : `${siteConfig.url}${game.previewPortrait}`,
      slug: game.slug,
      tags: [...game.tags],
    }));

  return { galleryUrl: `${siteConfig.url}/discover`, games } satisfies BrowseOutput;
};

/** The views the MCP Apps extension renders, each one self-contained HTML document. */
export interface McpApps {
  gallery: string;
}

const galleryMeta = {
  ui: {
    csp: { connectDomains: [], frameDomains: [], resourceDomains: [siteConfig.url] },
    prefersBorder: true,
  },
};

/**
 * Serves the gallery view as a `ui://` resource for MCP Apps hosts. It is
 * registered whatever the client declared: the server is stateless and never
 * sees `initialize`, and a host without the extension just never reads it.
 */
export const registerApps = (server: McpServer, apps: McpApps) => {
  registerAppResource(
    server,
    "Game gallery",
    GALLERY_URI,
    { _meta: galleryMeta, description: "The vibedgames game gallery, as an interactive view." },
    () => ({
      contents: [
        { _meta: galleryMeta, mimeType: RESOURCE_MIME_TYPE, text: apps.gallery, uri: GALLERY_URI },
      ],
    }),
  );
};
