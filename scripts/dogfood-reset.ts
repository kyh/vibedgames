#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

console.log("→ unlinking vg CLI");

spawnSync("npm", ["unlink", "-g", "vibedgames"], {
  cwd: path.join(ROOT, "apps/cli"),
  stdio: "inherit",
});

console.log("✓ done.");
