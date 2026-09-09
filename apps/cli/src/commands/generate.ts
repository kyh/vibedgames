import { setTimeout as sleep } from "node:timers/promises";
import { defineCommand } from "citty";
import { consola } from "consola";

import { createClient, forwardJson } from "../lib/api.js";
import {
  CodexError,
  generateImagesWithCodex,
  placeCodexOutputs,
  resolveProvider,
} from "../lib/codex.js";
import { parseDownloadFlag, parseRunInput, readExplicitLocalFile } from "../lib/media-args.js";
import type { DownloadFlag } from "../lib/media-args.js";
import { downloadMedia, extractMediaRefs } from "../lib/media-download.js";
import { endpointPath, queueAppId, waitForCompletion } from "../lib/media-poll.js";
import { uploadFile } from "../lib/media-upload.js";
import { isJsonOutput, outputArgs, writeJson, writeStructured } from "../lib/output.js";
import { isJsonNumber, isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonObject, JsonValue } from "../lib/types.js";

type DownloadFailure = {
  url: string;
  error: string;
};
type FormatMismatch = {
  path: string;
  actual: string;
};

// Action-specific fields for the status-command payload. `result` wraps
// the raw fal payload under `result:` so fal's own keys can't clobber
// our top-level (action / endpoint_id / request_id). `status` cherry-
// picks known fields for the same reason.
type ActionFields = {
  status?: string;
  queue_position?: number;
  logs?: JsonValue;
  result?: JsonValue;
};

const buildActionFields = (
  action: "status" | "result" | "cancel",
  data: JsonValue,
): ActionFields => {
  if (action === "result") {
    return { result: data };
  }
  if (action === "status" && isJsonObject(data)) {
    const fields: ActionFields = {};
    if (isJsonString(data.status)) {
      fields.status = data.status;
    }
    if (isJsonNumber(data.queue_position)) {
      fields.queue_position = data.queue_position;
    }
    if (data.logs !== undefined) {
      fields.logs = data.logs;
    }
    return fields;
  }
  return {};
};

/**
 * True when stdout is carrying data rather than a progress narrative, so
 * spinners and status lines must stay off it. `--field` counts: its whole
 * point is that the output can be captured by a shell verbatim.
 */
const isStructuredOutput = (args: { json?: boolean; field?: string }): boolean =>
  isJsonOutput(args) || Boolean(args.field);

const extractMediaUrls = (result: JsonValue): string[] =>
  extractMediaRefs(result).map((r) => r.url);

// ---- run --------------------------------------------------------------------

/**
 * A downloaded file whose extension does not match the bytes inside it.
 *
 * The model, not the CLI, picks the output format, so asking for `board.png`
 * from an endpoint that returns JPEG produces a `.png` full of JPEG. The next
 * tool in the pipeline reports "bad signature" with no hint of where it came
 * from, so name it here while the cause is still on screen.
 */
