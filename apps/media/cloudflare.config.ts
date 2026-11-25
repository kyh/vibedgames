import { bindings, defineConfig, defineContainer, defineWorker, exports } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const tools = defineContainer({
  image: { dockerfile: "./container/tools.Dockerfile", buildContext: "./container" },
  instanceType: "standard-2",
  maxInstances: 20,
  name: "vibedgames-media-tools",
});

const blender = defineContainer({
  image: { dockerfile: "./container/blender.Dockerfile", buildContext: "./container" },
  instanceType: "standard-3",
  maxInstances: 10,
  name: "vibedgames-media-blender",
});

const worker = defineWorker({
  compatibilityDate: "2026-04-12",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint,
  exports: {
    BlenderJob: exports.durableObject({ container: blender, storage: "sqlite" }),
    RecipeJob: exports.durableObject({ container: tools, storage: "sqlite" }),
  },
  name: "vibedgames-media",
  observability: { enabled: true },
  workersDev: false,
});

export default defineConfig({
  containers: [tools, blender],
  worker: {
    ...worker,
    env: {
      BLENDER: bindings.durableObject({ exportName: "BlenderJob" as const, worker }),
      TOOLS: bindings.durableObject({ exportName: "RecipeJob" as const, worker }),
    },
  },
});
