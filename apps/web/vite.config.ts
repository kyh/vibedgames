import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { meshoptWasm } from "./vite/meshopt-wasm";

export default defineConfig({
  plugins: [
    meshoptWasm(),
    cloudflare({
      experimental: { newConfig: { cfBuildOutput: true } },
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
