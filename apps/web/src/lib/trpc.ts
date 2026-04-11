import type { AppRouter } from "@repo/api";
import { appRouter, createTRPCContext } from "@repo/api";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  createTRPCClient,
  httpBatchStreamLink,
  loggerLink,
  unstable_localLink,
} from "@trpc/client";
import { createTRPCContext as createReactTRPCContext } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import { getServerContext } from "@/auth/server";
import { getBaseUrl } from "@/lib/url";

export const makeTRPCClient = createIsomorphicFn()
  .server(() => {
    return createTRPCClient<AppRouter>({
      links: [
        unstable_localLink({
          router: appRouter,
          transformer: SuperJSON,
          createContext: () => {
            // Build server context per tRPC call (not at client creation)
            // because Cloudflare bindings are only available inside a request.
            const { db, auth, productionUrl } = getServerContext();
            const headers = new Headers(getRequestHeaders());
            headers.set("x-trpc-source", "tanstack-start-server");
            return createTRPCContext({
              headers,
              db,
              auth,
              productionURL: productionUrl,
            });
          },
        }),
      ],
    });
  })
  .client(() => {
    return createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            import.meta.env.DEV ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        httpBatchStreamLink({
          transformer: SuperJSON,
          url: getBaseUrl() + "/api/trpc",
          headers() {
            const headers = new Headers();
            headers.set("x-trpc-source", "tanstack-start-client");
            return headers;
          },
        }),
      ],
    });
  });

export const { useTRPC, TRPCProvider } = createReactTRPCContext<AppRouter>();
