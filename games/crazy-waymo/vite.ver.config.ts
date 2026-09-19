import base from "./vite.config";
import { defineConfig } from "vite";

export default defineConfig({ ...base, server: { hmr: false, port: 5293 } });