const warnMislabeled = (mislabeled: FormatMismatch[]): void => {
  for (const m of mislabeled) {
    consola.warn(`  ${m.path} holds ${m.actual.toUpperCase()} data, not what its extension says`);
  }
};
// Delegate image generation to the local Codex CLI instead of the
// vibedgames model runner. Produces local files directly (Codex writes
// to disk), so there's no queue, no request polling, and no vibedgames
// backend call. The `--download` template still controls output naming;
// without it we default to cwd.
const runViaCodex = async (opts: {
  args: { async?: boolean; json?: boolean; field?: string; quiet?: boolean };
  finalInput: JsonObject;
  downloadFlag: DownloadFlag;
  endpoint_id: string;
}): Promise<void> => {
  const { args, finalInput, downloadFlag, endpoint_id } = opts;
  if (args.async) {
    consola.error("--async is not supported with --provider codex (Codex runs synchronously).");
    process.exit(1);
  }

  let result: Awaited<ReturnType<typeof generateImagesWithCodex>>;
  try {
    result = await generateImagesWithCodex({ input: finalInput });
  } catch (error) {
    if (error instanceof CodexError) {
      // Expected, user-facing failure (codex missing / declined / exec
      // error). Present it cleanly with a deterministic exit code instead
      // of an unhandled stack trace — consola.error goes to stderr, so it
      // never corrupts a --json consumer's stdout. Codex's own output
      // already streamed straight to stderr as it ran (and the message
      // already names the vibedgames fallback), so we don't reprint here.
      consola.error(error.message);
      process.exit(1);
    }
    throw error;
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

  const payload: CodexRunPayload = {
    downloaded_files: downloaded,
    endpoint_id,
    provider: "codex",
    request_id: requestId,
    result: { images: downloaded.map((path) => ({ path })), prompt, provider: "codex" },
    status: "completed",
  };
  if (failed.length > 0) {
    payload.download_failures = failed;
  }
  if (ignoredReferences.length > 0) {
    payload.ignored_references = ignoredReferences;
  }

  if (!writeStructured(payload, args)) {
    consola.success(`Codex generated ${downloaded.length} image(s) (${requestId})`);
    for (const path of downloaded) {
      consola.log(`  ${path}`);
    }
    for (const f of failed) {
      consola.warn(`  failed: ${f.url} (${f.error})`);
    }
  }

  if (failed.length > 0 && downloaded.length === 0) {
    process.exit(1);
  }
};
type DownloadOutcome = Awaited<ReturnType<typeof downloadMedia>>;

const buildRunPayload = (
  endpointId: string,
  completed: { request_id: string; result: JsonValue },
  downloaded: DownloadOutcome | undefined,
): RunCompletedPayload => {
  const payload: RunCompletedPayload = {
    endpoint_id: endpointId,
    request_id: completed.request_id,
    result: completed.result,
    status: "completed",
  };
  if (!downloaded) {
    return payload;
  }
  payload.downloaded_files = downloaded.downloaded;
  if (downloaded.failed.length > 0) {
    payload.download_failures = downloaded.failed;
  }
  if (downloaded.mislabeled.length > 0) {
    payload.download_format_mismatches = downloaded.mislabeled;
  }
  return payload;
};

const reportRun = (
  completed: { request_id: string; result: JsonValue },
  downloaded: DownloadOutcome | undefined,
): void => {
  consola.success(`Run completed (${completed.request_id})`);
  if (downloaded) {
    for (const file of downloaded.downloaded) {
      consola.log(`  ${file}`);
    }
    for (const f of downloaded.failed) {
      consola.warn(`  failed: ${f.url} (${f.error})`);
    }
    warnMislabeled(downloaded.mislabeled);
  }
  if (!downloaded?.downloaded.length) {
    for (const url of extractMediaUrls(completed.result)) {
      consola.log(`  ${url}`);
    }
  }
};

const runCommand = defineCommand({
  args: {
    async: {
      description: "Submit to queue and return request_id without waiting.",
      type: "boolean",
    },
    download: {
      description:
        "Download media from result. Optional value is a path or template with {index},{name},{ext},{request_id}.",
      type: "string",
    },
    endpoint_id: {
      description: "Model endpoint ID, e.g. fal-ai/flux/dev.",
      required: true,
      type: "positional",
    },
    provider: {
      description:
        "Execution backend: vibedgames (default) or codex (delegate image generation to the local Codex CLI / your Codex plan). Also settable via VG_GENERATE_PROVIDER.",
      type: "string",
    },
    ...outputArgs,
    quiet: { description: "Suppress progress output during sync runs.", type: "boolean" },
  },
  meta: { description: "Run a model (waits for result by default).", name: "run" },
  run: async ({ args, rawArgs }) => {
    const downloadFlag = parseDownloadFlag(rawArgs);
    // parseRunInput already skips non-`--` tokens, so the positional
    // endpoint_id and any subcommand name in argv are no-ops.
    const finalInput = parseRunInput(rawArgs);
    const { endpoint_id } = args;

    const provider = resolveProvider(args.provider);
    if (provider === "codex") {
      await runViaCodex({ args, downloadFlag, endpoint_id, finalInput });
      return;
    }

    const client = createClient();

    const submission = await forwardJson(client, {
      body: finalInput,
      method: "POST",
      path: `/${endpointPath(endpoint_id)}`,
      target: "queue",
    });
    const requestId =
      isJsonObject(submission) && isJsonString(submission.request_id)
        ? submission.request_id
        : null;
    if (!requestId) {
      throw new Error("queue submit did not return a request_id.");
    }

    if (args.async) {
      const payload = {
        endpoint_id,
        hint: `Check status: vg generate status ${endpoint_id} ${requestId}`,
        request_id: requestId,
        status: "submitted",
      };
      if (!writeStructured(payload, args)) {
        consola.success(`Submitted ${endpoint_id}`);
        consola.log(`  request_id: ${requestId}`);
      }
      return;
    }

    const completed = await waitForCompletion(client, endpoint_id, requestId, {
      quiet: Boolean(args.quiet) || isStructuredOutput(args),
    });

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (downloadFlag.mode === "on") {
      const refs = extractMediaRefs(completed.result);
      downloaded = await downloadMedia({
        refs,
        requestId: completed.request_id,
        template: downloadFlag.template,
      });
    }

    const payload = buildRunPayload(endpoint_id, completed, downloaded);
    if (!writeStructured(payload, args)) {
      reportRun(completed, downloaded);
    }

    if (downloaded && downloaded.failed.length > 0 && downloaded.downloaded.length === 0) {
      process.exit(1);
    }
  },
});

type RunCompletedPayload = {
  status: string;
  endpoint_id: string;
  request_id: string;
  result: JsonValue;
  downloaded_files?: string[];
  download_failures?: DownloadFailure[];
  download_format_mismatches?: FormatMismatch[];
};

type CodexRunPayload = {
  status: string;
  provider: string;
  endpoint_id: string;
  request_id: string;
  result: { provider: string; prompt: string; images: { path: string }[] };
  downloaded_files: string[];
  download_failures?: DownloadFailure[];
  ignored_references?: string[];
};

// ---- status -----------------------------------------------------------------

/** Cancellation is confirmed asynchronously, and the platform refunds a
 *  cancelled job's credit hold when a status poll reports the terminal state —
 *  so confirm with a few polls instead of leaving the refund to whenever the
 *  user next checks. Best-effort: a miss just defers it. */
const confirmCancelled = async (
  client: ReturnType<typeof createClient>,
  ep: string,
  requestId: string,
): Promise<void> => {
  const statusPath = `/${ep}/requests/${requestId}/status`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1000);
    try {
      const poll = await forwardJson(client, { method: "GET", path: statusPath, target: "queue" });
      const status =
        isJsonObject(poll) && isJsonString(poll.status) ? poll.status.toUpperCase() : "";
      if (["CANCELLED", "FAILED", "COMPLETED"].includes(status)) {
        break;
      }
    } catch {
      break;
    }
  }
};

