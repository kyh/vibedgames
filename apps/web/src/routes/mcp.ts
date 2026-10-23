import { createFileRoute } from "@tanstack/react-router";

import { createRpcContext } from "@/auth/server";
import { handleMcpRequest } from "@/lib/mcp";

const handler = ({ request }: { request: Request }) => handleMcpRequest(request, createRpcContext);

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      ANY: handler,
    },
  },
});
