import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5193 },
  plugins: [
    {
      // Sim-critical modules must never hot-update: HMR re-instantiates a
      // second GameScene whose Rapier world is never stepped, and every
      // debug hook then points at a ghost (car "stuck at 0", hours lost —
      // three separate incidents). A hard reload costs seconds and is true.
      name: "full-reload-sim",
      handleHotUpdate({ file, server }) {
        if (/\/src\/(world|vehicle|physics|scenes|game|fx|render|net)\//.test(file)) {
          server.ws.send({ type: "full-reload" });
          return [];
        }
      },
    },
  ],
  define: {
    // Cache key for the IndexedDB world cache — every build invalidates it.
    __WORLD_BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
});
