import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import type { ImageProviderName } from "@repo/api/image/types";
import { IMAGE_PROVIDERS } from "@repo/api/image/types";
import { defineCommand } from "citty";
import consola from "consola";

import type { ModelSpec } from "../lib/image-models.js";
import { parseModelSpecs } from "../lib/image-models.js";
import { resolveOutputTarget } from "../lib/image-output.js";
import { runJobs } from "../lib/image-jobs.js";
import { readStdin } from "../lib/stdin.js";

const DEFAULT_CONCURRENCY = 4;

function parseProvider(
  value: string | undefined,
): ImageProviderName | undefined {
  if (!value || value.length === 0) return undefined;
  if (!IMAGE_PROVIDERS.includes(value as ImageProviderName)) {
    consola.error(
      `--provider must be one of: ${IMAGE_PROVIDERS.join(", ")}`,
    );
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
  const raw = fileValue ? readFileSync(resolve(fileValue), "utf-8") : value;
  if (!raw || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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

async function readPrompt(
  args: { prompt?: string; "prompt-file"?: string; _?: string[] },
): Promise<string> {
  const sources: string[] = [];
  if (args.prompt) sources.push(args.prompt);
  if (args["prompt-file"]) {
    sources.push(readFileSync(resolve(args["prompt-file"]), "utf-8").trim());
  }
  const piped = await readStdin();
  if (piped.trim().length > 0) sources.push(piped.trim());
  // Positional args: anything after the subcommand that wasn't a known flag.
  if (Array.isArray(args._)) {
    const positional = args._.join(" ").trim();
    if (positional.length > 0) sources.push(positional);
  }
  const prompt = sources.join("\n").trim();
  if (prompt.length === 0) {
    consola.error(
      "Prompt is required. Pass it positionally, via --prompt, --prompt-file, or stdin.",
    );
    process.exit(1);
  }
  return prompt;
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
  return Array.isArray(value) ? value : [value];
}

function resolveModels(
  raw: string | undefined,
  defaultProvider: ImageProviderName | undefined,
): ModelSpec[] {
  const fromFlag = raw ?? process.env.VG_IMAGE_MODEL;
  if (!fromFlag || fromFlag.trim().length === 0) {
    consola.error(
      "No model specified. Pass --model or set VG_IMAGE_MODEL (e.g. `gpt-image-1.5` or `openai:gpt-image-1.5,fal:fal-ai/nano-banana-pro`).",
    );
    process.exit(1);
  }
  try {
    return parseModelSpecs(fromFlag, defaultProvider);
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
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
    output?: string;
    "filename-prefix"?: string;
    params?: string;
    "params-file"?: string;
    image?: string | string[];
    n?: string;
    concurrency?: string;
    json?: boolean;
    quiet?: boolean;
    _?: string[];
  };
}): Promise<void> {
  const defaultProvider = parseProvider(args.provider);
  const models = resolveModels(args.model, defaultProvider);
  const prompt = await readPrompt(args);
  const params = parseParams(args.params, args["params-file"]);
  const inputImages = collectImages(args.image).map((p) => readImage(p));
  const count = args.n ? Math.max(1, parseInt(args.n, 10) || 1) : 1;
  const concurrency = args.concurrency
    ? Math.max(1, parseInt(args.concurrency, 10) || DEFAULT_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
  const output = resolveOutputTarget(
    args.output,
    process.env.VG_OUTPUT_DIR ?? process.cwd(),
  );
  const filenamePrefix = args["filename-prefix"] ?? "image";

  const { results, totalElapsedMs } = await runJobs({
    task,
    prompt,
    models,
    count,
    params,
    inputImages,
    output,
    filenamePrefix,
    concurrency,
    quiet: args.quiet === true || args.json === true,
  });

  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          totalMs: totalElapsedMs,
          ok: total - failed,
          failed,
          runs: results.map((r) => ({
            index: r.index + 1,
            model: r.modelDisplay,
            provider: r.provider,
            ok: r.ok,
            elapsedMs: r.elapsedMs,
            files: r.files,
            error: r.error,
            metadata: r.metadata,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (!args.quiet) {
    if (failed === 0) {
      consola.success(
        `Generated ${total} job${total === 1 ? "" : "s"} in ${(totalElapsedMs / 1000).toFixed(1)}s`,
      );
    } else {
      consola.warn(
        `${failed}/${total} job${total === 1 ? "" : "s"} failed in ${(totalElapsedMs / 1000).toFixed(1)}s`,
      );
    }
    for (const r of results) {
      if (r.ok) {
        for (const file of r.files) consola.log(`  ${file}`);
      }
    }
  }

  if (failed > 0) process.exit(1);
}

const sharedArgs = {
  provider: {
    type: "string",
    description:
      "Default provider when --model entries don't include one (openai/fal/retro-diffusion).",
  },
  model: {
    type: "string",
    description:
      "Model spec(s), comma-separated. Use `provider:model` (e.g. `openai:gpt-image-1.5`, `fal:fal-ai/nano-banana-pro`), a known alias, or set VG_IMAGE_MODEL.",
  },
  prompt: {
    type: "string",
    description: "Prompt text",
  },
  "prompt-file": {
    type: "string",
    description: "Path to a file containing the prompt",
  },
  output: {
    type: "string",
    alias: "o",
    description:
      "Output file (single run) or directory (multi-run). Defaults to VG_OUTPUT_DIR or the current directory.",
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
    description: "Print the run result as JSON to stdout (implies --quiet)",
  },
  quiet: {
    type: "boolean",
    alias: "q",
    description: "Suppress progress output.",
  },
  image: {
    type: "string",
    description:
      "Path to an input image. Repeat --image for multiple references. Required for `edit`.",
  },
  n: {
    type: "string",
    description: "Number of generations per model (default 1).",
  },
  concurrency: {
    type: "string",
    alias: "p",
    description: `Max parallel jobs (default ${DEFAULT_CONCURRENCY}).`,
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
    description:
      "Generate and edit images via vibedgames-managed providers. Auto-detects edit vs generate based on --image.",
  },
  args: sharedArgs,
  // Default behavior when invoked as `vg image ...` without a subcommand:
  // edit when an --image is provided, otherwise generate.
  run: async ({ args }) => {
    const task = collectImages(args.image).length > 0 ? "edit" : "generate";
    await runImage({ task, args });
  },
  subCommands: {
    generate: generateCommand,
    edit: editCommand,
  },
});
