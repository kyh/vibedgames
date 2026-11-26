import { createFileRoute } from "@tanstack/react-router";

import { getCloudflareEnv } from "@/lib/cloudflare";

export const Route = createFileRoute("/.well-known/openai-apps-challenge")({
  server: {
    handlers: {
      GET: () => {
        const token = getCloudflareEnv().OPENAI_APPS_CHALLENGE;

        if (token === undefined || token === "") {
          return new Response("Not found", { status: 404 });
        }

        return new Response(token, {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
