import { z } from "zod";

import { listMcpTools } from "./server";

const toolCall = z.object({
  method: z.literal("tools/call"),
  params: z.object({ name: z.string() }),
});

const accountTools = new Set(listMcpTools().map((tool) => tool.name));

/**
 * Whether an anonymous MCP request has to be turned away with a 401.
 *
 * The endpoint serves discovery (initialize, tools/list, the public catalog
 * tools) to anyone, and asks for a credential only when a call reaches an
 * account tool. A 401 at that point is what MCP clients treat as "sign in
 * now", so authentication happens when it is needed rather than up front.
 */
export const requiresCredential = async (request: Request): Promise<boolean> => {
  let body: z.infer<typeof toolCall>;
  try {
    body = toolCall.parse(await request.clone().json());
  } catch {
    return false;
  }
  return accountTools.has(body.params.name);
};
