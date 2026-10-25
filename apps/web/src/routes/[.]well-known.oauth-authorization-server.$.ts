import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/auth/server";

/** RFC 8414 authorization-server metadata at its path-inserted address (`/api/auth` is the issuer's path); the OAuth plugin serves it from the auth handler. */
export const Route = createFileRoute("/.well-known/oauth-authorization-server/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
    },
  },
});
