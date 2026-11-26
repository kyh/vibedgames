import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { defineCommand } from "citty";
import { consola } from "consola";
import { z } from "zod";

import type { RouterOutputs } from "@repo/contract";
import type { RecipeName, RecipeTool } from "@repo/contract/asset/recipe-schema";
import type { RecipeFiles, Tools } from "@repo/recipes";
import { fileFields, RECIPE_NAMES, RECIPES } from "@repo/contract/asset/recipe-schema";
import { repeatWhile, runInOrder } from "@repo/contract/run-in-order";
import { exec, findTools, hasTools, runRecipe } from "@repo/recipes";

import type { JsonObject, JsonValue } from "../lib/types.js";
import { createClient } from "../lib/api.js";
import { mediaFlagArgs, readMediaInput } from "../lib/media-flags.js";
import { uploadFile } from "../lib/media-upload.js";
import { outputArgs, writeStructured } from "../lib/output.js";

type Job = RouterOutputs["asset"]["status"];

const WHERE = ["auto", "local", "cloud"] as const;

type Where = (typeof WHERE)[number];

const INSTALL = {
  blender: "Blender (blender.org, or set BLENDER_PATH)",
  ffmpeg: "ffmpeg and ffprobe on PATH",
  "gltf-transform": "gltf-transform on PATH (npm i -g @gltf-transform/cli)",
  img2threejs: "the image-to-threejs checkout (see the image-to-threejs skill) and Python 3.10+",
} as const satisfies Record<RecipeTool, string>;

const REMOTE = /^https?:\/\//iu;

const flagOf = (argv: string[], key: string) => {
  for (const [i, arg] of argv.entries()) {
    if (arg === `--${key}`) {
      return { index: i + 1, value: argv[i + 1] };
    }

    if (arg.startsWith(`--${key}=`)) {
      return { index: i, inline: true, value: arg.slice(key.length + 3) };
    }
  }

  return null;
};

const isDir = (value: string) => {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
};

const packFolders = async (name: RecipeName, argv: string[], tools: Tools) => {
  const next = [...argv];

  await runInOrder(fileFields(name), async (key) => {
    const flag = flagOf(next, key);
    const folder = flag?.value;

    if (flag === null || folder === undefined || !isDir(folder)) {
      return;
    }

    if (tools.tar === undefined) {
      throw new Error(`--${key} is a folder; packing it needs tar on PATH.`);
    }

    const tarball = path.join(mkdtempSync(path.join(tmpdir(), "vg-pack-")), `${key}.tar`);
    await exec(tools.tar, ["-cf", tarball, "-C", path.resolve(folder), "."]);
    next[flag.index] = flag.inline === true ? `--${key}=${tarball}` : tarball;
  });

  return next;
};

const download = async (url: string, target: string) => {
  const res = await fetch(url);

  if (!res.ok || !res.body) {
    throw new Error(`Downloading ${url} failed: ${res.status} ${res.statusText}`);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));

  return target;
};

const localValue = async (value: string, dir: string, key: string, index: number) => {
  if (!REMOTE.test(value)) {
    return path.resolve(value);
  }

  const ext = path.extname(new URL(value).pathname) || ".bin";

  return await download(value, path.join(dir, `${key}-${index}${ext}`));
};

const splitInput = async (name: RecipeName, input: JsonObject) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vg-in-"));
  const files: RecipeFiles = {};
  const params: Record<string, JsonValue> = {};
  const fields = new Set(fileFields(name));
  let index = 0;

  const fetchOne = async (key: string, value: string) => {
    index += 1;

    return await localValue(value, dir, key, index);
  };

  await runInOrder(Object.entries(input), async ([key, value]) => {
    const single = z.string().safeParse(value);
    const list = z.array(z.string()).safeParse(value);
    const map = z.record(z.string(), z.string()).safeParse(value);

    if (!fields.has(key)) {
      params[key] = value;
    } else if (single.success) {
      files[key] = await fetchOne(key, single.data);
    } else if (list.success) {
      files[key] = await runInOrder(list.data, async (item) => await fetchOne(key, item));
    } else if (map.success) {
      const entries = await runInOrder(
        Object.entries(map.data),
        async ([rel, item]) => [rel, await fetchOne(key, item)] as const,
      );

      files[key] = Object.fromEntries(entries);
    } else {
      throw new Error(`--${key} takes a path or URL.`);
    }
  });

  return { files, params };
};

const fail = (message: string) => {
  consola.error(message);
  process.exit(1);
};

const pickWhere = (name: RecipeName, where: Where, tools: Tools) => {
  const needs = RECIPES[name].tools;
  const installed = hasTools(tools, needs);

  if (where === "local" && !installed) {
    fail(
      `--where local needs ${needs.map((tool) => INSTALL[tool]).join(", ")}; run without it to use vibedgames' servers.`,
    );
  }

  return where === "cloud" || (where === "auto" && !installed) ? "cloud" : "local";
};

const runLocally = async (name: RecipeName, argv: string[], out: string, tools: Tools) => {
  const input = await readMediaInput(RECIPES[name].input.shape, argv, (file) => file.path);

  const { files, params } = await splitInput(name, input);
  const started = performance.now();
  const outcome = await runRecipe(name, { files, out, params, tools });

  return {
    cost_usd: 0,
    job_id: null,
    outputs: outcome.outputs.map((o) => ({ bytes: o.bytes, name: o.name, path: o.path })),
    result: outcome.result,
    seconds: (performance.now() - started) / 1000,
    status: "done",
    where: "local",
  };
};

const finish = async (job: Job, out: string) => {
  const outputs = await runInOrder(job.outputs, async (output) => ({
    bytes: output.bytes,
    name: output.name,
    path: await download(output.url, path.join(out, output.name)),
    url: output.url,
  }));

  return { ...job, outputs, where: "cloud" };
};

