import type { QueryClient } from "@tanstack/react-query";
import { GlobalAlertDialog } from "@repo/ui/components/alert-dialog";
import { Toaster } from "@repo/ui/components/sonner";
import { TooltipProvider } from "@repo/ui/components/tooltip";
import { cn } from "cn";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import { NotFoundPage } from "@/components/site/not-found";
import { varyHeaders } from "@/lib/doc-route";
import { siteConfig } from "@/lib/site-config";
import { serializeJsonLd, siteGraph } from "@/lib/structured-data";

import appCss from "../styles/globals.css?url";

// No `orpc` here: the utils reach components through `ORPCProvider` (see
// lib/orpc.tsx). Carrying them in both channels means the next field lands in
// one and not the other.
interface RouterContext {
  queryClient: QueryClient;
}

const RootComponent = () => (
  <RootDocument>
    <Outlet />
  </RootDocument>
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  head: () => ({
    links: [
      { href: appCss, rel: "stylesheet" },
      { href: "/favicon/favicon-96x96.png", rel: "icon", sizes: "96x96", type: "image/png" },
      { href: "/favicon/favicon.svg", rel: "icon", type: "image/svg+xml" },
      { href: "/favicon/favicon.ico", rel: "shortcut icon" },
      { href: "/favicon/apple-touch-icon.png", rel: "apple-touch-icon", sizes: "180x180" },
      { href: "/favicon/site.webmanifest", rel: "manifest" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: siteConfig.name },
      { content: siteConfig.description, name: "description" },
      { content: siteConfig.name, property: "og:site_name" },
      { content: siteConfig.name, property: "og:title" },
      { content: siteConfig.description, property: "og:description" },
      { content: `${siteConfig.url}/og.jpg`, property: "og:image" },
      { content: "1200", property: "og:image:width" },
      { content: "630", property: "og:image:height" },
      { content: siteConfig.name, property: "og:image:alt" },
      { content: "website", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: `${siteConfig.url}/og.jpg`, name: "twitter:image" },
      { content: siteConfig.twitter, name: "twitter:creator" },
      { content: siteConfig.shortName, name: "apple-mobile-web-app-title" },
    ],
  }),
  // Site-wide `Vary: Accept`. Routes that negotiate markdown need it; routes
  // that do not are still safer with it, since a cache that keys on URL alone
  // could otherwise reuse one of their responses for a different Accept.
  headers: varyHeaders(),
  notFoundComponent: NotFoundPage,
});

/**
 * Canonical URL for the page being rendered.
 *
 * Derived from the pathname and never the search string, so the `?game=`
 * variants of `/` — which the router adds on its own via the search default —
 * all consolidate onto the apex URL instead of splitting the entity across a
 * dozen near-duplicate URLs.
 */
const useCanonical = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : "";
  return `${siteConfig.url}${path}`;
};

const RootDocument = ({ children }: { children: React.ReactNode }) => {
  const canonical = useCanonical();

  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
        <link rel="canonical" href={canonical} />
        {/* Server-rendered on purpose: a crawler that never runs JS still gets
            the identity graph. See `lib/structured-data.ts`. */}
        <script
          type="application/ld+json"
          // oxlint-disable-next-line react/no-danger -- JSON-LD is only readable to a crawler when it is inline text, and `serializeJsonLd` escapes `<` so no string can close the tag
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(siteGraph()) }}
        />
      </head>
      <body
        className={cn(
          "text-foreground bg-background bg-[url('/bg.webp')] bg-size-[10px] font-sans antialiased",
        )}
      >
        <TooltipProvider>
          {children}
          <Toaster position="bottom-center" />
          <GlobalAlertDialog />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
};
