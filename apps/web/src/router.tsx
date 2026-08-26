import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { makeORPCClient, ORPCProvider } from "@/lib/orpc";
import { createQueryClient } from "@/lib/query-client";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = createQueryClient();
  const orpc = createTanstackQueryUtils(makeORPCClient());

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    Wrap: (props) => <ORPCProvider orpc={orpc} {...props} />,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
