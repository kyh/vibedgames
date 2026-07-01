import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

import consola from "consola";
import spawn from "cross-spawn";

import { readExplicitLocalFile } from "./media-args.js";

// `vg generate run` can execute against the vibedgames model runner
// (default) or delegate image generation to a locally-installed Codex
// CLI. The Codex path uses the user's own Codex/ChatGPT plan and never
// touches the vibedgames backend — useful for users whose plan already
// bundles image generation.
export type Provider = "vibedgames" | "codex";

/**
 * Resolve the effective provider from the `--provider` flag, falling back
 * to the `VG_GENERATE_PROVIDER` env var and finally the vibedgames
 * default. Unknown values throw so a typo (`--provider coddex`) fails
 * loudly instead of silently hitting the paid backend.
 */
export function resolveProvider(flag?: string): Provider {
  const raw = (flag ?? process.env.VG_GENERATE_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "codex") return "codex";
  if (raw === "" || raw === "vibedgames" || raw === "fal" || raw === "default") {
    return "vibedgames";
  }
  throw new Error(`Unknown --provider "${raw}". Supported: vibedgames (default), codex.`);
}

// Input keys we map onto Codex's natural-language image request. Codex
// only exposes a single built-in image model, so most fal-style params
// don't apply — we fold the few that have a meaning (prompt, count,
// size, reference images) into the prompt / CLI flags and ignore the
// rest rather than erroring.
const PROMPT_KEYS = ["prompt", "text"] as const;
const COUNT_KEYS = ["num_images", "num_outputs", "n", "count"] as const;
const REF_KEYS = [
  "image_url",
  "image_urls",
  "image",
  "images",
  "input_image",
  "reference_image_url",
  "reference_image_urls",
] as const;

const MAX_IMAGES = 8;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export type CodexInput = {
  prompt: string;
  count: number;
  sizeHint?: string;
  /** Raw reference values from the input; may be local paths or URLs. */
  referenceCandidates: string[];
};

/**
 * Pull the fields Codex can act on out of the parsed `run` input. Pure:
 * no filesystem access, so the reference values are returned verbatim and
 * resolved to local files later.
 */
export function parseCodexInput(input: Record<string, unknown>): CodexInput {
  let prompt = "";
  for (const key of PROMPT_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) {
      prompt = v.trim();
      break;
    }
  }

  let count = 1;
  for (const key of COUNT_KEYS) {
    const v = input[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      count = Math.max(1, Math.min(MAX_IMAGES, Math.floor(v)));
      break;
    }
  }

  const referenceCandidates: string[] = [];
  for (const key of REF_KEYS) {
    const v = input[key];
    if (typeof v === "string") referenceCandidates.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") referenceCandidates.push(item);
    }
  }

  return { prompt, count, sizeHint: buildSizeHint(input), referenceCandidates };
}

function buildSizeHint(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const size = input.image_size ?? input.size;
  if (typeof size === "string" && size.trim().length > 0) parts.push(size.trim());
  const aspect = input.aspect_ratio;
  if (typeof aspect === "string" && aspect.trim().length > 0) {
    parts.push(`aspect ratio ${aspect.trim()}`);
  }
  const w = input.width;
  const h = input.height;
  if (typeof w === "number" && typeof h === "number") parts.push(`${w}x${h}px`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Build the natural-language instruction handed to `codex exec`. We pin
 * exact output filenames and the working directory so the generated
 * files land somewhere we can deterministically collect them.
 */
export function buildCodexPrompt(
  input: CodexInput,
  filenames: string[],
  hasReferences: boolean,
): string {
  const n = filenames.length;
  const noun = n === 1 ? "image" : `${n} images`;
  const lines = [
    hasReferences
      ? `Edit the attached reference image to produce ${noun} using your built-in image generation.`
      : `Generate ${noun} using your built-in image generation.`,
    `Prompt: ${input.prompt}`,
  ];
  if (input.sizeHint) lines.push(`Size: ${input.sizeHint}.`);
  lines.push(
    `Save the output as PNG into the current working directory using exactly ` +
      `these filenames: ${filenames.join(", ")}.`,
    `Do not read, create, or modify any other files, and do not write or run code. $imagegen`,
  );
  return lines.join("\n");
}

/**
 * Choose the on-disk destination for a collected Codex output, mirroring
 * the `--download` template semantics used for the vibedgames path
 * ({index}, {ext}, {request_id} placeholders; bare path treated as a
 * directory or a literal file by extension).
 */
export function renderLocalTarget(
  template: string | undefined,
  index: number,
  ext: string,
  requestId: string,
  count: number,
): string {
  if (!template) {
    return resolve(process.cwd(), `codex-image-${requestId}-${index}.${ext}`);
  }
  if (template.includes("{")) {
    const rendered = template
      .replaceAll("{index}", String(index))
      .replaceAll("{ext}", ext)
      .replaceAll("{request_id}", requestId)
      .replaceAll("{name}", "output");
    return resolve(rendered);
  }
  if (extname(template)) {
    if (count <= 1) return resolve(template);
    const e = extname(template);
    const stem = template.slice(0, template.length - e.length);
    return resolve(index === 0 ? template : `${stem}_${index}${e}`);
  }
  return resolve(template, `codex-image-${index}.${ext}`);
}

type CodexRun = {
  requestId: string;
  prompt: string;
  /** Absolute paths to the images Codex produced, in a stable order. */
  rawFiles: string[];
};

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function listImages(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const ext = extname(name).slice(1).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // Raced away between readdir and stat; skip.
    }
  }
  return out.toSorted();
}

