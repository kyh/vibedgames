import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import { displayEndpointId, resolveEndpointId } from "../lib/endpoint-id.js";
import { parseDownloadFlag, parseRunInput, readExplicitLocalFile } from "../lib/media-args.js";
import { downloadMedia, extractMediaRefs } from "../lib/media-download.js";
import { endpointPath, queueAppId, waitForCompletion } from "../lib/media-poll.js";
import { uploadFile } from "../lib/media-upload.js";
import { isRecord } from "../lib/types.js";

// Action-specific fields for the status-command payload. `result` wraps
// the raw fal payload under `result:` so fal's own keys can't clobber
// our top-level (action / endpoint_id / request_id). `status` cherry-
// picks known fields for the same reason.
function buildActionFields(
  action: "status" | "result" | "cancel",
  data: unknown,
): Record<string, unknown> {
  if (action === "result") return { result: data };
  if (action === "status" && isRecord(data)) {
    return {
      status: typeof data.status === "string" ? data.status : undefined,
      queue_position: typeof data.queue_position === "number" ? data.queue_position : undefined,
      logs: data.logs,
    };
  }
  return {};
}

function isJsonOutput(args: { json?: boolean }): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function extractMediaUrls(result: unknown): string[] {
  return extractMediaRefs(result).map((r) => r.url);
}

// ---- run --------------------------------------------------------------------

const runCommand = defineCommand({
  meta: { name: "run", description: "Run a model (waits for result by default)." },
  args: {
    endpoint_id: {
      type: "positional",
      required: true,
      description: "Model endpoint ID, e.g. flux/dev.",
    },
    async: {
      type: "boolean",
      description: "Submit to queue and return request_id without waiting.",
    },
    download: {
      type: "string",
      description:
        "Download media from result. Optional value is a path or template with {index},{name},{ext},{request_id}.",
    },
    json: { type: "boolean", description: "Print structured JSON to stdout." },
    quiet: { type: "boolean", description: "Suppress progress output during sync runs." },
  },
  run: async ({ args, rawArgs }) => {
    const downloadFlag = parseDownloadFlag(rawArgs);
    // parseRunInput already skips non-`--` tokens, so the positional
    // endpoint_id and any subcommand name in argv are no-ops.
    const finalInput = parseRunInput(rawArgs);
    const client = createClient();

    const resolvedId = resolveEndpointId(args.endpoint_id);
    const submission = await client.media.forward.mutate({
      target: "queue",
      method: "POST",
      path: `/${endpointPath(resolvedId)}`,
      body: finalInput,
    });
    const requestId =
      isRecord(submission) && typeof submission.request_id === "string"
        ? submission.request_id
        : null;
    if (!requestId) {
      throw new Error("queue submit did not return a request_id.");
    }
    const endpoint_id = displayEndpointId(resolvedId);

    if (args.async) {
      const payload = {
        status: "submitted",
        endpoint_id,
        request_id: requestId,
        hint: `Check status: vg media status ${endpoint_id} ${requestId}`,
      };
      if (isJsonOutput(args)) writeJson(payload);
      else {
        consola.success(`Submitted ${endpoint_id}`);
        consola.log(`  request_id: ${requestId}`);
      }
      return;
    }

    const completed = await waitForCompletion(client, resolvedId, requestId, {
      quiet: Boolean(args.quiet) || isJsonOutput(args),
    });

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (downloadFlag.mode === "on") {
      const refs = extractMediaRefs(completed.result);
      downloaded = await downloadMedia({
        refs,
        template: downloadFlag.template,
        requestId: completed.request_id,
      });
    }

    const payload = {
      status: "completed",
      endpoint_id,
      request_id: completed.request_id,
      result: completed.result,
      ...(downloaded ? { downloaded_files: downloaded.downloaded } : {}),
      ...(downloaded && downloaded.failed.length > 0
        ? { download_failures: downloaded.failed }
        : {}),
    };

    if (isJsonOutput(args)) {
      writeJson(payload);
    } else {
      consola.success(`Run completed (${completed.request_id})`);
      if (downloaded) {
        for (const path of downloaded.downloaded) consola.log(`  ${path}`);
        for (const f of downloaded.failed) consola.warn(`  failed: ${f.url} (${f.error})`);
      }
      if (!downloaded?.downloaded.length) {
        for (const url of extractMediaUrls(completed.result)) consola.log(`  ${url}`);
      }
    }

    if (downloaded && downloaded.failed.length > 0 && downloaded.downloaded.length === 0) {
      process.exit(1);
    }
  },
});