type Client = ReturnType<typeof createClient>;

const SUBMIT: Record<RecipeName, (client: Client, input: JsonObject) => Promise<Job>> = {
  "add-animations": async (client, input) =>
    await client.asset.addAnimations(RECIPES["add-animations"].input.parse(input)),
  "audio-master": async (client, input) =>
    await client.asset.audioMaster(RECIPES["audio-master"].input.parse(input)),
  bake: async (client, input) => await client.asset.bake(RECIPES.bake.input.parse(input)),
  "fbx-to-glb": async (client, input) =>
    await client.asset.fbxToGlb(RECIPES["fbx-to-glb"].input.parse(input)),
  "frames-to-video": async (client, input) =>
    await client.asset.framesToVideo(RECIPES["frames-to-video"].input.parse(input)),
  "image-to-threejs": async (client, input) =>
    await client.asset.imageToThreejs(RECIPES["image-to-threejs"].input.parse(input)),
  render: async (client, input) => await client.asset.render(RECIPES.render.input.parse(input)),
  "texture-compress": async (client, input) =>
    await client.asset.textureCompress(RECIPES["texture-compress"].input.parse(input)),
  "trailer-render": async (client, input) =>
    await client.asset.trailerRender(RECIPES["trailer-render"].input.parse(input)),
  "video-probe": async (client, input) =>
    await client.asset.videoProbe(RECIPES["video-probe"].input.parse(input)),
  "video-to-sheet": async (client, input) =>
    await client.asset.videoToSheet(RECIPES["video-to-sheet"].input.parse(input)),
};

const runInCloud = async (name: RecipeName, argv: string[], out: string) => {
  const client = createClient();
  const schema = RECIPES[name].input;

  const raw = await readMediaInput(
    schema.shape,
    argv,
    async (file) => await uploadFile(client, file),
  );

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    fail(parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("\n"));
  }

  let job = await SUBMIT[name](client, raw);

  await repeatWhile(async () => {
    if ((job.status !== "queued" && job.status !== "running") || job.job_id === null) {
      return false;
    }

    job = await client.asset.status({ job_id: job.job_id, wait_seconds: 20 });

    return true;
  });

  if (job.status === "failed") {
    fail(`${name} failed: ${job.error ?? "no reason given"}`);
  }

  return await finish(job, out);
};

const placeOutputs = (outputs: { name: string; path: string }[], target: string) => {
  mkdirSync(path.dirname(target), { recursive: true });

  for (const output of outputs) {
    const placed = outputs.length === 1 ? target : path.join(path.dirname(target), output.name);
    mkdirSync(path.dirname(placed), { recursive: true });
    copyFileSync(output.path, placed);
    output.path = placed;
  }
};

const recipeCommand = (name: RecipeName) => {
  const fields = RECIPES[name].input.shape;

  return defineCommand({
    args: {
      ...mediaFlagArgs(fields),
      out: {
        description: `Folder the output files go in (./${name} by default), or a file path when the recipe writes one file.`,
        type: "string",
      },
      where: {
        default: "auto",
        description:
          "`auto` (the default) runs on this machine when the tool is installed, else on vibedgames' servers; `local` or `cloud` forces one.",
        type: "string",
      },
      ...outputArgs,
    },
    meta: {
      description: `${RECIPES[name].title}. Runs locally when ${RECIPES[name].tools.join(" and ")} is installed, else on vibedgames' servers (billed from $0.01).`,
      name,
    },
    run: async ({ args, rawArgs }) => {
      const where = WHERE.find((option) => option === args.where);

      if (!where) {
        fail("--where is auto, local or cloud.");

        return;
      }

      const tools = findTools();
      const target = path.resolve(args.out ?? name);
      const toFile = path.extname(target) !== "";
      const out = toFile ? mkdtempSync(path.join(tmpdir(), `vg-${name}-`)) : target;
      const argv = await packFolders(name, rawArgs, tools);
      const chosen = pickWhere(name, where, tools);

      const report =
        chosen === "local"
          ? await runLocally(name, argv, out, tools)
          : await runInCloud(name, argv, out);

      if (toFile) {
        placeOutputs(report.outputs, target);
        rmSync(out, { force: true, recursive: true });
      }

      if (!writeStructured(report, args)) {
        consola.success(`${name} done ${chosen === "local" ? "on this machine" : "on vibedgames"}`);

        for (const output of report.outputs) {
          consola.log(`  ${output.path}`);
        }

        consola.log(JSON.stringify(report.result, null, 2));
      }
    },
  });
};

const statusCommand = defineCommand({
  args: {
    job_id: { description: "The job id a recipe returned.", required: true, type: "positional" },
    out: { description: "Folder to download the outputs to, once done.", type: "string" },
    ...outputArgs,
  },
  meta: { description: "Follow a hosted recipe job and download its outputs.", name: "status" },
  run: async ({ args }) => {
    const client = createClient();
    let job = await client.asset.status({ job_id: args.job_id, wait_seconds: 20 });

    await repeatWhile(async () => {
      if (job.status !== "queued" && job.status !== "running") {
        return false;
      }

      job = await client.asset.status({ job_id: args.job_id, wait_seconds: 20 });

      return true;
    });

    const report =
      args.out === undefined || args.out === "" ? job : await finish(job, path.resolve(args.out));

    if (!writeStructured(report, args)) {
      consola.log(JSON.stringify(report, null, 2));
    }
  },
});

/** One `vg asset <recipe>` per hosted recipe, plus `vg asset status`. */
export const recipeCommands = {
  ...Object.fromEntries(RECIPE_NAMES.map((name) => [name, recipeCommand(name)])),
  status: statusCommand,
};
