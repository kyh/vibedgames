import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  optimizeDeps: {
    exclude: ["bash-tool", "just-bash"],
  },
  plugins: [
    // Nitro preset targets a single Cloudflare Workers module build.
    // Bindings (D1, assets, secrets) are declared in wrangler.jsonc.
    nitro({
      config: {
        preset: "cloudflare_module",
        cloudflare: {
          deployConfig: true,
          nodeCompat: true,
        },
      },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
