import { Container } from "@cloudflare/containers";
import type { RecipeName } from "@repo/contract/asset/recipe-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { isRecipeName, MAX_RECIPE_OUTPUT_BYTES, RECIPES } from "@repo/contract/asset/recipe-schema";
import { z } from "zod";

import { JobFailureError } from "./job-failure";

const output = z.object({ bytes: z.number(), contentType: z.string(), name: z.string() });

export const jobState = z.object({
  capSeconds: z.number(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  final: z.json().nullable(),
  outputs: z.array(output),
  recipe: z.string(),
  result: z.json().nullable(),
  seconds: z.number().nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  userId: z.string(),
});

export type JobState = z.infer<typeof jobState>;

const input = z.object({
  field: z.string(),
  key: z.string().optional(),
  url: z.string(),
});

export const startBody = z.object({
  files: z.array(input).max(64),
  params: z.record(z.string(), z.json()),
  recipe: z.string(),
  userId: z.string().min(1),
});

const runAnswer = z.object({
  outputs: z.array(output),
  result: z.json(),
  seconds: z.number(),
});

const CHUNK_BYTES = 1024 * 1024;
const KEEP_OUTPUTS_MS = 7 * 24 * 60 * 60 * 1000;
const chunkKey = (name: string, index: number) => `out:${name}:${index}`;

const EXT = /\.(?<ext>[a-z0-9]{1,8})$/iu;

const TYPE_EXT = {
  "application/x-tar": "tar",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "model/gltf-binary": "glb",
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const satisfies Record<string, string>;

const extensionOf = (url: string, contentType: string | null) => {
  const fromPath = EXT.exec(new URL(url).pathname)?.groups?.ext?.toLowerCase();
  const type = (contentType ?? "").split(";")[0]?.trim() ?? "";
  const fromType = Object.hasOwn(TYPE_EXT, type) ? TYPE_EXT[type as keyof typeof TYPE_EXT] : null;

  return fromPath ?? fromType ?? "bin";
};

const json = (body: JobState | { error: string }, status = 200) => Response.json(body, { status });

const errorText = async (res: Response) => {
  try {
    const body = z.object({ error: z.string() }).safeParse(await res.json());

    return body.data?.error ?? `${res.status}`;
  } catch {
    return `${res.status}`;
  }
};

/** One recipe job: its state, and the container it runs in, alive only for this job. */
export class RecipeJob extends Container {
  override defaultPort = 8080;
  override enableInternet = false;
  override sleepAfter = "15m";

  private async load() {
    const raw = await this.ctx.storage.get("job");

    return raw === undefined ? null : jobState.parse(raw);
  }

  private async save(state: JobState) {
    await this.ctx.storage.put("job", state);
  }

  private async update(patch: Partial<JobState>) {
    const state = await this.load();

    if (state) {
      await this.save({ ...state, ...patch });
    }
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const out = /^\/jobs\/[^/]+\/out\/(?<name>.+)$/u.exec(url.pathname)?.groups?.name;

    if (request.method === "POST" && url.pathname.endsWith("/start")) {
      return this.begin(startBody.parse(await request.json()));
    }

    if (request.method === "POST" && url.pathname.endsWith("/final")) {
      await this.update({ final: z.json().parse(await request.json()) });
      await this.dropOutputs();
      const state = await this.load();

      return state ? json(state) : json({ error: "No such job." }, 404);
    }

    if (request.method === "GET" && out) {
      return this.readOutput(decodeURIComponent(out));
    }

    if (request.method === "GET") {
      const state = await this.load();

      return state ? json(state) : json({ error: "no such job" }, 404);
    }

    return json({ error: "not found" }, 404);
  }

  private async begin(body: z.infer<typeof startBody>) {
    const existing = await this.load();

    if (existing) {
      return json(existing);
    }

    if (!isRecipeName(body.recipe)) {
      return json({ error: `${body.recipe} is not a recipe` }, 400);
    }

    const state: JobState = {
      capSeconds: RECIPES[body.recipe].capSeconds,
      createdAt: Date.now(),
      endedAt: null,
      error: null,
      final: null,
      outputs: [],
      recipe: body.recipe,
      result: null,
      seconds: null,
      status: "queued",
      userId: body.userId,
    };

    await this.save(state);
    this.ctx.waitUntil(this.runJob(body.recipe, body));

    return json(state);
  }

  private async runJob(recipe: RecipeName, body: z.infer<typeof startBody>) {
    const cap = RECIPES[recipe].capSeconds;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // oxlint-disable-next-line promise/avoid-new -- the cap is a timer, which has no promise form here
    const overrun = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new JobFailureError(`The job passed its ${cap} s cap and was stopped.`));
      }, cap * 1000);
    });

    try {
      await Promise.race([this.execute(recipe, body), overrun]);
    } catch (error) {
      await this.update({
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
      await this.destroy();
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(recipe: RecipeName, body: z.infer<typeof startBody>) {
    await this.startAndWaitForPorts();
    await this.update({ status: "running" });
    const singles: Record<string, string> = {};
    const lists: Record<string, string[]> = {};
    const maps: Record<string, Record<string, string>> = {};

    for (const [index, file] of body.files.entries()) {
      const name = await this.stage(file, index);

      if (file.key !== undefined) {
        maps[file.field] = { ...maps[file.field], [file.key]: name };
      } else if (file.field.endsWith("_urls")) {
        lists[file.field] = [...(lists[file.field] ?? []), name];
      } else {
        singles[file.field] = name;
      }
    }

    const files = { ...singles, ...lists, ...maps };

    const res = await this.containerFetch("http://container/run", {
      body: JSON.stringify({ files, params: body.params, recipe }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!res.ok) {
      throw new JobFailureError(await errorText(res));
    }

    const answer = runAnswer.parse(await res.json());

    for (const file of answer.outputs) {
      await this.keepOutput(file);
    }

    await this.update({
      endedAt: Date.now(),
      outputs: answer.outputs,
      result: answer.result,
      seconds: answer.seconds,
      status: "done",
    });
    await this.destroy();
    await this.schedule(new Date(Date.now() + KEEP_OUTPUTS_MS), "dropOutputs");
  }

  private async stage(file: z.infer<typeof input>, index: number) {
    if (!isMediaUrl(file.url)) {
      throw new JobFailureError(`${file.field}: only media-host URLs can be read.`);
    }

    const res = await fetch(file.url);

    if (!isMediaUrl(res.url || file.url)) {
      throw new JobFailureError(`${file.field}: ${file.url} redirected off the media hosts.`);
    }

    if (!res.ok || !res.body) {
      throw new JobFailureError(`${file.field}: fetching ${file.url} failed (${res.status}).`);
    }

    const name =
      file.key === undefined
        ? `${file.field}-${index}.${extensionOf(res.url || file.url, res.headers.get("content-type"))}`
        : `${file.field}/${file.key}`;

    const put = await this.containerFetch(`http://container/in/${encodeURIComponent(name)}`, {
      body: res.body,
      method: "PUT",
    });

    if (!put.ok) {
      throw new JobFailureError(`${file.field}: ${await errorText(put)}`);
    }

    return name;
  }

  private async keepOutput(file: z.infer<typeof output>) {
    if (file.bytes > MAX_RECIPE_OUTPUT_BYTES) {
      throw new JobFailureError(
        `${file.name} is ${file.bytes} bytes, over the ${MAX_RECIPE_OUTPUT_BYTES} a recipe returns; ask for less (a lower crf, size or frame count).`,
      );
    }

    const res = await this.containerFetch(`http://container/out/${encodeURIComponent(file.name)}`);

    if (!res.ok) {
      throw new JobFailureError(`${file.name}: ${await errorText(res)}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());

    for (let index = 0; index * CHUNK_BYTES < bytes.byteLength; index += 1) {
      await this.ctx.storage.put(
        chunkKey(file.name, index),
        bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
      );
    }
  }

  private async readOutput(name: string) {
    const state = await this.load();
    const file = state?.outputs.find((o) => o.name === name);
    const count = file ? Math.ceil(file.bytes / CHUNK_BYTES) : 0;
    const first = file ? await this.ctx.storage.get(chunkKey(name, 0)) : undefined;

    if (!file || (count > 0 && first === undefined)) {
      return json({ error: `${name} is no longer kept` }, 404);
    }

    const { storage } = this.ctx;
    let next = 0;

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (next >= count) {
          controller.close();

          return;
        }

        const chunk = await storage.get(chunkKey(name, next));
        next += 1;

        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else {
          controller.error(new Error(`${name} lost a chunk`));
        }
      },
    });

    return new Response(body, {
      headers: { "content-length": String(file.bytes), "content-type": file.contentType },
    });
  }

  async dropOutputs() {
    const kept = await this.ctx.storage.list({ prefix: "out:" });
    const keys = [...kept.keys()];

    for (let start = 0; start < keys.length; start += 128) {
      await this.ctx.storage.delete(keys.slice(start, start + 128));
    }
  }

  override async onStop() {
    const state = await this.load();

    if (state && (state.status === "queued" || state.status === "running")) {
      await this.update({
        endedAt: Date.now(),
        error: "The container stopped before the job finished.",
        status: "failed",
      });
    }
  }
}
