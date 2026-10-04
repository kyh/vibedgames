import assert from "node:assert/strict";
import { test } from "node:test";
import { getRequiredCredential } from "@repo/contract/base";
import { getMcpToolMeta } from "@repo/contract/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { walkProcedureContractsSync } from "@orpc/server";
import { z } from "zod";

import { appRouter } from "../root-router";
import { createMcpServer, listMcpTools } from "./server";

test("every procedure declares whether it is an MCP tool, and each tool is served", () => {
  const undeclared: string[] = [];
  const declaredTools: string[] = [];
  const lazyRouters = walkProcedureContractsSync(appRouter, (procedure, path) => {
    const meta = getMcpToolMeta(procedure);
    if (meta === undefined) {
      undeclared.push(path.join("."));
    } else if (meta.expose) {
      declaredTools.push(path.join("."));
    }
  });
  assert.deepEqual(lazyRouters, [], "a lazy router's procedures would go unchecked");
  assert.deepEqual(
    undeclared,
    [],
    "tag each in its @repo/contract contract with mcpTool(...) or notMcpTool(reason)",
  );
  assert.ok(declaredTools.includes("generate.submit"));
  assert.deepEqual(
    listMcpTools().map((tool) => tool.path.join(".")),
    declaredTools,
  );
});

// `/mcp` asks an anonymous caller of any router tool for a credential, and a
// session-only procedure would take an MCP client's `vg login` token as an
// interactive login: so a tool is exactly a procedure any credential may call.
test("every tool is built on protectedBase", () => {
  const offBase: string[] = [];
  walkProcedureContractsSync(appRouter, (procedure, path) => {
    const credential = getRequiredCredential(procedure);
    if (getMcpToolMeta(procedure)?.expose && credential !== "any") {
      offBase.push(`${path.join(".")} (${credential})`);
    }
  });
  assert.deepEqual(offBase, []);
});

test("tool names are unique and fit the directory limits", () => {
  const names = listMcpTools().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/u);
  }
});

const listResult = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        annotations: z.object({ destructiveHint: z.boolean(), readOnlyHint: z.boolean() }),
        description: z.string().min(1),
        inputSchema: z.looseObject({ type: z.literal("object") }),
        name: z.string(),
        title: z.string().min(1),
      }),
    ),
  }),
});

test("the MCP server lists every exposed procedure over the wire", async () => {
  const handler = createMcpHandler(() =>
    createMcpServer({
      resolveContext: () => Promise.reject(new Error("tools/list must not resolve a context")),
      version: "0.0.0-test",
    }),
  );
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      method: "POST",
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  // 2025-era stateless serving answers over SSE: one `data:` line per message.
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  const listed = listResult.parse(JSON.parse(data?.slice("data: ".length) ?? "null")).result.tools;
  assert.deepEqual(
    listed.map((tool) => tool.name),
    listMcpTools().map((tool) => tool.name),
  );
  const submit = listed.find((tool) => tool.name === "generate_submit");
  assert.equal(submit?.annotations.readOnlyHint, false);
  assert.deepEqual(submit?.inputSchema.required, ["endpointId", "input"]);
});
