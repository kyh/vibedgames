import { handlePlaytestDecide } from "@repo/api/playtest/decide-handler";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";

/**
 * The in-page playtester's endpoint. Cross-origin by design and cookie-blind
 * by design — see `handlePlaytestDecide` for why it is not an oRPC route.
 */
const handler = (request: Request): Promise<Response> =>
  handlePlaytestDecide(request, getServerContext().decision);

export const Route = createFileRoute("/api/playtest/decide")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
