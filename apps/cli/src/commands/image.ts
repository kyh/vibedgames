import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";

import { IMAGE_PROVIDERS } from "@repo/api/image/types";
import type { ImageProviderName } from "@repo/api/image/types";
import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";

type RunOutput = {
  url: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
};

type RunResult = {
  runId: string;
  provider: string;
  model: string;
  outputs: RunOutput[];
  metadata: Record<string, unknown>;
};

function parseProvider(value: string | undefined): ImageProviderName {
  if (!value || !IMAGE_PROVIDERS.includes(value as ImageProviderName)) {
    consola.error(`--provider must be one of: ${IMAGE_PROVIDERS.join(", ")}`);
    process.exit(1);
  }
  return value as ImageProviderName;
}

function parseParams(
  value: string | undefined,
  fileValue: string | undefined,
): Record<string, unknown> {
  if (value && fileValue) {
    consola.error("Use either --params or --params-file, not both.");
    process.exit(1);
  }
  const raw = fileValue
    ? readFileSync(resolve(fileValue), "utf-8")
    : value;
  if (!raw || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    consola.error(
      `--params must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

function readPromptText(prompt?: string, promptFile?: string): string {
  if ((prompt ? 1 : 0) + (promptFile ? 1 : 0) !== 1) {
    consola.error("Provide exactly one of --prompt or --prompt-file");
    process.exit(1);
  }
  if (prompt) return prompt;
  return readFileSync(resolve(promptFile!), "utf-8").trim();
}

function contentTypeFor(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function readImage(path: string): {
  filename: string;
  contentType: string;
  base64: string;
} {
  const abs = resolve(path);
  const bytes = readFileSync(abs);
  return {
    filename: basename(abs),
    contentType: contentTypeFor(abs),
    base64: bytes.toString("base64"),
  };
}

function collectImages(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

async function downloadOutput(
  output: RunOutput,
  outDir: string,
  filenamePrefix: string,
  index: number,
): Promise<string> {
  const seq = String(index + 1).padStart(2, "0");
  const ext = extname(output.filename) || ".bin";
  const target = resolve(outDir, `${filenamePrefix}-${seq}${ext}`);
  const res = await fetch(output.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${output.filename} (${res.status} ${res.statusText})`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(target, buf);
  return target;
}

async function runImage({
  task,
  args,
}: {
  task: "generate" | "edit";
  args: {
    provider?: string;
    model?: string;
    prompt?: string;
    "prompt-file"?: string;
    "out-dir"?: string;
    "filename-prefix"?: string;
    params?: string;
    "params-file"?: string;
    image?: string | string[];
    json?: boolean;
  };
}): Promise<void> {
  const provider = parseProvider(args.provider);
  if (!args.model || args.model.length === 0) {
    consola.error("--model is required");
    process.exit(1);
  }
  if (!args["out-dir"]) {
    consola.error("--out-dir is required");
    process.exit(1);
  }

  const promptText = readPromptText(args.prompt, args["prompt-file"]);
  const params = parseParams(args.params, args["params-file"]);
  const inputImages = collectImages(args.image).map((p) => readImage(p));

  const outDir = resolve(args["out-dir"]);
  const filenamePrefix = args["filename-prefix"] ?? "image";

  const client = createClient();
  let result: RunResult;
  try {
    result = (await client.image.run.mutate({
      provider,
      task,
      model: args.model,
      prompt: promptText,
      params,
      inputImages,
    })) as RunResult;
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const written = await Promise.all(
    result.outputs.map((output, i) =>
      downloadOutput(output, outDir, filenamePrefix, i),
    ),
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          runId: result.runId,
          provider: result.provider,
          model: result.model,
          outputs: written,
          metadata: result.metadata,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    consola.success(
      `Generated ${written.length} image${written.length === 1 ? "" : "s"} (run ${result.runId})`,
    );
    for (const path of written) consola.log(`  ${path}`);
  }
}

const sharedArgs = {
  provider: {
    type: "string",
    description: "Provider: openai, fal, or retro-diffusion",
    required: true,
  },
  model: {
    type: "string",
    description:
      "Provider model id (OpenAI: gpt-image-1.5; fal: endpoint id; retro-diffusion: prompt_style)",
    required: true,
  },
  prompt: {
    type: "string",
    description: "Prompt text",
  },
  "prompt-file": {
    type: "string",
    description: "Path to a file containing the prompt",
  },
  "out-dir": {
    type: "string",
    description: "Directory to write generated images to",
    required: true,
  },
  "filename-prefix": {
    type: "string",
    description: "Prefix for written filenames (default: image)",
  },
  params: {
    type: "string",
    description: "JSON object of provider-specific params (e.g. quality, size)",
  },
  "params-file": {
    type: "string",
    description:
      "Path to a JSON file with provider-specific params. Use this when params include large fields (e.g. base64 images) that may exceed argv limits.",
  },
  json: {
    type: "boolean",
    description: "Print the run result as JSON to stdout",
  },
  image: {
    type: "string",
    description:
      "Path to an input image. Repeat --image for multiple references. Required for `edit`; optional for `generate` (e.g. img2img, style references).",
  },
} as const;

const generateCommand = defineCommand({
  meta: {
    name: "generate",
    description: "Generate one or more images from a prompt.",
  },
  args: sharedArgs,
  run: async ({ args }) => {
    await runImage({ task: "generate", args });
  },
});

const editCommand = defineCommand({
  meta: {
    name: "edit",
    description: "Edit one or more input images with a prompt.",
  },
  args: sharedArgs,
  run: async ({ args }) => {
    await runImage({ task: "edit", args });
  },
});

export const imageCommand = defineCommand({
  meta: {
    name: "image",
    description: "Generate and edit images via vibedgames-managed providers.",
  },
  subCommands: {
    generate: generateCommand,
    edit: editCommand,
  },
});