// ---- status -----------------------------------------------------------------

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Check job status, fetch result, or cancel.",
  },
  args: {
    endpoint_id: { type: "positional", required: true },
    request_id: { type: "positional", required: true },
    result: { type: "boolean", description: "Fetch the completed result." },
    cancel: { type: "boolean", description: "Cancel the job." },
    logs: { type: "boolean", description: "Include logs." },
    download: {
      type: "string",
      description: "Download media from the result (implies --result).",
    },
    json: { type: "boolean" },
  },
  run: async ({ args, rawArgs }) => {
    if (args.result && args.cancel) {
      consola.error("Pick one of --result or --cancel.");
      process.exit(1);
    }
    const downloadFlag = parseDownloadFlag(rawArgs);
    const wantResult = args.result || downloadFlag.mode === "on";
    const action: "status" | "result" | "cancel" = args.cancel
      ? "cancel"
      : wantResult
        ? "result"
        : "status";

    const resolvedId = resolveEndpointId(args.endpoint_id);
    const displayId = displayEndpointId(resolvedId);
    const ep = queueAppId(resolvedId);
    const client = createClient();
    const path =
      action === "cancel"
        ? `/${ep}/requests/${args.request_id}/cancel`
        : action === "result"
          ? `/${ep}/requests/${args.request_id}`
          : `/${ep}/requests/${args.request_id}/status`;
    const data = await client.media.forward.mutate({
      target: "queue",
      method: action === "cancel" ? "PUT" : "GET",
      path,
      query: action === "status" && args.logs ? { logs: "1" } : undefined,
    });

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (action === "result" && downloadFlag.mode === "on") {
      const refs = extractMediaRefs(data);
      downloaded = await downloadMedia({
        refs,
        template: downloadFlag.template,
        requestId: args.request_id,
      });
    }

    const actionFields = buildActionFields(action, data);
    const payload = {
      action,
      endpoint_id: displayId,
      request_id: args.request_id,
      ...actionFields,
      ...(downloaded ? { downloaded_files: downloaded.downloaded } : {}),
      ...(downloaded && downloaded.failed.length > 0
        ? { download_failures: downloaded.failed }
        : {}),
    };

    if (isJsonOutput(args)) {
      writeJson(payload);
    } else if (action === "status") {
      const status = isRecord(data) && typeof data.status === "string" ? data.status : "?";
      consola.log(`status: ${status}`);
      if (isRecord(data) && typeof data.queue_position === "number") {
        consola.log(`queue_position: ${data.queue_position}`);
      }
    } else {
      consola.success(`${action} ${displayId} ${args.request_id}`);
      if (downloaded) {
        for (const p of downloaded.downloaded) consola.log(`  ${p}`);
        for (const f of downloaded.failed) consola.warn(`  failed: ${f.url} (${f.error})`);
      }
      if (action === "result" && !downloaded?.downloaded.length) {
        for (const url of extractMediaUrls(data)) consola.log(`  ${url}`);
      }
    }

    if (downloaded && downloaded.failed.length > 0 && downloaded.downloaded.length === 0) {
      process.exit(1);
    }
  },
});

// ---- models -----------------------------------------------------------------