const reportStatus = (
  action: "status" | "result" | "cancel",
  endpointId: string,
  requestId: string,
  data: JsonValue,
  downloaded: DownloadOutcome | undefined,
): void => {
  if (action === "status") {
    const status = isJsonObject(data) && isJsonString(data.status) ? data.status : "?";
    consola.log(`status: ${status}`);
    if (isJsonObject(data) && isJsonNumber(data.queue_position)) {
      consola.log(`queue_position: ${data.queue_position}`);
    }
    return;
  }
  consola.success(`${action} ${endpointId} ${requestId}`);
  if (downloaded) {
    for (const p of downloaded.downloaded) {
      consola.log(`  ${p}`);
    }
    for (const f of downloaded.failed) {
      consola.warn(`  failed: ${f.url} (${f.error})`);
    }
    warnMislabeled(downloaded.mislabeled);
  }
  if (action === "result" && !downloaded?.downloaded.length) {
    for (const url of extractMediaUrls(data)) {
      consola.log(`  ${url}`);
    }
  }
};

const statusCommand = defineCommand({
  args: {
    cancel: { description: "Cancel the job.", type: "boolean" },
    download: {
      description: "Download media from the result (implies --result).",
      type: "string",
    },
    endpoint_id: { required: true, type: "positional" },
    logs: { description: "Include logs.", type: "boolean" },
    request_id: { required: true, type: "positional" },
    result: { description: "Fetch the completed result.", type: "boolean" },
    ...outputArgs,
  },
  meta: {
    description: "Check job status, fetch result, or cancel.",
    name: "status",
  },
  run: async ({ args, rawArgs }) => {
    if (args.result && args.cancel) {
      consola.error("Pick one of --result or --cancel.");
      process.exit(1);
    }
    const downloadFlag = parseDownloadFlag(rawArgs);
    const wantResult = args.result || downloadFlag.mode === "on";
    let action: "status" | "result" | "cancel" = "status";
    if (args.cancel) {
      action = "cancel";
    } else if (wantResult) {
      action = "result";
    }

    const ep = queueAppId(args.endpoint_id);
    const client = createClient();
    const suffixes = { cancel: "/cancel", result: "", status: "/status" };
    const path = `/${ep}/requests/${args.request_id}${suffixes[action]}`;
    const data = await forwardJson(client, {
      method: action === "cancel" ? "PUT" : "GET",
      path,
      query: action === "status" && args.logs ? { logs: "1" } : undefined,
      target: "queue",
    });

    // Cancellation is confirmed asynchronously, and the platform refunds a
    // cancelled job's credit hold when a status poll reports the terminal
    // state — so confirm with a few polls instead of leaving the refund to
    // whenever the user next checks. Best-effort: a miss just defers it.
    if (action === "cancel") {
      await confirmCancelled(client, ep, args.request_id);
    }

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (action === "result" && downloadFlag.mode === "on") {
      const refs = extractMediaRefs(data);
      downloaded = await downloadMedia({
        refs,
        requestId: args.request_id,
        template: downloadFlag.template,
      });
    }

    const payload: StatusPayload = {
      action,
      endpoint_id: args.endpoint_id,
      request_id: args.request_id,
      ...buildActionFields(action, data),
    };
    if (downloaded) {
      payload.downloaded_files = downloaded.downloaded;
      if (downloaded.failed.length > 0) {
        payload.download_failures = downloaded.failed;
      }
      if (downloaded.mislabeled.length > 0) {
        payload.download_format_mismatches = downloaded.mislabeled;
      }
    }

    if (!writeStructured(payload, args)) {
      reportStatus(action, args.endpoint_id, args.request_id, data, downloaded);
    }

    if (downloaded && downloaded.failed.length > 0 && downloaded.downloaded.length === 0) {
      process.exit(1);
    }
  },
});

