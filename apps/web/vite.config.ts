import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { mcpApps } from "./mcp-apps/vite-plugin";

export default defineConfig({
  plugins: [
    cloudflare({
      experimental: { newConfig: { cfBuildOutput: true, types: { includeRuntime: false } } },
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    mcpApps(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
