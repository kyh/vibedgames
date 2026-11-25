import type { RecipeName } from "@repo/contract/asset/recipe-schema";
import type { JsonValue } from "@repo/contract/json";
import {
  fileFields,
  isRecipeName,
  MAX_RECIPE_OUTPUT_BYTES,
  RECIPES,
} from "@repo/contract/asset/recipe-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { MediaJobs, ORPCContext } from "../orpc";
import {
  holdRecipe,
  releaseRecipe,
  runningRecipeJobs,
  settleRecipe,
} from "../credits/recipe-metering";
import { purchasesEnabled } from "../credits/stripe";
import { requirePositiveBalance, storeFile } from "../generate/generate-router";
import { readBytesBounded } from "../generate/provider-io";

type RecipeFields = Readonly<Record<string, JsonValue | undefined>>;

const MAX_RUNNING = 2;
const POLL_MS = 2000;
const JOB_ID = /^rcp_(?:tools|blender)_[\w-]{8,64}$/u;

const finalOutput = z.object({
  bytes: z.number(),
  content_type: z.string(),
  name: z.string(),
  url: z.string(),
});

const finalRecord = z.object({ cost_usd: z.number(), outputs: z.array(finalOutput) });

const jobState = z.object({
  error: z.string().nullable(),
  final: finalRecord.nullable(),
  outputs: z.array(z.object({ bytes: z.number(), contentType: z.string(), name: z.string() })),
  recipe: z.string(),
  result: z.json().nullable(),
  seconds: z.number().nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  userId: z.string(),
});

type JobState = z.infer<typeof jobState>;

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- a Worker has no promise-returning timer to await
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const jobsOf = (context: ORPCContext, name: string) => {
  if (!context.mediaJobs) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `Hosted recipes do not run on this deployment. \`vg asset ${name}\` runs the recipe on your machine when the tool it needs is installed.`,
    });
  }

  return context.mediaJobs;
};

const userOf = (context: ORPCContext) => {
  const user = context.session?.user;

  if (!user) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return user;
};

const call = async (jobs: MediaJobs, jobId: string, suffix: string, init?: RequestInit) => {
  const res = await jobs.fetch(new Request(`https://media/jobs/${jobId}${suffix}`, init));

  if (res.status === 404) {
    throw new ORPCError("NOT_FOUND", { message: `No recipe job ${jobId}.` });
  }

  if (!res.ok) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `The recipe service answered ${res.status} for ${jobId}.`,
    });
  }

  return res;
};

const readState = async (jobs: MediaJobs, jobId: string) => {
  const res = await call(jobs, jobId, "");

  return jobState.parse(await res.json());
};

