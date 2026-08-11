import base from "./vite.config";
import { defineConfig } from "vite";

export default defineConfig({ ...base, server: { port: 5293, hmr: false } });
