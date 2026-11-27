import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { meshoptWasm } from "./vite/meshopt-wasm";

export default defineConfig({
  plugins: [
    meshoptWasm(),
    cloudflare({
      experimental: { newConfig: { cfBuildOutput: true, types: { includeRuntime: false } } },
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      {
        find: /^ndarray-pixels$/u,
        replacement: fileURLToPath(new URL("vite/ndarray-pixels.ts", import.meta.url)),
      },
    ],
    tsconfigPaths: true,
  },
});
