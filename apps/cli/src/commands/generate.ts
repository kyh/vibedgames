import { defineCommand } from "citty";
import type { z } from "zod";
import { consola } from "consola";

import {
  animate3dInput,
  imageInput,
  model3dInput,
  musicInput,
  removeBackgroundInput,
  soundInput,
  speechInput,
  videoInput,
} from "@repo/contract/generate/media-schema";

import { createClient } from "../lib/api.js";
import {
  CodexError,
  generateImagesWithCodex,
  placeCodexOutputs,
  chooseProvider,
} from "../lib/codex.js";
import { parseDownloadFlag, parseRunInput, readExplicitLocalFile } from "../lib/media-args.js";
import type { DownloadFlag } from "../lib/media-args.js";
import { downloadMedia, extractMediaRefs } from "../lib/media-download.js";
import { mediaFlagArgs, readMediaInput } from "../lib/media-flags.js";
import { waitForCompletion } from "../lib/media-poll.js";
import { uploadFile } from "../lib/media-upload.js";
import { isJsonOutput, outputArgs, writeJson, writeStructured } from "../lib/output.js";
import { isJsonNumber, isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonObject, JsonValue } from "../lib/types.js";

type DownloadOutcome = Awaited<ReturnType<typeof downloadMedia>>;

type DownloadFailure = DownloadOutcome["failed"][number];

type FormatMismatch = DownloadOutcome["mislabeled"][number];

interface ActionFields {
  status?: string;
  queue_position?: number;
  logs?: JsonValue;
  result?: JsonValue;
}

