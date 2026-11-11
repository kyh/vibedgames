import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/auth/server";

/** RFC 9728 metadata for `/mcp`, the resource MCP clients connect to; the OAuth plugin serves it from the auth handler. */
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
    },
  },
});
