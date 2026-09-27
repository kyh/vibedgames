import { createFileRoute } from "@tanstack/react-router";

import { llmsTxt } from "@/content/llms";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(llmsTxt, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "text/markdown; charset=utf-8",
          },
        }),
    },
  },
});