/**
 * Delegate image generation to the local `codex` CLI. Runs
 * `codex exec` in an isolated temp workspace, then collects the produced
 * images from that workspace (and, as a fallback, from Codex's default
 * `generated_images` store). Throws with actionable guidance when Codex
 * is missing, fails, or produces nothing.
 */
export async function generateImagesWithCodex(opts: {
  input: Record<string, unknown>;
  quiet: boolean;
}): Promise<CodexRun> {
  const parsed = parseCodexInput(opts.input);
  if (!parsed.prompt) {
    throw new Error("codex image generation requires a prompt (--prompt).");
  }

  const references: string[] = [];
  for (const candidate of parsed.referenceCandidates) {
    const local = readExplicitLocalFile(candidate);
    if (local) references.push(local.path);
    else if (!opts.quiet) {
      consola.warn(`Ignoring non-local reference for codex provider: ${candidate}`);
    }
  }

  const requestId = randomBytes(4).toString("hex");
  const workDir = mkdtempSync(join(tmpdir(), "vg-codex-"));
  const filenames = Array.from({ length: parsed.count }, (_, i) => `output-${i}.png`);
  const prompt = buildCodexPrompt(parsed, filenames, references.length > 0);

  const bin = process.env.VG_CODEX_BIN ?? "codex";
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-C",
    workDir,
    ...references.flatMap((r) => ["-i", r]),
    prompt,
  ];

  // Snapshot Codex's default image store so we can tell which files this
  // run produced if the model saves there instead of the workspace.
  const storeDir = join(codexHome(), "generated_images");
  const before = new Set(listImages(storeDir));

  const outcome = await spawnCodex(bin, args, workDir, opts.quiet);
  if (outcome.notFound) {
    throw new Error(
      `The \`codex\` CLI was not found on PATH. Install it (npm install -g @openai/codex) ` +
        `and sign in with \`codex login\`, or drop --provider codex to use vibedgames. ` +
        `Set VG_CODEX_BIN to point at a specific binary.`,
    );
  }
  if (outcome.code !== 0) {
    throw new Error(`codex exec exited with code ${outcome.code}.${tail(outcome.stderr)}`);
  }

  const fromWork = listImages(workDir);
  const fromStore = listImages(storeDir).filter((p) => !before.has(p));
  const rawFiles = fromWork.length > 0 ? fromWork : fromStore;
  if (rawFiles.length === 0) {
    throw new Error(
      `codex produced no image files. It may have declined the request or lack ` +
        `image-generation access on the signed-in plan.${tail(outcome.stderr)}`,
    );
  }

  return { requestId, prompt, rawFiles };
}

/**
 * Copy Codex's raw outputs to their final destinations per the
 * `--download` template (or default cwd naming). Returns the written
 * paths and any per-file failures.
 */
export function placeCodexOutputs(
  rawFiles: string[],
  template: string | undefined,
  requestId: string,
): { downloaded: string[]; failed: { source: string; error: string }[] } {
  const downloaded: string[] = [];
  const failed: { source: string; error: string }[] = [];
  rawFiles.forEach((source, index) => {
    const ext = extname(source).slice(1).toLowerCase() || "png";
    const target = renderLocalTarget(template, index, ext, requestId, rawFiles.length);
    try {
      if (resolve(source) !== target) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      downloaded.push(target);
    } catch (err) {
      failed.push({ source, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return { downloaded, failed };
}

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").slice(-8).join("\n");
  return `\n${lines}`;
}

function spawnCodex(
  bin: string,
  args: string[],
  cwd: string,
  quiet: boolean,
): Promise<{ code: number; stderr: string; notFound: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      // Codex prints only its final message to stdout; surface it as
      // progress for humans but keep it out of our JSON on stdout.
      if (!quiet) process.stderr.write(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (!quiet) process.stderr.write(c);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolvePromise({
        code: 1,
        stderr: stderr + err.message,
        notFound: err.code === "ENOENT",
      });
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stderr, notFound: false });
    });
  });
}
