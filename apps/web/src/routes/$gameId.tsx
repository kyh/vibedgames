import { createFileRoute } from "@tanstack/react-router";

import { PageClient } from "@/components/game/page";

export const Route = createFileRoute("/$gameId")({
  component: () => <PageClient />,
  loader: async ({ params, context }) => {
    // Prefetch build data so the client doesn't need a loading state.
    // Swallow errors — the component handles unauthenticated/missing builds.
    await context.queryClient
      .ensureQueryData(
        context.trpc.localGame.getBuild.queryOptions({
          buildId: params.gameId,
        }),
      )
      .catch(() => {});
    return { gameId: params.gameId };
  },
});
