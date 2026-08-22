import { createFileRoute, notFound } from "@tanstack/react-router";

import { NotFoundPage } from "@/components/site/not-found";
import { notFoundMarkdown } from "@/content/not-found";
import {
  MARKDOWN,
  markdownResponse,
  negotiate,
  notAcceptableResponse,
} from "@/lib/content-negotiation";
import { varyHeaders } from "@/lib/doc-route";

/**
 * Catch-all for paths nothing else matches.
 *
 * The status was already 404 without this route; what it adds is a body worth
 * reading. An agent that hits a dead URL gets either the markdown recovery
 * note (sitemap, llms.txt, docs) or the same content as an HTML page — never a
 * bare "Not Found", and never a 200 with the app shell.
 */
export const Route = createFileRoute("/$")({
  server: {
    handlers: {
      GET: ({ request, next }) => {
        const result = negotiate(request.headers.get("accept"));
        if (result.kind === "not-acceptable") return notAcceptableResponse(request);
        if (result.kind === "match" && result.type === MARKDOWN) {
          return markdownResponse(notFoundMarkdown(new URL(request.url).pathname), {
            status: 404,
            headers: { "Cache-Control": "no-store" },
          });
        }
        return next();
      },
    },
  },
  headers: varyHeaders(),
  loader: () => {
    // Renders the root `notFoundComponent` and, in SSR, sets the 404 status.
    throw notFound();
  },
  component: () => null,
});
