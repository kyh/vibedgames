import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      // @mediapipe/pose is a closure-compiled IIFE without ESM exports.
      // @tensorflow-models/pose-detection imports { Pose } for its BlazePose
      // backend, but this app only uses MoveNet. Alias to a stub module.
      "@mediapipe/pose": resolve(__dirname, "src/mediapipe-pose-stub.js"),
    },
  },
  build: {
    rollupOptions: {
      shimMissingExports: true,
    },
  },
});
