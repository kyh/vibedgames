import { createFileRoute } from "@tanstack/react-router";

import { siteConfig } from "@/lib/site-config";

// Public, crawlable apex pages. User games live on `{slug}.vibedgames.com`
// subdomains served by a separate worker and are not listed here.
const PATHS = ["/", "/discover", "/build", "/install"];

const body = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...PATHS.map((path) => `  <url><loc>${siteConfig.url}${path}</loc></url>`),
  "</urlset>",
  "",
].join("\n");

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(body, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
