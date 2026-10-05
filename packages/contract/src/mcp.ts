import { defineMeta } from "@orpc/contract";

/**
 * Whether a procedure is an MCP tool, declared in its contract beside its
 * OpenAPI meta so the MCP server and the oRPC API can't drift apart. Every
 * procedure must carry one or the other (@repo/service's `mcp/server.test.ts`
 * walks the router and fails on one that carries neither), so a new procedure
 * is never left off — or put on — the MCP surface by accident.
 * `sessionOnlyBase` and everything built on it declare `notMcpTool`.
 *
 * `access` maps onto the tool annotations the Claude and ChatGPT directories
 * review: `read` has no side effects, `write` creates or changes something,
 * `destructive` removes or overwrites something that can't be recovered.
 */
export type McpToolMeta =
  | {
      expose: true;
      title: string;
      access: "read" | "write" | "destructive";
      /** Tool name when the dotted procedure path reads badly as one. */
      name?: string;
    }
  | { expose: false; reason: string };

const [mcpMeta, getMcpToolMeta] = defineMeta(
  "mcp",
  (incoming: McpToolMeta): McpToolMeta => incoming,
);

/** Read by @repo/service's MCP server; nothing else looks at it. */
export { getMcpToolMeta };

export const mcpTool = (tool: Omit<Extract<McpToolMeta, { expose: true }>, "expose">) =>
  mcpMeta({ expose: true, ...tool });

export const notMcpTool = (reason: string) => mcpMeta({ expose: false, reason });
