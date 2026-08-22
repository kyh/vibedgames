import { createFileRoute } from "@tanstack/react-router";

import { SITEMAP_PATHS } from "@/content/site-map";
import { siteConfig } from "@/lib/site-config";

const body = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...SITEMAP_PATHS.map((path) => `  <url><loc>${siteConfig.url}${path}</loc></url>`),
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