const filesOf = (name: RecipeName, input: RecipeFields) => {
  const files: { field: string; key?: string; url: string }[] = [];

  for (const field of fileFields(name)) {
    const value = input[field];

    const entries = z
      .union([z.string(), z.array(z.string()), z.record(z.string(), z.string())])
      .optional()
      .parse(value);

    if (entries === undefined) {
      continue;
    }

    if (Array.isArray(entries)) {
      files.push(...entries.map((url) => ({ field, url })));
    } else if (z.string().safeParse(entries).success) {
      files.push({ field, url: String(entries) });
    } else {
      files.push(...Object.entries(entries).map(([key, url]) => ({ field, key, url })));
    }
  }

  for (const file of files) {
    if (!isMediaUrl(file.url)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${file.field}: only a URL generate or an asset step returned can be read; put a local file through generate upload first.`,
      });
    }
  }

  return files;
};

const paramsOf = (name: RecipeName, input: RecipeFields) => {
  const skip = new Set([...fileFields(name), "wait_seconds"]);

  return z
    .record(z.string(), z.json())
    .parse(Object.fromEntries(Object.entries(input).filter(([key]) => !skip.has(key))));
};

const fileNameOf = (name: string) => name.replaceAll("/", "__").replaceAll(/[^\w.-]/gu, "_");

const finalize = async (context: ORPCContext, jobId: string, state: JobState) => {
  if (state.final || !isRecipeName(state.recipe)) {
    return state;
  }

  const jobs = jobsOf(context, state.recipe);

  if (state.status === "failed") {
    await releaseRecipe(context.db, jobId);
    const final = { cost_usd: 0, outputs: [] };
    await call(jobs, jobId, "/final", { body: JSON.stringify(final), method: "POST" });

    return { ...state, final };
  }

  const outputs: z.infer<typeof finalOutput>[] = [];

  for (const output of state.outputs) {
    if (output.bytes > MAX_RECIPE_OUTPUT_BYTES) {
      throw new ORPCError("PAYLOAD_TOO_LARGE", {
        message: `${output.name} is ${output.bytes} bytes, over the ${MAX_RECIPE_OUTPUT_BYTES} a recipe returns; ask for less (a lower crf, size or frame count).`,
      });
    }

    const res = await call(jobs, jobId, `/out/${encodeURIComponent(output.name)}`);
    const bytes = await readBytesBounded(res, MAX_RECIPE_OUTPUT_BYTES, output.name);

    const url = await storeFile(context, {
      bytes,
      contentType: output.contentType,
      fileName: fileNameOf(output.name),
    });

    outputs.push({ bytes: output.bytes, content_type: output.contentType, name: output.name, url });
  }

  const final = {
    cost_usd: await settleRecipe(context.db, jobId, state.recipe, state.seconds ?? 0),
    outputs,
  };

  await call(jobs, jobId, "/final", { body: JSON.stringify(final), method: "POST" });

  return { ...state, final };
};

const report = (jobId: string, state: JobState) => ({
  cost_usd: state.final?.cost_usd ?? null,
  error: state.error,
  job_id: jobId,
  outputs: state.final?.outputs ?? [],
  recipe: state.recipe,
  result: (state.result ?? null) as JsonValue,
  seconds: state.seconds,
  status: state.status,
});

const follow = async (context: ORPCContext, jobId: string, waitSeconds: number) => {
  const jobs = context.mediaJobs;
  const user = userOf(context);

  if (!jobs || !JOB_ID.test(jobId)) {
    throw new ORPCError("NOT_FOUND", { message: `No recipe job ${jobId}.` });
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let state = await readState(jobs, jobId);

  if (state.userId !== user.id) {
    throw new ORPCError("NOT_FOUND", { message: `No recipe job ${jobId}.` });
  }

  while (
    (state.status === "queued" || state.status === "running") &&
    Date.now() + POLL_MS <= deadline
  ) {
    await sleep(POLL_MS);
    state = await readState(jobs, jobId);
  }

  if (state.status === "done" || state.status === "failed") {
    state = await finalize(context, jobId, state);
  }

  return report(jobId, state);
};

/** Holds credit for a hosted recipe job, starts it in its container, and waits up to wait_seconds. */
export const submitRecipe = async (
  context: ORPCContext,
  name: RecipeName,
  input: RecipeFields & { wait_seconds: number },
) => {
  const jobs = jobsOf(context, name);
  const user = userOf(context);
  const files = filesOf(name, input);
  const params = paramsOf(name, input);

  if (user.role !== "admin") {
    await requirePositiveBalance(context.db, user.id, purchasesEnabled(context.billing));
  }

  if ((await runningRecipeJobs(context.db, user.id)) >= MAX_RUNNING) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `${MAX_RUNNING} recipe jobs are already running on this account; follow them with asset status first.`,
    });
  }

  const jobId = `rcp_${RECIPES[name].image}_${crypto.randomUUID()}`;
  await holdRecipe(context.db, { jobId, recipe: name, userId: user.id });

  try {
    await call(jobs, jobId, "/start", {
      body: JSON.stringify({ files, params, recipe: name, userId: user.id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    await releaseRecipe(context.db, jobId);
    throw error;
  }

  return follow(context, jobId, input.wait_seconds);
};

export const recipeStatus = (
  context: ORPCContext,
  input: { job_id: string; wait_seconds: number },
) => follow(context, input.job_id, input.wait_seconds);