// A type alias, not an interface: it must stay assignable to the JSON index-signature type.
type StatusPayload = ActionFields & {
  action: "status" | "result" | "cancel";
  endpoint_id: string;
  request_id: string;
  downloaded_files?: string[];
  download_failures?: DownloadFailure[];
  download_format_mismatches?: FormatMismatch[];
};

// ---- models -----------------------------------------------------------------

const splitList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};
const printModels = (data: JsonValue): void => {
  const models = isJsonObject(data) && Array.isArray(data.models) ? data.models : [];
  for (const m of models) {
    if (!isJsonObject(m)) {
      continue;
    }
    const id = String(m.endpoint_id ?? "?");
    const meta: JsonObject = isJsonObject(m.metadata) ? m.metadata : {};
    const tags: string[] = [];
    if (meta.category) {
      tags.push(String(meta.category));
    }
    if (meta.status) {
      tags.push(String(meta.status));
    }
    consola.log(`${id}${tags.length > 0 ? `  [${tags.join(", ")}]` : ""}`);
  }
  if (isJsonObject(data) && data.next_cursor) {
    consola.log(`\nnext_cursor: ${String(data.next_cursor)}`);
  }
};
const modelsCommand = defineCommand({
  args: {
    category: { description: "Filter by category.", type: "string" },
    cursor: { description: "Pagination cursor from a prior response.", type: "string" },
    endpoint_id: {
      description: "Specific endpoint id(s); repeat or comma-separate.",
      type: "string",
    },
    expand: {
      description: "Expand fields: openapi-3.0, enterprise_status. Repeat or comma-separate.",
      type: "string",
    },
    limit: { description: "Max results (default 20).", type: "string" },
    query: { description: "Search query.", required: false, type: "positional" },
    status: { description: "active (default) | deprecated | all", type: "string" },
    ...outputArgs,
  },
  meta: { description: "Search/list available models.", name: "models" },
  run: async ({ args }) => {
    const query: Record<string, string | string[]> = {};
    if (args.query) {
      query.q = args.query;
    }
    if (args.category) {
      query.category = args.category;
    }
    if (args.status && args.status !== "all") {
      query.status = args.status;
    }
    query.limit = args.limit ?? "20";
    if (args.cursor) {
      query.cursor = args.cursor;
    }
    const endpointIds = splitList(args.endpoint_id);
    if (endpointIds.length > 0) {
      query.endpoint_id = endpointIds;
    }
    const expand = splitList(args.expand);
    if (expand.length > 0) {
      query.expand = expand;
    }

    const client = createClient();
    const data = await forwardJson(client, {
      method: "GET",
      path: "/v1/models",
      query,
      target: "platform",
    });
    if (!writeStructured(data, args)) {
      printModels(data);
    }
  },
});

