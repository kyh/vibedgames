import { createFileRoute } from "@tanstack/react-router";

import { PageClient } from "~/app/[[...gameId]]/page.client";

export const Route = createFileRoute("/$gameId")({
  component: () => <PageClient />,
  loader: async ({ params, context }) => {
    // Optionally prefetch the build via tRPC here once a server-side caller
    // exists. For now the client `useQuery` in PageClient handles fetching.
    return { gameId: params.gameId };
  },
});
