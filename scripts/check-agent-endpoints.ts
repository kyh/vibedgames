/**
 * Runtime check of the agent-facing surfaces against a running web app:
 * `/llms.txt`, the skills discovery index and the `/mcp` server. `pnpm verify`
 * never boots the Worker, so status codes and the MCP wire format are only
 * checkable here.
 *
 *   pnpm check:agent-endpoints                      # http://localhost:5173
 *   pnpm check:agent-endpoints https://vibedgames.com
 */
import { z } from "zod";

const baseUrl = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/u, "");

let failures = 0;

const expect = (label: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures += 1;
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const skillIndexSchema = z.object({ skills: z.array(z.object({ name: z.string() })) });

const initializeSchema = z.object({
  instructions: z.string(),
  serverInfo: z.object({ name: z.string() }),
});

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      annotations: z.object({ openWorldHint: z.boolean(), readOnlyHint: z.boolean() }),
      name: z.string(),
    }),
  ),
});

const toolResultSchema = z.object({
  content: z.array(z.object({ text: z.string(), type: z.literal("text") })).min(1),
  isError: z.boolean().optional(),
});

const skillEntriesSchema = z.array(z.object({ description: z.string(), slug: z.string() }));

const gameEntriesSchema = z.array(
  z.object({ description: z.string(), playUrl: z.url(), slug: z.string(), title: z.string() }),
);

const rpcResponseSchema = z.object({ result: z.unknown() });

// A stateless Streamable HTTP server may answer either as JSON or as a single
// SSE `message` event; both carry one JSON-RPC response.
const rpcJson = (contentType: string, body: string): string =>
  contentType.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : body;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

let rpcId = 0;

const mcp = async <T>(schema: z.ZodType<T>, method: string, params: JsonObject) => {
  rpcId += 1;
  const response = await fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify({ id: rpcId, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    method: "POST",
  });
  const body = await response.text();
  const { result } = rpcResponseSchema.parse(
    JSON.parse(rpcJson(response.headers.get("content-type") ?? "", body)),
  );
  return { result: schema.parse(result), status: response.status };
};

const callTool = async (name: string, args: JsonObject = {}) => {
  const { result } = await mcp(toolResultSchema, "tools/call", { arguments: args, name });
  return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
};

const toolJson = async <T>(schema: z.ZodType<T>, name: string, args: JsonObject = {}) => {
  const { text } = await callTool(name, args);
  return schema.parse(JSON.parse(text));
};

const llms = await fetch(`${baseUrl}/llms.txt`);
const llmsBody = await llms.text();
expect("GET /llms.txt → 200", llms.status === 200, `status ${llms.status}`);
expect("/llms.txt advertises /mcp", llmsBody.includes("/mcp"));

const indexResponse = await fetch(`${baseUrl}/.well-known/agent-skills/index.json`);
const index = skillIndexSchema.parse(await indexResponse.json());
expect("skills index lists skills", index.skills.length > 0);

const init = await mcp(initializeSchema, "initialize", {
  capabilities: {},
  clientInfo: { name: "check-agent-endpoints", version: "1.0.0" },
  protocolVersion: "2025-06-18",
});
expect("POST /mcp initialize → 200", init.status === 200, `status ${init.status}`);
expect("initialize names the server", init.result.serverInfo.name === "vibedgames");
expect("initialize carries instructions", init.result.instructions.includes("vg CLI"));

const CATALOG_TOOLS = new Set(["get_skill", "get_started", "list_skills", "search_games"]);
const { result: listed } = await mcp(toolListSchema, "tools/list", {});
const catalog = listed.tools.filter((tool) => CATALOG_TOOLS.has(tool.name));
expect(
  "tools/list exposes the four catalog tools",
  catalog.length === CATALOG_TOOLS.size,
  catalog.map((tool) => tool.name).join(","),
);
expect(
  "catalog tools are annotated read-only and closed-world",
  catalog.every(({ annotations }) => annotations.readOnlyHint && !annotations.openWorldHint),
);
expect(
  "tools/list exposes the account tools",
  ["whoami", "generate_submit", "deploy_list"].every((name) =>
    listed.tools.some((tool) => tool.name === name),
  ),
);

const anonymous = await fetch(`${baseUrl}/mcp`, {
  body: JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "whoami" },
  }),
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  },
  method: "POST",
});
expect(
  "an anonymous account-tool call → 401 with a Bearer challenge",
  anonymous.status === 401 &&
    (anonymous.headers.get("www-authenticate") ?? "").startsWith("Bearer"),
  `status ${anonymous.status}`,
);

const started = await callTool("get_started");
expect("get_started gives the install command", started.text.includes("npx vibedgames init"));

const skills = await toolJson(skillEntriesSchema, "list_skills");
expect(
  "list_skills matches the discovery index",
  skills.length === index.skills.length,
  `${skills.length} vs ${index.skills.length}`,
);

const filtered = await toolJson(skillEntriesSchema, "list_skills", { query: "multiplayer" });
expect(
  "list_skills query ranks the multiplayer skill first",
  filtered[0]?.slug === "multiplayer",
  filtered[0]?.slug,
);

const skill = await callTool("get_skill", { slug: "deploy" });
expect("get_skill returns SKILL.md", !skill.isError && skill.text.startsWith("---"));

const missing = await callTool("get_skill", { slug: "does-not-exist" });
expect("get_skill on an unknown slug is an isError result", missing.isError);

const games = await toolJson(gameEntriesSchema, "search_games", { limit: 3 });
expect(
  "search_games honours limit and returns play URLs",
  games.length === 3 && games.every((game) => game.playUrl.endsWith(".vibedgames.com")),
  JSON.stringify(games),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed against ${baseUrl}`);
  process.exit(1);
}
console.log(`\nAll agent endpoint checks passed against ${baseUrl}`);
