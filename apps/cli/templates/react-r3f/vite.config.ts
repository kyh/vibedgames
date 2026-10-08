import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A relative base keeps built asset URLs relative, so the bundle works wherever it is
// hosted — including {slug}.vibedgames.com after `vg deploy ./dist`.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
});
