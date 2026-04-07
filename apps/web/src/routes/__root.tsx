import type { QueryClient } from "@tanstack/react-query";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { GlobalAlertDialog } from "@repo/ui/alert-dialog";
import { GlobalToaster } from "@repo/ui/toast";
import { TooltipProvider } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import type { AppRouter } from "@repo/api";
import { siteConfig } from "~/lib/site-config";


import appCss from "../app/styles/globals.css?url";

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
      { property: "og:title", content: siteConfig.name },
      { property: "og:description", content: siteConfig.description },
      { property: "og:image", content: `${siteConfig.url}/og.jpg` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
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
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body
        className={cn(
          "text-foreground bg-background bg-[url('https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/bg.png')] bg-size-[10px] font-mono antialiased",
        )}
      >
        <TooltipProvider>
          {children}
          <GlobalToaster />
          <GlobalAlertDialog />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
