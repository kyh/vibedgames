import { statSync } from "node:fs";
import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext } from "../recipe";
import { need, one } from "../recipe";

const ETC1S_QUALITY = (quality: number) => String(Math.max(1, Math.round((quality / 100) * 255)));

export const textureCompress = async (ctx: RecipeContext<RecipeInput<"texture-compress">>) => {
  const cli = need(ctx.tools.gltfTransform, "gltf-transform");
  const model = one(ctx.files, "model_url");
  const p = ctx.params;
  const resized = path.join(ctx.work, "resized.glb");
  const output = path.join(ctx.out, "model.glb");
  const size = String(p.max_size);

  await ctx.run(cli, ["resize", model, resized, "--width", size, "--height", size]);

  const encode: Record<typeof p.format, string[]> = {
    jpeg: ["jpeg", resized, output, "--quality", String(p.quality)],
    ktx2: ["etc1s", resized, output, "--quality", ETC1S_QUALITY(p.quality)],
    png: ["png", resized, output],
    webp: ["webp", resized, output, "--quality", String(p.quality)],
  };

  await ctx.run(cli, encode[p.format]);

  return {
    outputs: [],
    result: {
      bytes_in: statSync(model).size,
      bytes_out: statSync(output).size,
      format: p.format,
      max_size: p.max_size,
    },
  };
};
