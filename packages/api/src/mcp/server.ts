import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { AnyProcedure, AnySchema } from "@orpc/server";
import type { ORPCContext } from "../orpc";
import { McpServer } from "@modelcontextprotocol/server";
import { getOpenAPIMeta } from "@orpc/openapi";
import { call, ORPCError, Procedure, walkProcedureContractsSync } from "@orpc/server";

import { appRouter } from "../root-router";
import { getMcpToolMeta } from "./tool-meta";

export interface McpTool {
  name: string;
  path: string[];
  title: string;
  description: string;
  access: "read" | "write" | "destructive";
}

/** The procedure path as a snake_case tool name: `deploy.getSource` → `deploy_get_source`. */
const toolName = (path: string[], override: string | undefined): string =>
  override ??
  path.map((segment) => segment.replaceAll(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`)).join("_");

// Every input schema here is zod, which implements Standard JSON Schema; the
// guard exists so a non-zod schema fails loudly instead of advertising `{}`.
const hasJsonSchema = (schema: AnySchema): schema is AnySchema & StandardSchemaWithJSON =>
  "jsonSchema" in schema["~standard"];

interface ExposedProcedure {
  tool: McpTool;
  procedure: AnyProcedure;
}

const collectTools = (): ExposedProcedure[] => {
  const exposed: ExposedProcedure[] = [];
  walkProcedureContractsSync(appRouter, (procedure, path) => {
    const meta = getMcpToolMeta(procedure);
    if (!(procedure instanceof Procedure) || !meta?.expose) {
      return;
    }
    const doc = getOpenAPIMeta(procedure);
    exposed.push({
      procedure,
      tool: {
        access: meta.access,
        description: doc?.description ?? doc?.summary ?? meta.title,
        name: toolName(path, meta.name),
        path,
        title: meta.title,
      },
    });
  });
  return exposed;
};

/** The MCP tools the router exposes, in router order. */
export const listMcpTools = (): McpTool[] => collectTools().map(({ tool }) => tool);

// A tool advertises one JSON Schema, so a procedure that stacks several
// `.input()` schemas can't be a tool until they are merged into one.
const singleInputSchema = (
  tool: McpTool,
  procedure: AnyProcedure,
): StandardSchemaWithJSON | undefined => {
  const schemas = procedure["~orpc"].inputSchemas ?? [];
  const [schema] = schemas;
  if (schemas.length > 1 || (schema !== undefined && !hasJsonSchema(schema))) {
    throw new Error(`${tool.path.join(".")}: an MCP tool needs exactly one JSON-Schema input.`);
  }
  return schema;
};

const annotationsFor = (access: McpTool["access"]) => ({
  destructiveHint: access === "destructive",
  idempotentHint: access === "read",
  // Every tool reaches the vibedgames API or a model provider behind it.
  openWorldHint: true,
  readOnlyHint: access === "read",
});

const errorResult = (message: string) => ({
  content: [{ text: message, type: "text" as const }],
  isError: true,
});

export interface CreateMcpServerOptions {
  version: string;
  instructions?: string;
  /** Resolved per tool call, so listing tools needs no session or database. */
  resolveContext: () => Promise<ORPCContext>;
}

/**
 * An MCP server whose tools are the router's procedures, called in-process
 * with the same context, validation and credit gates the HTTP API applies.
 */
export const createMcpServer = ({
  version,
  instructions,
  resolveContext,
}: CreateMcpServerOptions): McpServer => {
  const server = new McpServer(
    { name: "vibedgames", title: "vibedgames", version },
    { instructions },
  );

  for (const { tool, procedure } of collectTools()) {
    const inputSchema = singleInputSchema(tool, procedure);
    server.registerTool(
      tool.name,
      {
        annotations: annotationsFor(tool.access),
        description: tool.description,
        inputSchema,
        title: tool.title,
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `call` parses it with the procedure's own input schema.
      async (args: unknown) => {
        try {
          const output = await call(procedure, args, { context: await resolveContext() });
          return { content: [{ text: JSON.stringify(output ?? null), type: "text" as const }] };
        } catch (error) {
          // Domain failures (validation, credits, auth) go back to the model as
          // tool errors it can read and act on; anything else is a server bug.
          if (error instanceof ORPCError) {
            return errorResult(`${error.code}: ${error.message}`);
          }
          throw error;
        }
      },
    );
  }

  return server;
};