// ---- schema -----------------------------------------------------------------

const schemaCommand = defineCommand({
  args: {
    endpoint_id: { required: true, type: "positional" },
    format: { description: "compact (default) | openapi", type: "string" },
    ...outputArgs,
  },
  meta: { description: "Fetch a model's input/output schema.", name: "schema" },
  run: async ({ args }) => {
    const expand = args.format === "openapi" ? ["openapi-3.0"] : [];
    const client = createClient();
    const query: Record<string, string | string[]> = {};
    query.endpoint_id = args.endpoint_id;
    query.limit = "1";
    if (expand.length > 0) {
      query.expand = expand;
    }
    const data = await forwardJson(client, {
      method: "GET",
      path: "/v1/models",
      query,
      target: "platform",
    });
    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

// ---- pricing ----------------------------------------------------------------

const pricingCommand = defineCommand({
  args: {
    endpoint_id: { required: true, type: "positional" },
    ...outputArgs,
  },
  meta: { description: "Fetch pricing for a model.", name: "pricing" },
  run: async ({ args }) => {
    const client = createClient();
    const data = await forwardJson(client, {
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: args.endpoint_id },
      target: "platform",
    });
    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

// ---- docs -------------------------------------------------------------------

const docsCommand = defineCommand({
  args: {
    query: { required: true, type: "positional" },
    ...outputArgs,
  },
  meta: { description: "Search generative-model documentation.", name: "docs" },
  run: async ({ args }) => {
    const client = createClient();
    const data = await forwardJson(client, {
      body: {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: args.query }, name: "search_fal" },
      },
      method: "POST",
      path: "/docs/mcp",
      target: "docs",
    });
    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

// ---- upload -----------------------------------------------------------------

const uploadCommand = defineCommand({
  args: {
    path: { required: true, type: "positional" },
    ...outputArgs,
  },
  meta: {
    description: "Upload a local file. Returns a stable hosted URL.",
    name: "upload",
  },
  run: async ({ args }) => {
    const stat = readExplicitLocalFile(args.path);
    if (!stat) {
      consola.error(`File not found: ${args.path}`);
      process.exit(1);
    }
    const client = createClient();
    const url = await uploadFile(client, stat);
    if (!writeStructured({ url }, args)) {
      process.stdout.write(`${url}\n`);
    }
  },
});

// ---- top-level --------------------------------------------------------------

export const generateCommand = defineCommand({
  meta: {
    description: "Generate, edit, and inspect images, video, and audio.",
    name: "generate",
  },
  subCommands: {
    docs: docsCommand,
    models: modelsCommand,
    pricing: pricingCommand,
    run: runCommand,
    schema: schemaCommand,
    status: statusCommand,
    upload: uploadCommand,
  },
});
