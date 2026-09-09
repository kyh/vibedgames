import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
    hmr: false,
  },
});
