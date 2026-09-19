import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { makeORPCClient, ORPCProvider } from "@/lib/orpc";
import { createQueryClient } from "@/lib/query-client";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = createQueryClient();
  const orpc = createTanstackQueryUtils(makeORPCClient());

  const router = createRouter({
    Wrap: (props) => <ORPCProvider orpc={orpc} {...props} />,
    context: { queryClient },
    defaultPreload: "intent",
    routeTree,
  });
  setupRouterSsrQueryIntegration({ queryClient, router });

  return router;
};
