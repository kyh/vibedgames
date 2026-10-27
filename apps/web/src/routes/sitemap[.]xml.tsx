import { createFileRoute } from "@tanstack/react-router";

import { SITEMAP_PAGES } from "@/content/site-map";
import { siteConfig } from "@/lib/site-config";

const body = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...SITEMAP_PAGES.map(
    ({ path, lastModified }) =>
      `  <url><loc>${path === "/" ? siteConfig.url : `${siteConfig.url}${path}`}</loc><lastmod>${lastModified}</lastmod></url>`,
  ),
  "</urlset>",
  "",
].join("\n");

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(body, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/xml; charset=utf-8",
          },
        }),
    },
  },
});
