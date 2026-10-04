import type { McpServer } from "@modelcontextprotocol/server";
import type { ORPCContext } from "@repo/service/orpc";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { MAX_RPC_BODY_BYTES } from "@repo/service/generate/limits";
import { requiresCredential } from "@repo/service/mcp/auth-gate";
import { createMcpServer } from "@repo/service/mcp/server";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { GameEntry, SkillEntry } from "@/lib/mcp-catalog";
import { createRpcContext } from "@/auth/server";
import { featuredGames } from "@/components/game/data";
import { getAgentSkill, getSkillIndex } from "@/lib/agent-skills";
import installMd from "@/lib/install.md?raw";
import { searchGames, searchSkills, serverInstructions } from "@/lib/mcp-catalog";

const readOnly = { openWorldHint: false, readOnlyHint: true };

const text = (value: string) => ({ content: [{ text: value, type: "text" as const }] });

const json = (value: GameEntry[] | SkillEntry[]) => text(JSON.stringify(value, null, 2));

/** The public half of the server: install steps, skills and games, no account needed. */
const registerCatalogTools = (server: McpServer): void => {
  server.registerTool(
    "get_started",
    {
      annotations: readOnly,
      description:
        "How to install vibedgames: the one command that installs the vg CLI and the game-studio skills, and what to run next.",
      title: "Get started",
    },
    () => text(installMd),
  );

  server.registerTool(
    "list_skills",
    {
      annotations: readOnly,
      description:
        "List the bundled game-studio skills (slug and one-line description). Pass a query to rank by relevance.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Free text, e.g. "pixel art walk cycle" or "multiplayer lobby"'),
      }),
      title: "List skills",
    },
    async ({ query }) => json(searchSkills(await getSkillIndex(), query)),
  );

  server.registerTool(
    "get_skill",
    {
      annotations: readOnly,
      description:
        "Read one skill's full SKILL.md: the instructions and exact vg commands for that job.",
      inputSchema: z.object({ slug: z.string().describe("Slug from list_skills") }),
      title: "Get skill",
    },
    ({ slug }) => {
      const skill = getAgentSkill(slug);
      if (!skill) {
        return {
          ...text(`Skill not found: ${slug}. Call list_skills for valid slugs.`),
          isError: true,
        };
      }
      return text(skill.content);
    },
  );

  server.registerTool(
    "search_games",
    {
      annotations: readOnly,
      description:
        "Search games shipped on vibedgames by name or what they play like. An empty query lists every featured game.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        query: z.string().optional().describe('Free text, e.g. "multiplayer shooter" or "webcam"'),
      }),
      title: "Search games",
    },
    ({ query, limit }) => json(searchGames(featuredGames, { limit, query })),
  );
};

const unauthorized = (description: string): Response =>
  Response.json(
    { error: "invalid_token", error_description: description },
    {
      headers: {
        "WWW-Authenticate": `Bearer realm="vibedgames", error="invalid_token", error_description="${description}"`,
      },
      status: 401,
    },
  );

/**
 * Stateless: a fresh server per request, so no Durable Object or session store.
 *
 * Credentials come from the Authorization / x-api-key headers only. Cookies are
 * dropped so a page the user has open can't drive their account through this
 * endpoint, and an MCP session counts as automation, like an API key.
 */
const serveMcp = async (request: Request): Promise<Response> => {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const hasCredential = headers.has("authorization") || headers.has("x-api-key");

  if (!hasCredential && (await requiresCredential(request))) {
    return unauthorized("Sign in, or send a vibedgames API key as a Bearer token.");
  }

  let context: Promise<ORPCContext> | undefined;
  const resolveContext = () => {
    context ??= createRpcContext(headers);
    return context;
  };
  if (hasCredential) {
    const { session } = await resolveContext();
    if (!session) {
      return unauthorized("The credential is invalid or expired.");
    }
  }

  const handler = createMcpHandler(
    () => {
      const server = createMcpServer({
        instructions: serverInstructions,
        resolveContext,
        version: "1.1.0",
      });
      registerCatalogTools(server);
      return server;
    },
    { maxRequestBodySize: MAX_RPC_BODY_BYTES },
  );
  return handler.fetch(request);
};

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      ANY: ({ request }) => serveMcp(request),
    },
  },
});
