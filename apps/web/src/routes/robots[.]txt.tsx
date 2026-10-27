import { createFileRoute } from "@tanstack/react-router";

import { siteConfig } from "@/lib/site-config";

// The same robots.txt on every site: open to every crawler, with Content
// Signals (https://contentsignals.org/) allowing search, AI input and training.
const body = [
  "User-agent: *",
  "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  "Allow: /",
  "",
  `Sitemap: ${siteConfig.url}/sitemap.xml`,
  "",
].join("\n");

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(body, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
