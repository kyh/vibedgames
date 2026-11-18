import type { ContractClient } from "@repo/contract";
import type { RouterUtils } from "@orpc/tanstack-query";
import { appRouter } from "@repo/service";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { BatchLinkPlugin } from "@orpc/client/plugins";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createContext, use } from "react";

import { createRpcContext } from "@/auth/server";

export const makeORPCClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(appRouter, {
      context: () => createRpcContext(new Headers(getRequestHeaders())),
    }),
  )
  .client(() => {
    const link = new RPCLink({
      plugins: [new BatchLinkPlugin({ groups: [{ condition: () => true, context: {} }] })],
      url: "/api/orpc",
    });

    return createORPCClient(link) satisfies ContractClient;
  });

/**
 * Typesafe query/mutation option builders for TanStack Query — e.g.
 * `useQuery(orpc.deploy.list.queryOptions())`.
 *
 * Provided through React context rather than init's module export: the
 * server-side client is per-request (Cloudflare bindings), so the utils
 * are built in `getRouter()` and threaded down.
 */
export type ORPCUtils = RouterUtils<ContractClient>;

const ORPCContext = createContext<ORPCUtils | undefined>(undefined);

export const ORPCProvider = (props: { orpc: ORPCUtils; children: React.ReactNode }) => (
  <ORPCContext.Provider value={props.orpc}>{props.children}</ORPCContext.Provider>
);

export const useORPC = () => {
  const orpc = use(ORPCContext);

  if (!orpc) {
    throw new Error("useORPC must be used within an ORPCProvider");
  }

  return orpc;
};
