import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  base: "./",
  // Rapier's wasm arrives as a real .wasm asset (src/physics/rapier-browser.ts);
  // the import is top-level-await, which every browser that runs this game
  // already supports, so the build targets esnext rather than pulling in a
  // TLA transform.
  build: { target: "esnext" },
  define: {
    // Cache key for the IndexedDB world cache — every build invalidates it.
    __WORLD_BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  optimizeDeps: { exclude: ["@dimforge/rapier3d"] },
  plugins: [
    wasm(),
    {
      // Sim-critical modules must never hot-update: HMR re-instantiates a
      // second GameScene whose Rapier world is never stepped, and every
      // debug hook then points at a ghost (car "stuck at 0", hours lost —
      // three separate incidents). A hard reload costs seconds and is true.
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
