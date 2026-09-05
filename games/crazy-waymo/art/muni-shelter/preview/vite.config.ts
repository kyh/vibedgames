import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
  },
});
