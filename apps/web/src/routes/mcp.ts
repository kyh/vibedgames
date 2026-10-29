import { createFileRoute } from "@tanstack/react-router";

import { createRpcContext } from "@/auth/server";
import { agentSkills } from "@/lib/agent-skills";
import { handleMcpRequest } from "@/lib/mcp";

const handler = ({ request }: { request: Request }) =>
  handleMcpRequest(request, (headers) => createRpcContext(headers, "mcp"), agentSkills);

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      ANY: handler,
    },
  },
});
