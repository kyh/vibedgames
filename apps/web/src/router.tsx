import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanstackRouter } from "@tanstack/react-router";
import { routerWithQueryClient } from "@tanstack/react-router-with-query";

import { routeTree } from "./routeTree.gen";
import { createQueryClient } from "./trpc/query-client";

export const createRouter = () => {
  const queryClient: QueryClient = createQueryClient();
  return routerWithQueryClient(
    createTanstackRouter({
      routeTree,
      context: { queryClient },
      defaultPreload: "intent",
      defaultErrorComponent: ({ error }) => (
        <div className="p-8">
          <p>Oh no, something went wrong... maybe refresh?</p>
          <pre className="text-xs opacity-60">{String(error)}</pre>
        </div>
      ),
    }),
    queryClient,
  );
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
