import { readFileSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";

import type { RouterOutputs } from "@repo/api";
import type { ImageInputRole, ImageProviderName } from "@repo/api/image/types";

import { createClient } from "./api.js";
import type { OutputTarget } from "./image-output.js";
import { ensureDir, writeBytes } from "./image-output.js";
import { MultiProgress } from "./image-progress.js";
import type { ModelSpec } from "./image-models.js";
import { pMap } from "./p-map.js";

export type ImageJob = {
  index: number;
  spec: ModelSpec;
  /** 1-based copy index when count > 1, else 1. */
  copy: number;
  label: string;
};

export type ImageJobResult = {
  index: number;
  modelDisplay: string;
  provider: ImageProviderName;
  model: string;
  ok: boolean;
  elapsedMs: number;
  files: string[];
  /** Server-side runId, the R2 prefix under image-runs/{userId}/{runId}/. */
  runId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type RunJobsOptions = {
  task: "generate" | "edit";
  prompt: string;
  models: ModelSpec[];
  count: number;
  params: Record<string, unknown>;
  inputImages: {
    role: ImageInputRole;
    path: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }[];
  output: OutputTarget;
  filenamePrefix: string;
  concurrency: number;
  quiet: boolean;
};

type RunOutput = {
  url: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
};

type RunResult = RouterOutputs["image"]["run"];
type CreateInputUploadsResult = RouterOutputs["image"]["createInputUploads"];
type InputImageRef = CreateInputUploadsResult["uploads"][number]["ref"];

// Errors that will fail every sibling job in the same batch identically
// (no point in continuing). tRPC client errors expose `data.code` /
// `data.httpStatus` we can pattern-match on; we also catch the "Not
// logged in" message createClient throws when there's no saved token.
const FATAL_TRPC_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "LENGTH_REQUIRED",
]);

