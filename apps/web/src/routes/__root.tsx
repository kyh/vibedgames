import type { QueryClient } from "@tanstack/react-query";
import { GlobalAlertDialog } from "@repo/ui/components/alert-dialog";
import { Toaster } from "@repo/ui/components/sonner";
import { TooltipProvider } from "@repo/ui/components/tooltip";
import { cn } from "cn";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import { siteConfig } from "@/lib/site-config";

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
});

const RootDocument = ({ children }: { children: React.ReactNode }) => (
  <html lang="en" className="dark">
    <head>
      <HeadContent />
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
