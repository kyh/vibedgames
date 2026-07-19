import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import {
  CodexError,
  generateImagesWithCodex,
  placeCodexOutputs,
  resolveProvider,
} from "../lib/codex.js";
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
      description: "Model endpoint ID, e.g. fal-ai/flux/dev.",
    },
    async: {
      type: "boolean",
      description: "Submit to queue and return request_id without waiting.",
    },
    provider: {
      type: "string",
      description:
        "Execution backend: vibedgames (default) or codex (delegate image generation to the local Codex CLI / your Codex plan). Also settable via VG_GENERATE_PROVIDER.",
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
    const endpoint_id = args.endpoint_id;

    const provider = resolveProvider(args.provider);
    if (provider === "codex") {
      await runViaCodex({ args, finalInput, downloadFlag, endpoint_id });
      return;
    }

    const client = createClient();

    const submission = await client.generate.forward.mutate({
      target: "queue",
      method: "POST",
      path: `/${endpointPath(endpoint_id)}`,
      body: finalInput,
    });
    const requestId =
      isRecord(submission) && typeof submission.request_id === "string"
        ? submission.request_id
        : null;
    if (!requestId) {
      throw new Error("queue submit did not return a request_id.");
    }

    if (args.async) {
      const payload = {
        status: "submitted",
        endpoint_id,
        request_id: requestId,
        hint: `Check status: vg generate status ${endpoint_id} ${requestId}`,
      };
      if (isJsonOutput(args)) writeJson(payload);
      else {
        consola.success(`Submitted ${endpoint_id}`);
        consola.log(`  request_id: ${requestId}`);
      }
      return;
    }

    const completed = await waitForCompletion(client, endpoint_id, requestId, {
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

// Delegate image generation to the local Codex CLI instead of the
// vibedgames model runner. Produces local files directly (Codex writes
// to disk), so there's no queue, no request polling, and no vibedgames
// backend call. The `--download` template still controls output naming;
// without it we default to cwd.
async function runViaCodex(opts: {
  args: { async?: boolean; json?: boolean; quiet?: boolean };
  finalInput: Record<string, unknown>;
  downloadFlag: { mode: "off" | "on"; template?: string };
  endpoint_id: string;
}): Promise<void> {
  const { args, finalInput, downloadFlag, endpoint_id } = opts;
  if (args.async) {
    consola.error("--async is not supported with --provider codex (Codex runs synchronously).");
    process.exit(1);
  }

  let result: Awaited<ReturnType<typeof generateImagesWithCodex>>;
  try {
    result = await generateImagesWithCodex({ input: finalInput });
  } catch (err) {
    if (err instanceof CodexError) {
      // Expected, user-facing failure (codex missing / declined / exec
      // error). Present it cleanly with a deterministic exit code instead
      // of an unhandled stack trace — consola.error goes to stderr, so it
      // never corrupts a --json consumer's stdout. Codex's own output
      // already streamed straight to stderr as it ran (and the message
      // already names the vibedgames fallback), so we don't reprint here.
      consola.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { requestId, rawFiles, prompt, ignoredReferences } = result;
  // Warn about dropped (non-local) references on stderr regardless of
  // --json/--quiet — stderr never corrupts the JSON payload — and also
  // record them in the JSON so an agent parsing stdout sees the signal.
  for (const ref of ignoredReferences) {
    consola.warn(`Ignored non-local reference (codex needs a local file path): ${ref}`);
  }

  const template = downloadFlag.mode === "on" ? downloadFlag.template : undefined;
  const { downloaded, failed } = placeCodexOutputs(rawFiles, template, requestId);

  const payload = {
    status: "completed",
    provider: "codex",
    endpoint_id,
    request_id: requestId,
    result: { provider: "codex", prompt, images: downloaded.map((path) => ({ path })) },
    downloaded_files: downloaded,
    ...(failed.length > 0 ? { download_failures: failed } : {}),
    ...(ignoredReferences.length > 0 ? { ignored_references: ignoredReferences } : {}),
  };

  if (isJsonOutput(args)) {
    writeJson(payload);
  } else {
    consola.success(`Codex generated ${downloaded.length} image(s) (${requestId})`);
    for (const path of downloaded) consola.log(`  ${path}`);
    for (const f of failed) consola.warn(`  failed: ${f.url} (${f.error})`);
  }

  if (failed.length > 0 && downloaded.length === 0) process.exit(1);
}

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

    const ep = queueAppId(args.endpoint_id);
    const client = createClient();
    const path =
      action === "cancel"
        ? `/${ep}/requests/${args.request_id}/cancel`
        : action === "result"
          ? `/${ep}/requests/${args.request_id}`
          : `/${ep}/requests/${args.request_id}/status`;
    const data = await client.generate.forward.mutate({
      target: "queue",
      method: action === "cancel" ? "PUT" : "GET",
      path,
      query: action === "status" && args.logs ? { logs: "1" } : undefined,
    });

    // Cancellation is confirmed asynchronously, and the platform refunds a
    // cancelled job's credit hold when a status poll reports the terminal
    // state — so confirm with a few polls instead of leaving the refund to
    // whenever the user next checks. Best-effort: a miss just defers it.
    if (action === "cancel") {
      const statusPath = `/${ep}/requests/${args.request_id}/status`;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        try {
          const poll = await client.generate.forward.mutate({
            target: "queue",
            method: "GET",
            path: statusPath,
          });
          const status =
            isRecord(poll) && typeof poll.status === "string" ? poll.status.toUpperCase() : "";
          if (["CANCELLED", "FAILED", "COMPLETED"].includes(status)) break;
        } catch {
          break;
        }
      }
    }

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
      endpoint_id: args.endpoint_id,
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
      consola.success(`${action} ${args.endpoint_id} ${args.request_id}`);
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
    const data = await client.generate.forward.mutate({
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
    const id = String(m.endpoint_id ?? "?");
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
    const data = await client.generate.forward.mutate({
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
    const data = await client.generate.forward.mutate({
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
    const data = await client.generate.forward.mutate({
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

export const generateCommand = defineCommand({
  meta: {
    name: "generate",
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
