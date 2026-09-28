import { createFileRoute } from "@tanstack/react-router";

import { REST_PREFIX } from "@/lib/orpc-handler";
import { siteConfig } from "@/lib/site-config";

const { url } = siteConfig;

/** RFC 9727 API catalog, as an RFC 9264 linkset. */
const linkset = {
  linkset: [
    {
      anchor: `${url}${REST_PREFIX}`,
      "service-desc": [{ href: `${url}/openapi.json`, type: "application/openapi+json" }],
      "service-doc": [{ href: `${url}/docs`, type: "text/html" }],
    },
  ],
};

export const Route = createFileRoute("/.well-known/api-catalog")({
  server: {
    handlers: {
      GET: () =>
        Response.json(linkset, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type":
              'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
          },
        }),
    },
  },
});
