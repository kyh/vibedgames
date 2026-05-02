import { unlinkSync } from "node:fs";
import { extname, join } from "node:path";

import type { ImageProviderName } from "@repo/api/image/types";

import { createClient } from "./api.js";
import type { OutputTarget } from "./image-output.js";
import { ensureDir, writeBytes } from "./image-output.js";
import { MultiProgress } from "./image-progress.js";
import type { ModelSpec } from "./image-models.js";
import { pMap } from "./p-map.js";

export type ImageJob = {
  index: number;
  spec: ModelSpec;
  /** 0-based position of `spec` within `options.models`, used to keep
   *  filenames distinct when the same model is listed twice. */
  slot: number;
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
  inputImages: { filename: string; contentType: string; base64: string }[];
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

type RunResult = {
  runId: string;
  provider: ImageProviderName;
  model: string;
  outputs: RunOutput[];
  metadata: Record<string, unknown>;
};

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
  if (!err || typeof err !== "object") return false;
  const data = (err as { data?: { code?: unknown; httpStatus?: unknown } }).data;
  if (data && typeof data.code === "string" && FATAL_TRPC_CODES.has(data.code)) {
    return true;
  }
  if (data && typeof data.httpStatus === "number") {
    if (data.httpStatus === 401 || data.httpStatus === 403 || data.httpStatus === 411 || data.httpStatus === 412 || data.httpStatus === 413) {
      return true;
    }
  }
  return false;
}

function buildJobs(models: ModelSpec[], count: number): ImageJob[] {
  const jobs: ImageJob[] = [];
  let index = 0;
  for (let slot = 0; slot < models.length; slot++) {
    const spec = models[slot]!;
    for (let copy = 1; copy <= count; copy++) {
      const label =
        count > 1 ? `${spec.display} (${copy}/${count})` : spec.display;
      jobs.push({ index: index++, spec, slot, copy, label });
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

  const showProgress = !options.quiet;
  const progress = showProgress
    ? new MultiProgress(jobs.map((j) => j.label))
    : null;
  progress?.start();

  const start = Date.now();
  const client = createClient();

  const results = await pMap<ImageJob, ImageJobResult>(
    jobs,
    async (job) => {
      const jobStart = Date.now();
      progress?.update(job.index, { state: "running" });
      try {
        const result = (await client.image.run.mutate({
          provider: job.spec.provider,
          task: options.task,
          model: job.spec.model,
          prompt: options.prompt,
          params: options.params,
          inputImages: options.inputImages,
        })) as RunResult;

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

  progress?.stop();

  return { results, totalElapsedMs: Date.now() - start };
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
        throw new Error(
          `Failed to download ${output.filename} (${res.status} ${res.statusText})`,
        );
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
  const slug = sanitize(job.spec.display);
  const seq = String(outputIndex + 1).padStart(2, "0");
  const copy = options.count > 1 ? `-${String(job.copy).padStart(2, "0")}` : "";
  // When the same model display appears more than once in --model, the
  // slug+copy alone don't disambiguate the jobs and writeOutputs would
  // race to clobber the file. Suffix the slot index in that case.
  const duplicated =
    options.models.filter((m) => m.display === job.spec.display).length > 1;
  const slot = duplicated
    ? `-s${String(job.slot + 1).padStart(2, "0")}`
    : "";
  const stem =
    options.models.length > 1
      ? `${options.filenamePrefix}-${slug}${slot}${copy}-${seq}`
      : `${options.filenamePrefix}${copy}-${seq}`;
  return join(dir, `${stem}${ext}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
