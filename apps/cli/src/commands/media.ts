import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import {
  extractLocalFiles,
  parseDownloadFlag,
  parseRunInput,
  readExplicitLocalFile,
  substituteTokens,
} from "../lib/media-args.js";
import { downloadMedia, extractMediaRefs } from "../lib/media-download.js";
import { waitForCompletion } from "../lib/media-poll.js";
import { uploadFiles } from "../lib/media-upload.js";
import { isRecord } from "../lib/types.js";

function isJsonOutput(args: { json?: boolean }): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// ---- run --------------------------------------------------------------------

const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a fal model (waits for result by default).",
  },
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
    download: {
      type: "string",
      description:
        "Download media from result. Optional value is a path or template with {index},{name},{ext},{request_id}.",
    },
    json: { type: "boolean", description: "Print structured JSON to stdout." },
    quiet: { type: "boolean", description: "Suppress progress output during sync runs." },
  },
  // Citty can't enumerate arbitrary --<param> flags, so we re-walk the
  // argv citty handed us (rawArgs) to pull them out. parseRunInput
  // already skips non-`--` tokens, so any leading subcommand name or
  // positional that survives in rawArgs is a no-op. Skill scripts
  // targeting genmedia produce identical argv shapes, which is the
  // whole point of this proxy.
  run: async ({ args, rawArgs }) => {
    const argv = rawArgs;
    const downloadFlag = parseDownloadFlag(argv);

    // parseRunInput already skips non-`--` tokens, so the positional
    // endpoint_id and any subcommand name in argv are no-ops.
    const parsed = parseRunInput(argv);
    const { files, rewritten } = extractLocalFiles(parsed);

    const tokenToUrl = new Map<string, string>();
    const client = createClient();

    if (files.length > 0) {
      const { urls } = await uploadFiles(client, files);
      // Bytes went straight to fal; we don't keep refs around because
      // there's nothing to clean up (fal manages its own storage).
      for (let i = 0; i < files.length; i++) {
        const url = urls[i];
        if (url) tokenToUrl.set(files[i]!.token, url);
      }
    }
    const finalInput = substituteTokens(rewritten, tokenToUrl);

    const submitted = await client.media.run.mutate({
      endpoint_id: args.endpoint_id,
      input: finalInput,
    });
    const { endpoint_id, request_id } = submitted;

    if (args.async) {
      const payload = {
        status: "submitted",
        endpoint_id,
        request_id,
        hint: `Check status: vg media status ${endpoint_id} ${request_id}`,
      };
      if (isJsonOutput(args)) writeJson(payload);
      else {
        consola.success(`Submitted ${endpoint_id}`);
        consola.log(`  request_id: ${request_id}`);
      }
      return;
    }

    // Sync mode: poll on the client. The Worker is no longer in the
    // hot path, so video/3D models that take minutes don't pin a
    // long-lived request and don't burn Worker billing on the wait.
    const completed = await waitForCompletion(client, endpoint_id, request_id, {
      quiet: Boolean(args.quiet) || isJsonOutput(args),
    });

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (downloadFlag.mode === "on") {
      const refs = extractMediaRefs(completed.result);
      downloaded = await downloadMedia({
        refs,
        template: downloadFlag.template,
        requestId: request_id,
      });
    }

    const payload = {
      status: "completed",
      endpoint_id,
      request_id,
      result: completed.result,
      ...(downloaded ? { downloaded_files: downloaded.downloaded } : {}),
      ...(downloaded && downloaded.failed.length > 0
        ? { download_failures: downloaded.failed }
        : {}),
    };

    if (isJsonOutput(args)) {
      writeJson(payload);
    } else {
      consola.success(`Run completed (${request_id})`);
      if (downloaded) {
        for (const path of downloaded.downloaded) consola.log(`  ${path}`);
        for (const f of downloaded.failed) consola.warn(`  failed: ${f.url} (${f.error})`);
      }
      if (!downloaded || downloaded.downloaded.length === 0) {
        for (const url of extractMediaUrls(completed.result)) consola.log(`  ${url}`);
      }
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
    json: { type: "boolean", description: "Print structured JSON to stdout." },
  },
  run: async ({ args, rawArgs }) => {
    if (args.result && args.cancel) {
      consola.error("Pick one of --result or --cancel.");
      process.exit(1);
    }
    const downloadFlag = parseDownloadFlag(rawArgs);
    const action: "status" | "result" | "cancel" = args.cancel
      ? "cancel"
      : args.result || downloadFlag.mode === "on"
        ? "result"
        : "status";

    const client = createClient();
    const data = await client.media.status.mutate({
      endpoint_id: args.endpoint_id,
      request_id: args.request_id,
      action,
      logs: Boolean(args.logs),
    });

    let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
    if (action === "result" && downloadFlag.mode === "on" && "result" in data) {
      const refs = extractMediaRefs(data.result);
      downloaded = await downloadMedia({
        refs,
        template: downloadFlag.template,
        requestId: args.request_id,
      });
    }

    const payload = {
      ...data,
      ...(downloaded ? { downloaded_files: downloaded.downloaded } : {}),
      ...(downloaded && downloaded.failed.length > 0
        ? { download_failures: downloaded.failed }
        : {}),
    };

    if (isJsonOutput(args)) {
      writeJson(payload);
    } else if (action === "status") {
      consola.log(`status: ${"status" in data ? data.status : "?"}`);
      if ("queue_position" in data && data.queue_position !== undefined) {
        consola.log(`queue_position: ${data.queue_position}`);
      }
    } else {
      consola.success(`${action} ${args.endpoint_id} ${args.request_id}`);
      if (downloaded) for (const p of downloaded.downloaded) consola.log(`  ${p}`);
    }
  },
});

