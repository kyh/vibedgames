import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import {
  extractLocalFiles,
  parseDownloadFlag,
  parseRunInput,
  substituteTokens,
} from "../lib/media-args.js";
import { downloadMedia, extractMediaRefs } from "../lib/media-download.js";
import { isJsonOutput, writeJson } from "../lib/media-output.js";
import { cleanupUploads, uploadFiles } from "../lib/media-upload.js";
import { isRecord } from "../lib/types.js";

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
  },
  // Citty can't enumerate arbitrary --<param> flags, so we pull them off
  // process.argv directly. Skill scripts targeting genmedia produce
  // identical argv shapes, which is the whole point of this proxy.
  run: async ({ args, rawArgs }) => {
    const argv = rawArgs;
    const downloadFlag = parseDownloadFlag(argv);

    // Strip the positional endpoint_id so we don't parse it as a param.
    const argvForInput = stripPositional(argv, args.endpoint_id);
    const parsed = parseRunInput(argvForInput);
    const { files, tokens, rewritten } = extractLocalFiles(parsed);

    const tokenToUrl = new Map<string, string>();
    let uploadedRefs: Awaited<ReturnType<typeof uploadFiles>>["refs"] = [];

    try {
      if (files.length > 0) {
        const { urls, refs } = await uploadFiles(files);
        uploadedRefs = refs;
        // tokens preserves insertion order; uploadFiles returns urls in
        // the same order as the input array.
        let i = 0;
        for (const token of tokens.keys()) {
          const url = urls[i++];
          if (url) tokenToUrl.set(token, url);
        }
      }
      const finalInput = substituteTokens(rewritten, tokenToUrl);

      const client = createClient();
      const result = await client.media.run.mutate({
        endpoint_id: args.endpoint_id,
        input: finalInput,
        async: Boolean(args.async),
      });

      if (result.status === "submitted") {
        const payload = {
          status: "submitted",
          endpoint_id: result.endpoint_id,
          request_id: result.request_id,
          hint: `Check status: vg media status ${result.endpoint_id} ${result.request_id}`,
        };
        if (isJsonOutput(args)) writeJson(payload);
        else {
          consola.success(`Submitted ${result.endpoint_id}`);
          consola.log(`  request_id: ${result.request_id}`);
        }
        return;
      }

      let downloaded: Awaited<ReturnType<typeof downloadMedia>> | undefined;
      if (downloadFlag.mode === "on") {
        const refs = extractMediaRefs(result.result);
        downloaded = await downloadMedia({
          refs,
          template: downloadFlag.template,
          requestId: result.request_id,
        });
      }

      const payload = {
        status: "completed",
        endpoint_id: result.endpoint_id,
        request_id: result.request_id,
        result: result.result,
        billable_units: result.billable_units,
        ...(downloaded ? { downloaded_files: downloaded.downloaded } : {}),
        ...(downloaded && downloaded.failed.length > 0
          ? { download_failures: downloaded.failed }
          : {}),
      };

      if (isJsonOutput(args)) {
        writeJson(payload);
      } else {
        consola.success(`Run completed (${result.request_id})`);
        if (downloaded) {
          for (const path of downloaded.downloaded) consola.log(`  ${path}`);
          for (const f of downloaded.failed) consola.warn(`  failed: ${f.url} (${f.error})`);
        }
        if (!downloaded || downloaded.downloaded.length === 0) {
          for (const url of extractMediaUrls(result.result)) consola.log(`  ${url}`);
        }
      }
    } finally {
      await cleanupUploads(uploadedRefs).catch(() => undefined);
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
    const probe = extractLocalFiles({ __: args.path });
    const file = probe.files[0];
    if (!file) {
      consola.error(`File not found: ${args.path}`);
      process.exit(1);
    }
    const { urls } = await uploadFiles([file]);
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

function stripPositional(argv: string[], positional: string): string[] {
  // citty hands the positional to args.endpoint_id but it also still
  // shows up in rawArgs. Remove the first non-flag occurrence so the
  // run-input parser doesn't try to interpret it as a `--<key> value`.
  const out: string[] = [];
  let removed = false;
  for (const arg of argv) {
    if (!removed && arg === positional && !arg.startsWith("--")) {
      removed = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function extractMediaUrls(result: unknown): string[] {
  return extractMediaRefs(result).map((r) => r.url);
}
