import type { AppRouter } from "@repo/api";
import type { RouterClient } from "@orpc/server";
import type { RouterUtils } from "@orpc/tanstack-query";
import { appRouter, createORPCContext } from "@repo/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createContext, use } from "react";

import { getServerContext } from "@/auth/server";

export const makeORPCClient = createIsomorphicFn()
  .server((): RouterClient<AppRouter> => {
    return createRouterClient(appRouter, {
      // Build server context per oRPC call (not at client creation)
      // because Cloudflare bindings are only available inside a request.
      context: () => {
        const { db, auth, productionUrl, r2 } = getServerContext();
        return createORPCContext({
          headers: new Headers(getRequestHeaders()),
          db,
          auth,
          productionURL: productionUrl,
          r2,
        });
      },
    });
  })
  .client((): RouterClient<AppRouter> => {
    const link = new RPCLink({
      url: `${window.location.origin}/api/orpc`,
      plugins: [new SimpleCsrfProtectionLinkPlugin()],
    });
    return createORPCClient(link);
  });

/**
 * Typesafe query/mutation option builders for TanStack Query — e.g.
 * `useQuery(orpc.deploy.list.queryOptions())`.
 *
 * Provided through React context rather than init's module export: the
 * server-side client is per-request (Cloudflare bindings), so the utils
 * are built in `getRouter()` and threaded down.
 */
export type ORPCUtils = RouterUtils<RouterClient<AppRouter>>;

const ORPCContext = createContext<ORPCUtils | undefined>(undefined);

export function ORPCProvider(props: { orpc: ORPCUtils; children: React.ReactNode }) {
  return <ORPCContext.Provider value={props.orpc}>{props.children}</ORPCContext.Provider>;
}

export function useORPC(): ORPCUtils {
  const orpc = use(ORPCContext);
  if (!orpc) {
    throw new Error("useORPC must be used within an ORPCProvider");
  }
  return orpc;
}
