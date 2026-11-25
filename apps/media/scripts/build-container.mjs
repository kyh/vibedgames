import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["container/server.ts"],
  format: "esm",
  outfile: "container/dist/server.mjs",
  platform: "node",
  target: "node22",
});
