import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/auth/server";

/** RFC 8414 metadata for the /api/auth issuer, served by the better-auth MCP plugin. */
export const Route = createFileRoute("/.well-known/oauth-authorization-server/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
    },
  },
});
