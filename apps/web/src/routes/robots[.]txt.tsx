import { createFileRoute } from "@tanstack/react-router";

import { siteConfig } from "@/lib/site-config";

// Open policy: vibedgames is agent-native, so AI crawlers are welcome to
// crawl, index, use pages as model input, and train. Content signals per
// https://contentsignals.org/ ; crawler rules per RFC 9309.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "Google-Extended",
  "PerplexityBot",
  "CCBot",
];

const DISALLOW = ["/admin", "/settings", "/auth", "/api"];

const body = [
  "# https://www.rfc-editor.org/rfc/rfc9309",
  "",
  "User-agent: *",
  "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  "Allow: /",
  ...DISALLOW.map((path) => `Disallow: ${path}`),
  "",
  "# AI crawlers — explicit allow (policy: open)",
  ...AI_CRAWLERS.map((agent) => `User-agent: ${agent}`),
  "Allow: /",
  ...DISALLOW.map((path) => `Disallow: ${path}`),
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
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
