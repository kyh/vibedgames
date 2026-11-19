import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  base: "./",
  build: { target: "esnext" },
  define: {
    __WORLD_BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  optimizeDeps: { exclude: ["@dimforge/rapier3d"] },
  plugins: [
    wasm(),
    {
      handleHotUpdate({ file, server }) {
        if (/\/src\/(?:world|vehicle|physics|scenes|game|fx|render|net)\//u.test(file)) {
          server.ws.send({ type: "full-reload" });

          return [];
        }
      },
      name: "full-reload-sim",
    },
  ],
  server: { port: 5193 },
});