function isFatalForBatch(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const data = isRecord(err.data) ? err.data : null;
  if (data && typeof data.code === "string" && FATAL_TRPC_CODES.has(data.code)) {
    return true;
  }
  if (data && typeof data.httpStatus === "number") {
    if (
      data.httpStatus === 401 ||
      data.httpStatus === 403 ||
      data.httpStatus === 411 ||
      data.httpStatus === 412 ||
      data.httpStatus === 413
    ) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildJobs(models: ModelSpec[], count: number): ImageJob[] {
  const jobs: ImageJob[] = [];
  let index = 0;
  for (const spec of models) {
    for (let copy = 1; copy <= count; copy++) {
      const label = count > 1 ? `${spec.display} (${copy}/${count})` : spec.display;
      jobs.push({ index: index++, spec, copy, label });
    }
  }
  return jobs;
}

export async function runJobs(
  options: RunJobsOptions,
): Promise<{ results: ImageJobResult[]; totalElapsedMs: number }> {
  const jobs = buildJobs(options.models, options.count);
  if (jobs.length === 0) {
    throw new Error("No jobs to run — pass at least one --model.");
  }

  ensureDir(options.output.dir);

  const client = createClient();
  const inputRefs = await uploadInputImages(client, options.inputImages);
  const showProgress = !options.quiet;
  const progress = showProgress ? new MultiProgress(jobs.map((j) => j.label)) : null;

  const start = Date.now();

  let results: ImageJobResult[];
  try {
    progress?.start();
    results = await pMap<ImageJob, ImageJobResult>(
      jobs,
      async (job) => {
        const jobStart = Date.now();
        progress?.update(job.index, { state: "running" });
        try {
          const result: RunResult = await client.image.run.mutate({
            provider: job.spec.provider,
            task: options.task,
            model: job.spec.model,
            prompt: options.prompt,
            params: options.params,
            inputImages: inputRefs,
          });

          const files = await writeOutputs(result.outputs, options, job);
          const elapsed = Date.now() - jobStart;
          progress?.update(job.index, {
            state: "done",
            detail: files[0] ?? "(no files)",
          });
          return {
            index: job.index,
            modelDisplay: job.spec.display,
            provider: job.spec.provider,
            model: job.spec.model,
            ok: true,
            elapsedMs: elapsed,
            files,
            runId: result.runId,
            metadata: result.metadata,
          };
        } catch (err) {
          // Cross-model fan-out semantics: a per-model failure (timeout,
          // moderation, content-policy, network blip) shouldn't tank the
          // whole batch — surface it as an `ok: false` result so the
          // caller still sees outputs from sibling models. For errors
          // that will fail every sibling identically (auth missing or
          // bad, server misconfiguration), re-throw so pMap aborts and
          // we don't burn through more API calls / progress lines.
          const message = err instanceof Error ? err.message : String(err);
          if (isFatalForBatch(err)) {
            progress?.update(job.index, { state: "failed", detail: message });
            throw err;
          }
          const elapsed = Date.now() - jobStart;
          progress?.update(job.index, { state: "failed", detail: message });
          return {
            index: job.index,
            modelDisplay: job.spec.display,
            provider: job.spec.provider,
            model: job.spec.model,
            ok: false,
            elapsedMs: elapsed,
            files: [],
            error: message,
          };
        }
      },
      { concurrency: options.concurrency },
    );
  } finally {
    // Always tear down the spinner interval, even when pMap rejects with
    // a fatal error; otherwise the progress timer keeps redrawing on a
    // dead run.
    progress?.stop();
    await cleanupInputImages(client, inputRefs);
  }

  return { results, totalElapsedMs: Date.now() - start };
}

async function uploadInputImages(
  client: ReturnType<typeof createClient>,
  images: RunJobsOptions["inputImages"],
): Promise<InputImageRef[]> {
  if (images.length === 0) return [];
  const created: CreateInputUploadsResult = await client.image.createInputUploads.mutate({
    images: images.map((image) => ({
      role: image.role,
      filename: image.filename,
      contentType: image.contentType,
      sizeBytes: image.sizeBytes,
    })),
  });

  const refs = created.uploads.map((upload) => upload.ref);
  try {
    await Promise.all(
      created.uploads.map(async (upload, index) => {
        const image = images[index];
        if (!image) throw new Error(`Missing local input image ${index}.`);
        const res = await fetch(upload.url, {
          method: "PUT",
          headers: upload.headers,
          body: readFileSync(image.path),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Input image upload failed for ${image.filename}: ${res.status} ${res.statusText} ${text}`,
          );
        }
      }),
    );
  } catch (err) {
    await cleanupInputImages(client, refs);
    throw err;
  }

  return refs;
}

async function cleanupInputImages(
  client: ReturnType<typeof createClient>,
  refs: InputImageRef[],
): Promise<void> {
  if (refs.length === 0) return;
  try {
    await client.image.cleanupInputUploads.mutate({
      keys: refs.map((ref) => ref.key),
    });
  } catch {
    // Best effort. Uploaded refs are short-lived scratch objects.
  }
}

async function writeOutputs(
  outputs: RunOutput[],
  options: RunJobsOptions,
  job: ImageJob,
): Promise<string[]> {
  const written: string[] = [];
  // `Promise.allSettled` lets every concurrent download either finish writing
  // or fail before we touch the disk. If we used `Promise.all` and one
  // sibling rejected first, the cleanup loop would race against still-
  // in-flight `writeBytes` calls and could leave the very files it just
  // unlinked on disk a moment later.
  const settled = await Promise.allSettled(
    outputs.map(async (output, i) => {
      const ext = extname(output.filename) || ".bin";
      const target = pickTarget(options, job, i, outputs.length, ext);
      const res = await fetch(output.url);
      if (!res.ok) {
        throw new Error(`Failed to download ${output.filename} (${res.status} ${res.statusText})`);
      }
      writeBytes(target, Buffer.from(await res.arrayBuffer()));
      written[i] = target;
    }),
  );
  const firstReason = settled.find((r) => r.status === "rejected");
  if (firstReason && firstReason.status === "rejected") {
    for (const path of written) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        // Ignore: file might already be missing or the user may have moved it.
      }
    }
    throw firstReason.reason instanceof Error
      ? firstReason.reason
      : new Error(String(firstReason.reason));
  }
  return written;
}

function pickTarget(
  options: RunJobsOptions,
  job: ImageJob,
  outputIndex: number,
  outputCount: number,
  ext: string,
): string {
  // Single-file --output mode is only honored for single-job, single-output
  // runs; otherwise multiple outputs would clobber each other.
  if (
    options.output.kind === "file" &&
    options.models.length * options.count === 1 &&
    outputCount === 1
  ) {
    return options.output.path;
  }
  const dir = options.output.dir;
  const slug = sanitize(job.spec.display) || "model";
  const seq = String(outputIndex + 1).padStart(2, "0");
  const copy = options.count > 1 ? `-${String(job.copy).padStart(2, "0")}` : "";
  const slot = `-j${String(job.index + 1).padStart(2, "0")}`;
  const stem =
    options.models.length > 1
      ? `${options.filenamePrefix}-${slug}${slot}${copy}-${seq}`
      : `${options.filenamePrefix}${copy}-${seq}`;
  return join(dir, `${stem}${ext}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
