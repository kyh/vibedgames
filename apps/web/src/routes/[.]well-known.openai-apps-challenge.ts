import { createFileRoute } from "@tanstack/react-router";

import { getCloudflareEnv } from "@/lib/cloudflare";

// OpenAI's plugin directory proves we own the /mcp server's domain by fetching the token its
// portal issues. Until OPENAI_APPS_CHALLENGE is set there is nothing to prove, so 404.
export const Route = createFileRoute("/.well-known/openai-apps-challenge")({
  server: {
    handlers: {
      GET: () => {
        const token = getCloudflareEnv().OPENAI_APPS_CHALLENGE;
        if (!token) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(token, {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
