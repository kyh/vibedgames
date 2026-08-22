import type { QueryClient } from "@tanstack/react-query";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { GlobalAlertDialog } from "@repo/ui/components/alert-dialog";
import { Toaster } from "@repo/ui/components/sonner";
import { TooltipProvider } from "@repo/ui/components/tooltip";
import { cn } from "@repo/ui/lib/utils";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import type { AppRouter } from "@repo/api";
import { NotFoundPage } from "@/components/site/not-found";
import { varyHeaders } from "@/lib/doc-route";
import { siteConfig } from "@/lib/site-config";
import { serializeJsonLd, siteGraph } from "@/lib/structured-data";

import appCss from "../styles/globals.css?url";

interface RouterContext {
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<AppRouter>;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: siteConfig.name },
      { name: "description", content: siteConfig.description },
      { property: "og:site_name", content: siteConfig.name },
      { property: "og:title", content: siteConfig.name },
      { property: "og:description", content: siteConfig.description },
      { property: "og:image", content: `${siteConfig.url}/og.jpg` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: siteConfig.name },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${siteConfig.url}/og.jpg` },
      { name: "twitter:creator", content: siteConfig.twitter },
      { name: "apple-mobile-web-app-title", content: siteConfig.shortName },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", sizes: "96x96", href: "/favicon/favicon-96x96.png" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon/favicon.svg" },
      { rel: "shortcut icon", href: "/favicon/favicon.ico" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/favicon/apple-touch-icon.png" },
      { rel: "manifest", href: "/favicon/site.webmanifest" },
    ],
  }),
  // Site-wide `Vary: Accept`. Routes that negotiate markdown need it; routes
  // that do not are still safer with it, since a cache that keys on URL alone
  // could otherwise reuse one of their responses for a different Accept.
  headers: varyHeaders(),
  component: RootComponent,
  notFoundComponent: NotFoundPage,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

/**
 * Canonical URL for the page being rendered.
 *
 * Derived from the pathname and never the search string, so the `?game=`
 * variants of `/` — which the router adds on its own via the search default —
 * all consolidate onto the apex URL instead of splitting the entity across a
 * dozen near-duplicate URLs.
 */
function useCanonical() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : "";
  return `${siteConfig.url}${path}`;
}

function RootDocument({ children }: { children: React.ReactNode }) {
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
}