const buildActionFields = (action: "status" | "result" | "cancel", data: JsonValue) => {
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

const isStructuredOutput = (args: { json?: boolean; field?: string }) =>
  isJsonOutput(args) || Boolean(args.field);

const extractMediaUrls = (result: JsonValue) => extractMediaRefs(result).map((r) => r.url);

const warnMislabeled = (mislabeled: FormatMismatch[]) => {
  for (const m of mislabeled) {
    consola.warn(`  ${m.path} holds ${m.actual.toUpperCase()} data, not what its extension says`);
  }
};

const runViaCodex = async (opts: {
  args: { async?: boolean; json?: boolean; field?: string; quiet?: boolean };
  finalInput: JsonObject;
  downloadFlag: DownloadFlag;
  endpoint_id: string;
}) => {
  const { args, finalInput, downloadFlag, endpoint_id } = opts;

  if (args.async === true) {
    consola.error("--async is not supported with --provider codex (Codex runs synchronously).");
    process.exit(1);
  }

  let result: Awaited<ReturnType<typeof generateImagesWithCodex>>;

  try {
    result = await generateImagesWithCodex({ input: finalInput });
  } catch (error) {
    if (error instanceof CodexError) {
      consola.error(error.message);
      process.exit(1);
    }

    throw error;
  }

  const { requestId, rawFiles, prompt, ignoredReferences } = result;

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

const buildRunPayload = (
  endpointId: string,
  completed: { request_id: string; result: JsonValue },
  downloaded: DownloadOutcome | undefined,
) => {
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
) => {
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

  if (
    downloaded === undefined ||
    downloaded.downloaded.length === undefined ||
    downloaded.downloaded.length === 0
  ) {
    for (const url of extractMediaUrls(completed.result)) {
      consola.log(`  ${url}`);
    }
  }
};

interface Submission {
  endpoint_id: string;
  request_id: string;
  result: JsonValue;
  status: string;
}

const finishRun = async (
  client: ReturnType<typeof createClient>,
  opts: {
    args: { async?: boolean; json?: boolean; field?: string; quiet?: boolean };
    downloadFlag: DownloadFlag;
    submission: Submission;
  },
) => {
  const { args, downloadFlag, submission } = opts;
  const { endpoint_id } = submission;
  const requestId = submission.request_id;

  if (args.async === true) {
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

  const completed =
    submission.status.toUpperCase() === "COMPLETED"
      ? { request_id: requestId, result: submission.result }
      : await waitForCompletion(client, endpoint_id, requestId, {
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
        "Backend for this run: vibedgames, or codex (image generation through the local Codex CLI and your own Codex plan). Without it, the saved preference applies: `vg config set generate.provider codex` sends OpenAI image runs to Codex. The literal endpoint `codex` implies codex.",
      type: "string",
    },
    ...outputArgs,
    quiet: { description: "Suppress progress output during sync runs.", type: "boolean" },
  },
  meta: { description: "Run a model (waits for result by default).", name: "run" },
  run: async ({ args, rawArgs }) => {
    const downloadFlag = parseDownloadFlag(rawArgs);
    const finalInput = parseRunInput(rawArgs);
    const { endpoint_id } = args;

    const choice = chooseProvider(args.provider, {
      async: Boolean(args.async),
      endpointId: endpoint_id,
      input: finalInput,
    });

    if (choice.note !== undefined && choice.note !== "") {
      process.stderr.write(`${choice.note}\n`);
    }

    if (choice.provider === "codex") {
      await runViaCodex({ args, downloadFlag, endpoint_id, finalInput });

      return;
    }

    const client = createClient();

    const submission = await client.generate.run({
      endpoint_id,
      input: finalInput,
      wait_seconds: 0,
    });

    await finishRun(client, { args, downloadFlag, submission });
  },
});

interface RunCompletedPayload {
  status: string;
  endpoint_id: string;
  request_id: string;
  result: JsonValue;
  downloaded_files?: string[];
  download_failures?: DownloadFailure[];
  download_format_mismatches?: FormatMismatch[];
}

interface CodexRunPayload {
  status: string;
  provider: string;
  endpoint_id: string;
  request_id: string;
  result: { provider: string; prompt: string; images: { path: string }[] };
  downloaded_files: string[];
  download_failures?: DownloadFailure[];
  ignored_references?: string[];
}

const reportStatus = (
  action: "status" | "result" | "cancel",
  endpointId: string,
  requestId: string,
  data: JsonValue,
  downloaded: DownloadOutcome | undefined,
) => {
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

  if (
    action === "result" &&
    (downloaded === undefined ||
      downloaded.downloaded.length === undefined ||
      downloaded.downloaded.length === 0)
  ) {
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
    if (args.result === true && args.cancel === true) {
      consola.error("Pick one of --result or --cancel.");
      process.exit(1);
    }

    const downloadFlag = parseDownloadFlag(rawArgs);
    const wantResult = args.result === true || downloadFlag.mode === "on";
    let action: "status" | "result" | "cancel" = "status";

    if (args.cancel === true) {
      action = "cancel";
    } else if (wantResult) {
      action = "result";
    }

    const client = createClient();

    const data = await client.generate.status({
      action,
      endpoint_id: args.endpoint_id,
      logs: Boolean(args.logs),
      request_id: args.request_id,
    });

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

interface StatusPayload extends ActionFields {
  action: "status" | "result" | "cancel";
  endpoint_id: string;
  request_id: string;
  downloaded_files?: string[];
  download_failures?: DownloadFailure[];
  download_format_mismatches?: FormatMismatch[];
}

const splitList = (value: string | undefined) => {
  if (value === undefined || value === "") {
    return [];
  }

  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const printModels = (data: JsonValue) => {
  const models = isJsonObject(data) && Array.isArray(data.models) ? data.models : [];

  for (const m of models) {
    if (!isJsonObject(m)) {
      continue;
    }

    const id = isJsonString(m.endpoint_id) ? m.endpoint_id : "?";
    const meta: JsonObject = isJsonObject(m.metadata) ? m.metadata : {};

    const tags = [meta.category, meta.status].filter(
      (tag): tag is string => isJsonString(tag) && tag !== "",
    );

    consola.log(`${id}${tags.length > 0 ? `  [${tags.join(", ")}]` : ""}`);
  }

  if (isJsonObject(data) && isJsonString(data.next_cursor) && data.next_cursor !== "") {
    consola.log(`\nnext_cursor: ${data.next_cursor}`);
  }
};

const MODEL_STATUSES = ["active", "deprecated", "all"] as const;

const MODEL_EXPANSIONS = ["openapi-3.0", "enterprise_status"] as const;

const pickOne = <T extends string>(allowed: readonly T[], value: string, flag: string) => {
  const found = allowed.find((option) => option === value);

  if (found === undefined || found === "") {
    consola.error(`--${flag} takes ${allowed.join(" | ")}, not "${value}".`);
    process.exit(1);
  }

  return found;
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
    const endpointIds = splitList(args.endpoint_id);
    const expand = splitList(args.expand).map((e) => pickOne(MODEL_EXPANSIONS, e, "expand"));

    const data = await createClient().generate.models({
      category: args.category === undefined || args.category === "" ? undefined : args.category,
      cursor: args.cursor === undefined || args.cursor === "" ? undefined : args.cursor,
      endpoint_id: endpointIds.length > 0 ? endpointIds : undefined,
      expand: expand.length > 0 ? expand : undefined,
      limit: args.limit !== undefined && args.limit !== "" ? Number(args.limit) : 20,
      query: args.query === undefined || args.query === "" ? undefined : args.query,
      status:
        args.status !== undefined && args.status !== ""
          ? pickOne(MODEL_STATUSES, args.status, "status")
          : undefined,
    });

    if (!writeStructured(data, args)) {
      printModels(data);
    }
  },
});

const schemaCommand = defineCommand({
  args: {
    endpoint_id: { required: true, type: "positional" },
    format: { description: "compact (default) | openapi", type: "string" },
    ...outputArgs,
  },
  meta: { description: "Fetch a model's input/output schema.", name: "schema" },
  run: async ({ args }) => {
    const data = await createClient().generate.schema({
      endpoint_id: args.endpoint_id,
      format: args.format === "openapi" ? "openapi" : "compact",
    });

    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

const pricingCommand = defineCommand({
  args: {
    endpoint_id: { required: true, type: "positional" },
    ...outputArgs,
  },
  meta: { description: "Fetch pricing for a model.", name: "pricing" },
  run: async ({ args }) => {
    const data = await createClient().generate.pricing({ endpoint_id: args.endpoint_id });

    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

const docsCommand = defineCommand({
  args: {
    query: { required: true, type: "positional" },
    ...outputArgs,
  },
  meta: { description: "Search generative-model documentation.", name: "docs" },
  run: async ({ args }) => {
    const data = await createClient().generate.docs({ query: args.query });

    if (!writeStructured(data, args)) {
      writeJson(data);
    }
  },
});

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

type Client = ReturnType<typeof createClient>;

const mediaCommand = <S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  submit: (client: Client, body: z.output<S>) => Promise<Submission>,
) =>
  defineCommand({
    args: {
      ...mediaFlagArgs(schema.shape),
      async: {
        description: "Submit to queue and return request_id without waiting.",
        type: "boolean",
      },
      download: {
        description:
          "Download media from result. Optional value is a path or template with {index},{name},{ext},{request_id}.",
        type: "string",
      },
      options: {
        description: "Any other model input as a JSON object; the flags above win.",
        type: "string",
      },
      ...outputArgs,
      quiet: { description: "Suppress progress output while waiting.", type: "boolean" },
    },
    meta: { description, name },
    run: async ({ args, rawArgs }) => {
      const client = createClient();
      const downloadFlag = parseDownloadFlag(rawArgs);

      const input = await readMediaInput(
        schema.shape,
        rawArgs,
        async (file) => await uploadFile(client, file),
      );

      const parsed = schema.safeParse({ ...input, wait_seconds: 0 });

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          consola.error(`--${issue.path.join(".") || "input"}: ${issue.message}`);
        }

        process.exit(1);
      }

      await finishRun(client, {
        args,
        downloadFlag,
        submission: await submit(client, parsed.data),
      });
    },
  });

const mediaCommands = {
  "3d": mediaCommand(
    "3d",
    "Generate a textured 3D model (GLB) from a prompt or an image.",
    model3dInput,
    async (client, body) => await client.generate.model3d(body),
  ),
  "animate-3d": mediaCommand(
    "animate-3d",
    "Rig a humanoid GLB and bake animation clips onto it.",
    animate3dInput,
    async (client, body) => await client.generate.animate3d(body),
  ),
  image: mediaCommand(
    "image",
    "Generate images from a prompt, or edit and combine reference images.",
    imageInput,
    async (client, body) => await client.generate.image(body),
  ),
  music: mediaCommand(
    "music",
    "Compose music from a prompt.",
    musicInput,
    async (client, body) => await client.generate.music(body),
  ),
  "remove-background": mediaCommand(
    "remove-background",
    "Cut an image's subject out onto a transparent background.",
    removeBackgroundInput,
    async (client, body) => await client.generate.removeBackground(body),
  ),
  sound: mediaCommand(
    "sound",
    "Generate a sound effect from a description.",
    soundInput,
    async (client, body) => await client.generate.sound(body),
  ),
  speech: mediaCommand(
    "speech",
    "Speak a line of text.",
    speechInput,
    async (client, body) => await client.generate.speech(body),
  ),
  video: mediaCommand(
    "video",
    "Generate a video clip from a prompt, or animate an image.",
    videoInput,
    async (client, body) => await client.generate.video(body),
  ),
};

export const generateCommand = defineCommand({
  meta: {
    description: "Generate, edit, and inspect images, video, and audio.",
    name: "generate",
  },
  subCommands: {
    ...mediaCommands,
    docs: docsCommand,
    models: modelsCommand,
    pricing: pricingCommand,
    run: runCommand,
    schema: schemaCommand,
    status: statusCommand,
    upload: uploadCommand,
  },
});
