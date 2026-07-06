import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5193 },
  define: {
    // Cache key for the IndexedDB world cache — every build invalidates it.
    __WORLD_BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
});
