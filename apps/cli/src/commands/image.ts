import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";

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

type Provider = "openai" | "fal" | "retro-diffusion";

const PROVIDERS: ReadonlySet<Provider> = new Set([
  "openai",
  "fal",
  "retro-diffusion",
]);

function parseProvider(value: string | undefined): Provider {
  if (!value || !PROVIDERS.has(value as Provider)) {
    consola.error(
      `--provider must be one of: ${Array.from(PROVIDERS).join(", ")}`,
    );
    process.exit(1);
  }
  return value as Provider;
}

function parseParams(value: string | undefined, paramsFile: string | undefined): Record<string, unknown> {
  if ((value ? 1 : 0) + (paramsFile ? 1 : 0) > 1) {
    consola.error("Provide at most one of --params or --params-file");
    process.exit(1);
  }
  const jsonStr = paramsFile ? readFileSync(resolve(paramsFile), "utf-8") : value;
  if (!jsonStr || jsonStr.length === 0) return {};
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
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
  mkdirSync(outDir, { recursive: true });
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

  if (task === "edit" && inputImages.length === 0) {
    consola.error("--image is required at least once for edit jobs");
    process.exit(1);
  }

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

  const written: string[] = [];
  for (let i = 0; i < result.outputs.length; i++) {
    const path = await downloadOutput(
      result.outputs[i]!,
      outDir,
      filenamePrefix,
      i,
    );
    written.push(path);
  }

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
    description: "Path to a file containing a JSON object of provider-specific params",
  },
  json: {
    type: "boolean",
    description: "Print the run result as JSON to stdout",
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
  args: {
    ...sharedArgs,
    image: {
      type: "string",
      description:
        "Path to an input image. Repeat --image for multiple references.",
      required: true,
    },
  },
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
