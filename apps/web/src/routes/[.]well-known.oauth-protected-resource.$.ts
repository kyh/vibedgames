import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/auth/server";

/** RFC 9728 protected resource metadata for /mcp, path-suffixed form, served by the better-auth MCP plugin. */
export const Route = createFileRoute("/.well-known/oauth-protected-resource/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
    },
  },
});