// ---- models -----------------------------------------------------------------

const modelsCommand = defineCommand({
  meta: {
    name: "models",
    description: "Search/list fal models.",
  },
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
    const client = createClient();
    const data = await client.media.models.query({
      q: args.query,
      category: args.category,
      status: parseStatus(args.status),
      limit: parseLimit(args.limit),
      cursor: args.cursor,
      endpoint_ids: splitList(args.endpoint_id),
      expand: splitList(args.expand),
    });
    if (isJsonOutput(args)) writeJson(data);
    else printModels(data);
  },
});

function parseStatus(value: string | undefined): "active" | "deprecated" | "all" | undefined {
  if (value === "active" || value === "deprecated" || value === "all") return value;
  if (value === undefined) return undefined;
  consola.error(`--status must be one of: active, deprecated, all`);
  process.exit(1);
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    consola.error("--limit must be a positive integer.");
    process.exit(1);
  }
  return n;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function printModels(data: unknown): void {
  const records = isRecord(data) && Array.isArray(data.records) ? data.records : [];
  for (const m of records) {
    if (!isRecord(m)) continue;
    const id = String(m.endpoint_id ?? "?");
    const tags: string[] = [];
    if (m.category) tags.push(String(m.category));
    if (m.status) tags.push(String(m.status));
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
    const format = args.format === "openapi" ? "openapi" : "compact";
    const client = createClient();
    const data = await client.media.schema.query({
      endpoint_id: args.endpoint_id,
      format,
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
    const data = await client.media.pricing.query({ endpoint_id: args.endpoint_id });
    writeJson(data);
  },
});

// ---- docs -------------------------------------------------------------------

const docsCommand = defineCommand({
  meta: { name: "docs", description: "Search fal documentation." },
  args: {
    query: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    const client = createClient();
    const data = await client.media.docs.query({ query: args.query });
    writeJson(data);
  },
});

// ---- upload -----------------------------------------------------------------

const uploadCommand = defineCommand({
  meta: {
    name: "upload",
    description: "Upload a local file. Returns a presigned URL usable as a model input.",
  },
  args: {
    path: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  run: async ({ args }) => {
    // Explicit `vg media upload <path>`: don't apply the run-input
    // looksLikeMediaPath heuristic — bare 3D/audio/glb/fbx/ply
    // filenames must work without a `./` prefix.
    const stat = readExplicitLocalFile(args.path);
    if (!stat) {
      consola.error(`File not found: ${args.path}`);
      process.exit(1);
    }
    const client = createClient();
    const { urls } = await uploadFiles(client, [{ token: "__upload__", ...stat }]);
    const url = urls[0];
    if (!url) {
      consola.error("Upload returned no URL.");
      process.exit(1);
    }
    if (isJsonOutput(args)) writeJson({ url });
    else process.stdout.write(url + "\n");
  },
});

// ---- top-level --------------------------------------------------------------

export const mediaCommand = defineCommand({
  meta: {
    name: "media",
    description: "Generate, edit, and inspect media via fal.ai (mirrors the genmedia CLI surface).",
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

// ---- helpers ----------------------------------------------------------------

function extractMediaUrls(result: unknown): string[] {
  return extractMediaRefs(result).map((r) => r.url);
}
