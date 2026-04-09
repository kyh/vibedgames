import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import { toast } from "@repo/ui/toast";

import { makeTRPCClient, TRPCProvider } from "@/lib/trpc";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
      },
      mutations: {
        onSuccess: async () => {
          await queryClient.invalidateQueries();
        },
        onError: (error) => {
          toast.error(error.message);
        },
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) => query.state.status === "pending" || query.state.status === "success",
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
  });
  const trpcClient = makeTRPCClient();
  const trpc = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient,
  });

  const router = createRouter({
    routeTree,
    context: { queryClient, trpc },
    defaultPreload: "intent",
    Wrap: (props) => (
      <TRPCProvider
        trpcClient={trpcClient}
        queryClient={queryClient}
        {...props}
      />
    ),
  });
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
