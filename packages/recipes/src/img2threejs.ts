import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext } from "./recipe";
import { ensureDir, named, need, RecipeError, snapshotFiles } from "./recipe";

const TAIL = 32 * 1024;

const findScript = (root: string, name: string) => {
  const queue = [path.join(root, "forge")];

  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === name) {
        return full;
      }

      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        queue.push(full);
      }
    }
  }

  return null;
};

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text);

/** Runs one script of the pinned image-to-threejs checkout in a run folder holding the given files. */
export const imageToThreejs = async (ctx: RecipeContext<RecipeInput<"image-to-threejs">>) => {
  const root = need(ctx.tools.img2threejs, "image-to-threejs");
  const script = findScript(root, ctx.params.script);

  if (!script) {
    throw new RecipeError(`${ctx.params.script} is not in this image-to-threejs checkout.`);
  }

  const run = ensureDir(path.join(ctx.work, "run"));

  for (const [rel, local] of Object.entries(named(ctx.files, "file_urls"))) {
    const target = path.join(run, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(local, target);
  }

  const before = snapshotFiles(run);

  const [program, prefix] = ctx.tools.uv
    ? [ctx.tools.uv, ["run", "--python", "3.12", "--no-project", "python"]]
    : [need(ctx.tools.python, "Python 3"), []];

  const result = await ctx.run(program, [...prefix, script, ...ctx.params.args], {
    allowFailure: true,
    cwd: run,
  });

  for (const [rel, stamp] of snapshotFiles(run)) {
    if (before.get(rel) !== stamp) {
      const target = path.join(ctx.out, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(run, rel), target);
    }
  }

  return {
    outputs: [],
    result: {
      exit_code: result.code,
      script: ctx.params.script,
      stderr: tail(result.stderr),
      stdout: tail(result.stdout),
    },
  };
};
