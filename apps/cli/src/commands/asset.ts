import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import type { z } from "zod";
import { consola } from "consola";

import type { RouterOutputs } from "@repo/contract";
import { inspectInput, optimizeInput } from "@repo/contract/asset/asset-schema";

import { createClient } from "../lib/api.js";
import { mediaFlagArgs, readMediaInput } from "../lib/media-flags.js";
import { uploadFile } from "../lib/media-upload.js";
import { outputArgs, writeStructured } from "../lib/output.js";
import { recipeCommands } from "./asset-recipes.js";

type Client = ReturnType<typeof createClient>;

type Stats = RouterOutputs["asset"]["inspect"];

const parseInput = async <S extends z.ZodObject>(client: Client, schema: S, argv: string[]) => {
  const input = await readMediaInput(
    schema.shape,
    argv,
    async (file) => await uploadFile(client, file),
  );

  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      consola.error(`--${issue.path.join(".") || "input"}: ${issue.message}`);
    }

    process.exit(1);
  }

  return parsed.data;
};

const saveTo = async (url: string, out: string) => {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Downloading ${url} failed: ${res.status} ${res.statusText}`);
  }

  const target = path.resolve(out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, new Uint8Array(await res.arrayBuffer()));

  return target;
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

const printStats = (stats: Stats) => {
  const [x, y, z] = stats.bounds.size;
  consola.log(`  ${stats.triangles} triangles, ${stats.vertices} vertices, ${kb(stats.bytes)}`);
  consola.log(`  size ${x} × ${y} × ${z} m (min y ${stats.bounds.min[1]})`);
  consola.log(
    `  ${stats.meshes} meshes, ${stats.materials} materials, ${stats.textures.length} textures`,
  );

  for (const texture of stats.textures) {
    consola.log(
      `    ${texture.name || "texture"} ${texture.width}×${texture.height} ${texture.mime} ${kb(texture.bytes)}`,
    );
  }

  for (const skin of stats.skins) {
    consola.log(`  skin ${skin.name || "(unnamed)"}: ${skin.joints} joints`);
  }

  for (const clip of stats.animations) {
    consola.log(
      `  clip ${clip.name || "(unnamed)"}: ${clip.duration_seconds}s, ${clip.channels} channels`,
    );
  }

  if (stats.extensions.length > 0) {
    consola.log(`  extensions: ${stats.extensions.join(", ")}`);
  }
};

const outArg = {
  out: {
    description: "Also download the processed GLB to this path, e.g. public/models/hero.glb.",
    type: "string",
  },
} as const;

const inspectCommand = defineCommand({
  args: { ...mediaFlagArgs(inspectInput.shape), ...outputArgs },
  meta: {
    description:
      "Report a GLB's triangles, size in metres, textures, skeleton and animation clips.",
    name: "inspect",
  },
  run: async ({ args, rawArgs }) => {
    const client = createClient();
    const stats = await client.asset.inspect(await parseInput(client, inspectInput, rawArgs));

    if (!writeStructured(stats, args)) {
      consola.success("Inspected");
      printStats(stats);
    }
  },
});

const processed = async (
  args: { out?: string; json?: boolean; field?: string },
  result: { model_url: string; stats: Stats; skipped_channels?: number },
) => {
  const saved =
    args.out === undefined || args.out === ""
      ? undefined
      : await saveTo(result.model_url, args.out);

  const payload = { ...result, path: saved };

  if (!writeStructured(payload, args)) {
    consola.success(saved === undefined ? result.model_url : `Saved ${saved}`);
    printStats(result.stats);

    if (result.skipped_channels !== undefined && result.skipped_channels > 0) {
      consola.warn(
        `  ${result.skipped_channels} channels named joints the model lacks and were dropped`,
      );
    }
  }
};

const optimizeCommand = defineCommand({
  args: { ...mediaFlagArgs(optimizeInput.shape), ...outArg, ...outputArgs },
  meta: {
    description:
      "Make a GLB game-ready: y-up, facing, scale in metres, pivot, triangle budget, meshopt compression.",
    name: "optimize",
  },
  run: async ({ args, rawArgs }) => {
    const client = createClient();
    const input = await parseInput(client, optimizeInput, rawArgs);
    await processed(args, await client.asset.optimize(input));
  },
});

export const assetCommand = defineCommand({
  meta: {
    description:
      "Process 3D models, audio and video: inspect, optimize, add animations, convert, bake, render, master, cut, probe. Runs locally when the tool is installed, else on vibedgames' servers.",
    name: "asset",
  },
  subCommands: {
    inspect: inspectCommand,
    optimize: optimizeCommand,
    ...recipeCommands,
  },
});
