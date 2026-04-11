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
  plugins: [
    // Nitro preset targets a single Cloudflare Workers module build.
    // Bindings (D1, assets, secrets) are declared in wrangler.jsonc.
    nitro({
      preset: "cloudflare_module",
      cloudflare: {
        deployConfig: true,
      },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
