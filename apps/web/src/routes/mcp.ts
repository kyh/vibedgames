import { createFileRoute } from "@tanstack/react-router";
import { mcpApps } from "virtual:mcp-apps";

import { createRpcContext } from "@/auth/server";
import { agentSkills } from "@/lib/agent-skills";
import { handleMcpRequest } from "@/lib/mcp";

const handler = async ({ request }: { request: Request }) =>
  await handleMcpRequest(
    request,
    async (headers) => await createRpcContext(headers, "mcp"),
    agentSkills,
    mcpApps,
  );

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      ANY: handler,
    },
  },
});