const modelsCommand = defineCommand({
  meta: { name: "models", description: "Search/list available models." },
  args: {
    query: { type: "positional", required: false, description: "Search query." },
    category: { type: "string", description: "Filter by category." },
    status: { type: "string", description: "active (default) | deprecated | all" },
    limit: { type: "string", description: "Max results (default 20)." },
    cursor: { type: "string", description: "Pagination cursor from a prior response." },
    endpoint_id: {
      type: "string",
      description: "Specific endpoint id(s); repeat or comma-separate.",
    },
    expand: {
      type: "string",
      description: "Expand fields: openapi-3.0, enterprise_status. Repeat or comma-separate.",
    },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const query: Record<string, string | string[]> = {};
    if (args.query) query.q = args.query;
    if (args.category) query.category = args.category;
    if (args.status && args.status !== "all") query.status = args.status;
    query.limit = args.limit ?? "20";
    if (args.cursor) query.cursor = args.cursor;
    const endpointIds = splitList(args.endpoint_id);
    if (endpointIds.length > 0) query.endpoint_id = endpointIds;
    const expand = splitList(args.expand);
    if (expand.length > 0) query.expand = expand;

    const client = createClient();
    const data = await client.media.forward.mutate({
      target: "platform",
      method: "GET",
      path: "/v1/models",
      query,
    });
    if (isJsonOutput(args)) writeJson(data);
    else printModels(data);
  },
});

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function printModels(data: unknown): void {
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
  for (const m of models) {
    if (!isRecord(m)) continue;
    const id = m.endpoint_id ? displayEndpointId(String(m.endpoint_id)) : "?";
    const meta = isRecord(m.metadata) ? m.metadata : {};
    const tags: string[] = [];
    if (meta.category) tags.push(String(meta.category));
    if (meta.status) tags.push(String(meta.status));
    consola.log(`${id}${tags.length > 0 ? `  [${tags.join(", ")}]` : ""}`);
  }
  if (isRecord(data) && data.next_cursor) {
    consola.log(`\nnext_cursor: ${String(data.next_cursor)}`);
  }
}

// ---- schema -----------------------------------------------------------------

const schemaCommand = defineCommand({
  meta: { name: "schema", description: "Fetch a model's input/output schema." },
  args: {
    endpoint_id: { type: "positional", required: true },
    format: { type: "string", description: "compact (default) | openapi" },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const expand = args.format === "openapi" ? ["openapi-3.0"] : [];
    const client = createClient();
    const data = await client.media.forward.mutate({
      target: "platform",
      method: "GET",
      path: "/v1/models",
      query: {
        endpoint_id: args.endpoint_id,
        limit: "1",
        ...(expand.length > 0 ? { expand } : {}),
      },
    });
    writeJson(data);
  },
});

// ---- pricing ----------------------------------------------------------------

const pricingCommand = defineCommand({
  meta: { name: "pricing", description: "Fetch pricing for a model." },
  args: {
    endpoint_id: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const client = createClient();
    const data = await client.media.forward.mutate({
      target: "platform",
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: args.endpoint_id },
    });
    writeJson(data);
  },
});

// ---- docs -------------------------------------------------------------------

const docsCommand = defineCommand({
  meta: { name: "docs", description: "Search generative-model documentation." },
  args: {
    query: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const client = createClient();
    const data = await client.media.forward.mutate({
      target: "docs",
      method: "POST",
      path: "/docs/mcp",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_fal", arguments: { query: args.query } },
      },
    });
    writeJson(data);
  },
});

// ---- upload -----------------------------------------------------------------

const uploadCommand = defineCommand({
  meta: {
    name: "upload",
    description: "Upload a local file. Returns a stable hosted URL.",
  },
  args: {
    path: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const stat = readExplicitLocalFile(args.path);
    if (!stat) {
      consola.error(`File not found: ${args.path}`);
      process.exit(1);
    }
    const client = createClient();
    const url = await uploadFile(client, stat);
    if (isJsonOutput(args)) writeJson({ url });
    else process.stdout.write(url + "\n");
  },
});

// ---- top-level --------------------------------------------------------------

export const mediaCommand = defineCommand({
  meta: {
    name: "media",
    description: "Generate, edit, and inspect images, video, and audio.",
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
    models: modelsCommand,
    schema: schemaCommand,
    pricing: pricingCommand,
    docs: docsCommand,
    upload: uploadCommand,
  },
});
