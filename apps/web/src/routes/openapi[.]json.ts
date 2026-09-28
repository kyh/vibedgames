import { createFileRoute } from "@tanstack/react-router";

import { generateOpenAPISpec } from "@/lib/openapi-spec";

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(await generateOpenAPISpec(), {
          headers: {
            // A public description, safe to hand to any origin's API tooling.
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
