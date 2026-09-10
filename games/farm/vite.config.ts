import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 2000, target: "es2022" },
  server: { port: 5191 },
});
