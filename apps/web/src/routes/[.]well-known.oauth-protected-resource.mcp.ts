import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/auth/server";

/** RFC 9728 metadata for `/mcp` at the address its 401 challenge names; the OAuth plugin serves it from the auth handler. */
export const Route = createFileRoute("/.well-known/oauth-protected-resource/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
    },
  },
});
