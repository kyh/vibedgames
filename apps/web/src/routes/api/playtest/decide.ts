import { handlePlaytestDecide } from "@repo/service/playtest/decide-handler";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";

const handler = (request: Request) => handlePlaytestDecide(request, getServerContext().decision);

export const Route = createFileRoute("/api/playtest/decide")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
