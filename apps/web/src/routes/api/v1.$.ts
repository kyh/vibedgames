import { createFileRoute } from "@tanstack/react-router";

import { createRpcContext } from "@/auth/server";
import { handleRestRequest } from "@/lib/orpc-handler";

const handler = async (req: Request) =>
  await handleRestRequest(req, await createRpcContext(req.headers));

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => await handler(request),
    },
  },
});
