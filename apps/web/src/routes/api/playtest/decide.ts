import { handlePlaytestDecide } from "@repo/service/playtest/decide-handler";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";

const handler = async (request: Request) =>
  await handlePlaytestDecide(request, getServerContext().decision);

export const Route = createFileRoute("/api/playtest/decide")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => await handler(request),
      POST: async ({ request }) => await handler(request),
    },
  },
});
