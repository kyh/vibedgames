import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonValue, RecipeContext } from "../recipe";
import { need, RecipeError } from "../recipe";
import type { BlenderRecipe } from "./scripts";
import { BLENDER_SCRIPTS } from "./scripts";

const RECIPE_ERROR = /recipe error: (?<message>.+)/u;

/** Runs a fixed Blender script headless, without user settings or a .blend's own scripts. */
export const runBlender = async (ctx: RecipeContext<unknown>, recipe: BlenderRecipe) => {
  const blender = need(ctx.tools.blender, "Blender");
  const script = path.join(ctx.work, `${recipe}.py`);
  const args = path.join(ctx.work, "args.json");
  const result = path.join(ctx.work, "result.json");

  writeFileSync(script, BLENDER_SCRIPTS[recipe]);
  writeFileSync(
    args,
    JSON.stringify({ files: ctx.files, out: ctx.out, params: ctx.params, result, work: ctx.work }),
  );

  const run = await ctx.run(
    blender,
    [
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      "--python-exit-code",
      "1",
      "--python",
      script,
      "--",
      args,
    ],
    { allowFailure: true, cwd: ctx.work },
  );

  if (run.code !== 0) {
    const message = RECIPE_ERROR.exec(`${run.stderr}\n${run.stdout}`)?.groups?.message;
    const tail = `${run.stderr}\n${run.stdout}`.trim().split("\n").slice(-10).join("\n");

    throw new RecipeError(message ?? `Blender failed:\n${tail}`);
  }

  return { outputs: [], result: JSON.parse(readFileSync(result, "utf-8")) as JsonValue };
};
